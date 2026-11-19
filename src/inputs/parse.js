/*
 * Reads the Google Form's response sheet into entries, and checks an entry against the
 * faculties, batches and rooms in the program. No database here, so it can be tested
 * directly.
 */

import crypto from 'node:crypto';
import { addDays, isIsoDate, isTime, parseDateText } from '../../public/admin/calendar.js';
import { parseClock } from '../../public/admin/course-sheet.js';
import { INPUT_KINDS, kindFromText, kindInfo, monthOf, parseMonth } from '../../public/admin/input-kinds.js';

const FIELDS = {
  timestamp: ['timestamp'],
  faculty_code: ['facultycode', 'yourfacultycode', 'code'],
  month: ['month', 'whichmonth'],
  kind: ['whatisit', 'type', 'kind'],
  from_date: ['fromdate', 'date'],
  to_date: ['todate', 'tilldate', 'untildate'],
  from_time: ['fromtime', 'starttime'],
  to_time: ['totime', 'endtime'],
  batch_codes: ['batchcodes', 'batchcode', 'batches', 'batch'],
  others: ['otherfaculty', 'otherfacultyinvolved', 'otherfacultycodes', 'withfaculty'],
  details: ['details', 'detail', 'notes', 'note', 'reason'],
};

const keyOf = (text) => String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');

function fieldOf(heading) {
  const key = keyOf(heading);
  if (!key) return null;
  for (const [field, names] of Object.entries(FIELDS)) if (names.includes(key)) return field;
  // Allows a question's wording to grow, such as "Batch codes (for batch items)".
  for (const [field, names] of Object.entries(FIELDS)) if (names.some((n) => n.length > 4 && key.startsWith(n))) return field;
  return null;
}

/**
 * A heading's field and item. The form asks for up to six items in one response, titled
 * "Item 2: What is it?" and so on; a heading without "Item n:" belongs to item 1.
 */
function columnOf(heading) {
  const text = String(heading ?? '').trim();
  const numbered = /^item\s*(\d{1,2})\s*[:.\-–)]?\s*(.*)$/i.exec(text);
  const field = fieldOf(numbered ? numbered[2] : text);
  return field ? { field, item: numbered ? Number(numbered[1]) : 1 } : null;
}

const SHARED = ['timestamp', 'faculty_code', 'month'];

/** A row of text cells that is the response sheet's heading row. */
export function looksLikeInputHeader(row) {
  const fields = row.map((c) => columnOf(typeof c === 'object' ? c.text : c)?.field);
  return fields.includes('faculty_code') && fields.includes('kind');
}

/* ---------- cell values ---------- */

const EPOCH = '1899-12-30'; // day 0 of a spreadsheet date serial

function serialDate(number) {
  return addDays(EPOCH, Math.floor(number));
}

function serialTime(number) {
  const minutes = Math.round((number - Math.floor(number)) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A date cell: its serial when Google gives one, otherwise the text, read day first. */
export function cellDate(cell) {
  if (Number.isFinite(cell?.number) && cell.number > 1) return serialDate(cell.number);
  const text = String(cell?.text ?? '').trim();
  if (!text) return null;
  return parseDateText(text.split(/\s+/)[0]) ?? parseDateText(text) ?? 'bad';
}

export function cellTime(cell) {
  if (Number.isFinite(cell?.number)) return serialTime(cell.number);
  const text = String(cell?.text ?? '').trim().replace(/:00(\s*[ap]\.?m\.?)?$/i, '$1');
  if (!text) return null;
  const read = parseClock(text);
  return read.time ?? 'bad';
}

function cellTimestamp(cell) {
  if (Number.isFinite(cell?.number) && cell.number > 1) return `${serialDate(cell.number)}T${serialTime(cell.number)}`;
  const text = String(cell?.text ?? '').trim();
  return text || null;
}

/* ---------- reading the sheet ---------- */

/**
 * grid: rows of { text, number } cells, as fetchGrid returns. Returns entries ready to
 * store, without checking codes; problems found in the cells themselves are included.
 */
export function readResponses(grid) {
  const headerIndex = grid.findIndex((row) => looksLikeInputHeader(row));
  if (headerIndex < 0) return { entries: [], error: 'The response sheet has no "Faculty Code" and "What is it?" headings.' };
  const columns = grid[headerIndex].map((c) => columnOf(c.text));
  const items = [...new Set(columns.filter((c) => c && !SHARED.includes(c.field)).map((c) => c.item))].sort((a, b) => a - b);
  const entries = [];
  const seen = new Map();

  grid.slice(headerIndex + 1).forEach((row, offset) => {
    if (!row.some((c) => String(c?.text ?? '').trim())) return;
    const indexOf = (field, item) => columns.findIndex((c) => c && c.field === field && (SHARED.includes(field) || c.item === item));
    const cell = (field, item = 1) => row[indexOf(field, item)] ?? {};
    const has = (field, item = 1) => indexOf(field, item) >= 0;
    const text = (field, item = 1) => (has(field, item) ? String(cell(field, item).text ?? '').trim() : '');

    const shared = {
      source: 'form',
      sheet_row: headerIndex + offset + 2,
      submitted_at: cellTimestamp(cell('timestamp')),
      faculty_code: text('faculty_code').split(/\s+[-–]\s+/)[0].trim(), // "AB – Name" in a dropdown reads as AB
      month_text: text('month'),
    };

    for (const item of items) {
      const own = columns.map((c, i) => (c && c.item === item && !SHARED.includes(c.field) ? i : -1)).filter((i) => i >= 0);
      // Items after the first are only there if the faculty chose to add them.
      if (item > 1 && !own.some((i) => String(row[i]?.text ?? '').trim())) continue;
      const kindText = text('kind', item);
      const entry = {
        ...shared,
        item,
        kind: kindFromText(kindText),
        kind_text: kindText,
        from_date: has('from_date', item) ? cellDate(cell('from_date', item)) : null,
        to_date: has('to_date', item) ? cellDate(cell('to_date', item)) : null,
        from_time: has('from_time', item) ? cellTime(cell('from_time', item)) : null,
        to_time: has('to_time', item) ? cellTime(cell('to_time', item)) : null,
        batch_codes: text('batch_codes', item),
        others: text('others', item),
        details: text('details', item).slice(0, 2000),
        room_id: null,
      };
      entry.month = parseMonth(entry.month_text)
        ?? (isIsoDate(entry.from_date) ? monthOf(entry.from_date) : null)
        ?? (entry.submitted_at && /^\d{4}-\d{2}/.test(entry.submitted_at) ? entry.submitted_at.slice(0, 7) : null);

      const answers = [entry.submitted_at, entry.faculty_code, entry.month, kindText, entry.from_date, entry.to_date, entry.from_time, entry.to_time, entry.batch_codes, entry.others, entry.details];
      if (item > 1) answers.push(item);
      const hash = crypto.createHash('sha256').update(JSON.stringify(answers)).digest('hex').slice(0, 24);
      const n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      entry.entry_key = `form:${hash}${n > 1 ? `#${n}` : ''}`;
      entries.push(entry);
    }
  });
  return { entries, error: null };
}

/* ---------- checking ---------- */

export const splitCodes = (text) => String(text ?? '').split(/[\s,;+&/]+|\band\b/i).map((c) => c.trim()).filter(Boolean);
const normalizeBatch = (code) => code.toLowerCase().replace(/\s+/g, '');

/**
 * Checks one entry. lookups: { faculties: Map lower code -> { id, code },
 * batches: Map normalised code -> { id, name }, rooms: Map id -> { id, name } }.
 * Returns { faculty_id, problems }. An entry with problems can't be approved.
 */
export function checkEntry(entry, { faculties, batches, rooms }) {
  const problems = [];
  const info = kindInfo(entry.kind);
  if (!info) {
    const answer = entry.kind_text ?? (String(entry.kind ?? '').startsWith('unknown:') ? entry.kind.slice(8) : '');
    problems.push(answer ? `"${answer}" is not one of the form’s choices.` : 'What it is was left empty.');
  }

  let facultyId = entry.faculty_id ?? null;
  if (entry.faculty_code) {
    const f = faculties.get(entry.faculty_code.toLowerCase());
    if (f) facultyId = f.id;
    else problems.push(`No faculty has the code "${entry.faculty_code}".`);
  } else if (entry.source === 'form' || ['leave', 'partial', 'extra'].includes(entry.kind)) {
    problems.push('The faculty code is missing.');
  }

  if (!entry.month) problems.push('The month is missing.');
  const needs = info?.needs ?? [];

  if (entry.from_date === 'bad' || entry.to_date === 'bad') problems.push('A date can’t be read.');
  else {
    if (needs.includes('dates') && !entry.from_date) problems.push('The From date is missing.');
    if (!entry.from_date && entry.to_date) problems.push('There is a To date but no From date.');
    if (entry.from_date && entry.to_date) {
      if (entry.to_date < entry.from_date) problems.push('The To date is before the From date.');
      else if (addDays(entry.from_date, 62) < entry.to_date) problems.push('The dates span more than two months.');
    }
  }

  if (entry.from_time === 'bad' || entry.to_time === 'bad') problems.push('A time can’t be read.');
  else {
    if (needs.includes('times') && (!entry.from_time || !entry.to_time)) problems.push('Give both a From time and a To time.');
    else if (Boolean(entry.from_time) !== Boolean(entry.to_time)) problems.push('Give both a From time and a To time, or neither.');
    if (isTime(entry.from_time) && isTime(entry.to_time) && entry.from_time >= entry.to_time) problems.push('The To time must be after the From time.');
  }

  const batchCodes = splitCodes(entry.batch_codes);
  if (needs.includes('batches') && !batchCodes.length) problems.push('Name the batch codes.');
  const unknownBatches = batchCodes.filter((c) => !batches.has(normalizeBatch(c)));
  if (unknownBatches.length) problems.push(`No batch has the code ${unknownBatches.map((c) => `"${c}"`).join(', ')}.`);

  const unknownOthers = splitCodes(entry.others).filter((c) => !faculties.has(c.toLowerCase()));
  if (unknownOthers.length) problems.push(`No faculty has the code ${unknownOthers.map((c) => `"${c}"`).join(', ')} (other faculty).`);

  if (needs.includes('room') && !(entry.room_id && rooms.has(entry.room_id))) problems.push('Choose the room.');

  return { faculty_id: facultyId, problems };
}

export const batchIdsOf = (entry, batches) => splitCodes(entry.batch_codes).map((c) => batches.get(normalizeBatch(c))?.id).filter(Boolean);
export const otherFacultyIds = (entry, faculties) => splitCodes(entry.others).map((c) => faculties.get(c.toLowerCase())?.id).filter(Boolean);

/** Every date an entry covers. */
export function datesOf(entry) {
  if (!isIsoDate(entry.from_date)) return [];
  const last = isIsoDate(entry.to_date) ? entry.to_date : entry.from_date;
  const dates = [];
  for (let d = entry.from_date; d <= last && dates.length < 63; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export { INPUT_KINDS };
