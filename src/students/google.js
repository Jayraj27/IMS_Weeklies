/*
 * Google access as the service account: read-only for the sheets, and, for the faculty
 * calendars, write access to the calendars it owns. Each use asks only for its own scope.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeHeader } from './parse.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const TIMEOUT_MS = 120_000;

const apiBase = () => process.env.GOOGLE_SHEETS_API_BASE || 'https://sheets.googleapis.com';

export class SheetAccessError extends Error {}

/** Accepts either the sheet's ID or its full link. */
export function sheetIdFrom(value) {
  const text = String(value ?? '').trim();
  return /\/spreadsheets\/d\/([\w-]+)/.exec(text)?.[1] ?? text;
}

export function keyFilePath() {
  const configured = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  return configured ? path.resolve(root, configured) : null;
}

export function readServiceAccount() {
  // Online, the key is a secret setting on the host; on this computer, a file.
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = keyFilePath();
  if (!inline && (!file || !fs.existsSync(file))) return null;
  let key;
  try {
    key = JSON.parse(inline || fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SheetAccessError('The service account key is not valid JSON. Download it from Google Cloud again.');
  }
  if (!key.client_email || !key.private_key) {
    throw new SheetAccessError('The key file has no client_email or private_key. It should be a service account JSON key.');
  }
  return key;
}

/* ---------- sign-in ---------- */

const cachedTokens = new Map(); // scope -> { email, token, expiresAt }

export async function accessToken(key, scope = SCOPE) {
  const cachedToken = cachedTokens.get(scope);
  if (cachedToken && cachedToken.email === key.client_email && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new SheetAccessError(`Google refused the service account sign-in (${res.status}). The key may have been deleted or disabled.`);
  }
  const data = await res.json();
  cachedTokens.set(scope, { email: key.client_email, token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

/* ---------- reading ---------- */

async function getJson(url, key) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await accessToken(key)}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return res.json();
  if (res.status === 403) {
    throw new SheetAccessError(`No access to the sheet. Ask its owner to share it as Viewer with ${key.client_email}. If it is already shared, check that the Google Sheets API is enabled for this Cloud project.`);
  }
  if (res.status === 404) throw new SheetAccessError('Sheet not found. Check the sheet ID in the settings (.env).');
  if (res.status === 429) throw new SheetAccessError('Google is limiting requests right now. The next sync will try again.');
  throw new SheetAccessError(`Google Sheets returned an error (${res.status}).`);
}

const quoteTab = (title) => `'${title.replace(/'/g, "''")}'`;

/**
 * Uses the wanted tab, otherwise the one tab whose first rows look right.
 * looksRight(row) checks one row of text cells; what names the headings in error messages.
 */
async function chooseTab(sheetId, key, { wanted, looksRight, what, tabSetting }) {
  const base = `${apiBase()}/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  const meta = await getJson(`${base}?fields=sheets.properties(title,sheetType)`, key);
  const titles = (meta.sheets ?? [])
    .filter((s) => (s.properties.sheetType ?? 'GRID') === 'GRID')
    .map((s) => s.properties.title);

  if (wanted) {
    if (!titles.includes(wanted)) {
      throw new SheetAccessError(`The sheet has no tab named "${wanted}". Its tabs are: ${titles.join(', ')}.`);
    }
    return wanted;
  }

  const params = new URLSearchParams();
  for (const title of titles) params.append('ranges', `${quoteTab(title)}!A1:BZ10`);
  const { valueRanges = [] } = await getJson(`${base}/values:batchGet?${params}`, key);
  const matches = titles.filter((_, i) => (valueRanges[i]?.values ?? []).some((row) => looksRight(row)));

  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new SheetAccessError(`No tab has ${what}. Tabs found: ${titles.join(', ')}.${tabSetting ? ` Set ${tabSetting} if the heading is lower down.` : ''}`);
  }
  throw new SheetAccessError(`More than one tab has ${what}: ${matches.join(', ')}.${tabSetting ? ` Set ${tabSetting} to choose one.` : ''}`);
}

/**
 * Returns a tab's cells. Displayed text and stored numbers come back in one request,
 * so they can't disagree if someone edits the sheet mid-read. A date or time cell's
 * number is its spreadsheet serial, which is never ambiguous the way "5/11" is.
 */
export async function fetchGrid({ sheetId, wanted, looksRight, what, tabSetting }) {
  const key = readServiceAccount();
  if (!sheetId || !key) throw new SheetAccessError('The sheet connection is not set up yet.');

  const tab = await chooseTab(sheetId, key, { wanted, looksRight, what, tabSetting });
  const params = new URLSearchParams({
    ranges: quoteTab(tab),
    includeGridData: 'true',
    fields: 'sheets(properties.title,data.rowData.values(formattedValue,effectiveValue.numberValue))',
  });
  const data = await getJson(`${apiBase()}/v4/spreadsheets/${encodeURIComponent(sheetId)}?${params}`, key);
  const sheet = data.sheets?.find((s) => s.properties?.title === tab);
  if (!sheet) throw new SheetAccessError(`Google did not return the tab "${tab}".`);
  const rowData = sheet.data?.[0]?.rowData ?? [];
  const grid = rowData.map((row) =>
    (row.values ?? []).map((cell) => ({
      text: cell.formattedValue ?? '',
      number: cell.effectiveValue?.numberValue,
    })),
  );
  return { tab, grid };
}

export function fetchStudentGrid() {
  return fetchGrid({
    sheetId: sheetIdFrom(process.env.GOOGLE_SHEET_ID),
    wanted: process.env.GOOGLE_SHEET_TAB?.trim(),
    looksRight: looksLikeHeader,
    what: 'an "IMS ID" heading',
    tabSetting: 'GOOGLE_SHEET_TAB',
  });
}
