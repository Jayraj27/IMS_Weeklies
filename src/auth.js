/*
 * Sign-in for the admin. Passwords are stored only as salted scrypt hashes, and a session
 * cookie holds a random token whose hash is what the database keeps, so a copy of the
 * database can't be used to sign in.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { db } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'weeklies_session';
const SESSION_DAYS = 7;
const MIN_PASSWORD = 10;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const isProduction = () => process.env.NODE_ENV === 'production';

/* ---------- passwords ---------- */

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function passwordMatches(password, stored) {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `The password must be at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'The password must be 200 characters or fewer.';
  return null;
}

/** Creates or resets an admin, and signs them out everywhere. */
export async function setAdminPassword(username, password) {
  const hash = await hashPassword(password);
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  }
}

/**
 * The first admin. Online, a password must be supplied, so the app never starts open or
 * with a password sitting in its logs. On this computer, one is generated and shown once.
 */
export async function ensureFirstAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n) return;
  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (password) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
    await setAdminPassword(username, password);
    return;
  }
  if (isProduction()) throw new Error('Set ADMIN_PASSWORD to create the first admin. The app will not start without one.');
  password = crypto.randomBytes(12).toString('base64url');
  await setAdminPassword(username, password);
  console.log(`\nFirst admin created. Sign in with:\n  Username: ${username}\n  Password: ${password}\nThis is shown only once. Change it under "Change password".\n`);
}

/* ---------- sessions ---------- */

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function tokenFrom(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
  return null;
}

function currentAdmin(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.id, a.username, a.password_hash FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), new Date().toISOString());
  return row ?? null;
}

function setCookie(res, value, maxAgeSeconds) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function startSession(res, adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), adminId, expires);
  setCookie(res, token, SESSION_DAYS * 86_400);
}

/* ---------- guards ---------- */

export function requireApi(req, res, next) {
  if (currentAdmin(req)) return next();
  res.status(401).json({ error: 'Please sign in.' });
}

export function requirePage(req, res, next) {
  if (currentAdmin(req)) return next();
  res.redirect('/login/');
}

export function redirectIfSignedIn(req, res, next) {
  if (currentAdmin(req)) return res.redirect('/admin/');
  next();
}

/** Another website can't make a signed-in browser change anything here. */
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // An unreadable origin is treated as a different site.
  }
  if (originHost !== host) return res.status(403).json({ error: 'Request refused.' });
  next();
}

/* ---------- too many wrong passwords ---------- */

const failures = new Map();

function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const entry = failures.get(ip);
  if (entry && Date.now() - entry.first <= FAILURE_WINDOW_MS) entry.count += 1;
  else failures.set(ip, { first: Date.now(), count: 1 });
  // A long-running server shouldn't collect addresses forever.
  if (failures.size > 10_000) failures.clear();
}

/* ---------- routes ---------- */

export const authRouter = express.Router();
authRouter.use(express.json({ limit: '10kb' }));

// Same work whether or not the username exists, so timing doesn't reveal which do.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

authRouter.post('/login', async (req, res) => {
  if (tooManyFailures(req.ip)) {
    return res.status(429).json({ error: 'Too many wrong attempts. Please try again in 15 minutes.' });
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const matched = await passwordMatches(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !matched) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'That username and password don’t match.' });
  }
  failures.delete(req.ip);
  startSession(res, admin.id);
  res.json({ username: admin.username });
});

authRouter.post('/logout', (req, res) => {
  const token = tokenFrom(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  setCookie(res, '', 0);
  res.status(204).end();
});

authRouter.get('/me', requireApi, (req, res) => {
  res.json({ username: currentAdmin(req).username });
});

// Signs out every other device, in case the old password was the reason for changing it.
authRouter.post('/password', requireApi, async (req, res) => {
  const admin = currentAdmin(req);
  if (tooManyFailures(req.ip)) {
    return res.status(429).json({ error: 'Too many wrong attempts. Please try again in 15 minutes.' });
  }
  const current = typeof req.body?.current === 'string' ? req.body.current.slice(0, 200) : '';
  if (!(await passwordMatches(current, admin.password_hash))) {
    recordFailure(req.ip);
    return res.status(400).json({ error: 'The current password is not right.' });
  }
  const problem = passwordProblem(req.body?.next);
  if (problem) return res.status(400).json({ error: problem });
  await setAdminPassword(admin.username, req.body.next);
  startSession(res, admin.id);
  res.status(204).end();
});
