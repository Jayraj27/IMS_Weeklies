/*
 * Faculty input: what faculty send through the Google Form each month, who hasn't replied
 * yet, and the admin's review. Only approved entries reach the schedule.
 */

import crypto from 'node:crypto';
import express from 'express';
import { db, tx } from '../db.js';
import { isIsoDate, isTime } from '../../public/admin/calendar.js';
import { INPUT_KINDS, kindInfo, parseMonth, spanText } from '../../public/admin/input-kinds.js';
import { checkEntry, datesOf, otherFacultyIds } from './parse.js';
import { dropReview, inputSyncStatus, insertEntry, lookups, runInputSync } from './sync.js';

export const inputsRouter = express.Router();

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function monthParam(value) {
  const month = parseMonth(value);
  if (!month) throw fail(400, 'Choose a month, as YYYY-MM.');
  return month;
}

/** In plain words, what approving an entry does to the schedule. */
function effectOf(e, statusOfEntry) {
  const hours = e.from_time && e.to_time ? spanText(e.from_time, e.to_time) : null;
  switch (e.kind) {
    case 'leave': return hours ? `No classes for ${e.faculty_code} ${hours} on these days.` : `No classes for ${e.faculty_code} on these days. A substitute, or another subject, takes them.`;
    case 'partial': return `No classes for ${e.faculty_code} ${hours ?? ''} on these days.`;
    case 'extra': return `${e.faculty_code} can be given classes on these days, even on their usual day off.`;
    case 'event':
      if (e.from_date && hours) return statusOfEntry === 'approved' ? 'On the schedule as a block.' : 'Approving puts a block on the schedule for these faculty and times.';
      return 'No date or times, so place it on the day grid by hand.';
    case 'batch_break': return `No classes for ${e.batch_codes} ${hours ? `${hours} ` : ''}on these days.`;
    case 'request': return 'Arrange by hand: add or change the batch’s classes on the day grid.';
    case 'closure': return `No classes for any batch ${hours ? `${hours} ` : ''}on these days.`;
    case 'room': return `${e.room_name ?? 'The room'} isn’t used ${hours ? `${hours} ` : ''}on these days.`;
    case 'none': return 'Nothing changes.';
    default: return '';
  }
}

function entriesOf(month) {
  const found = lookups();
  return db.prepare(`
    SELECT e.*, v.status, v.reviewed_at, f.name AS faculty_name, r.name AS room_name
    FROM input_entries e
    LEFT JOIN input_reviews v ON v.entry_key = e.entry_key
    LEFT JOIN faculties f ON f.id = e.faculty_id
    LEFT JOIN rooms r ON r.id = e.room_id
    WHERE e.month = ?
    ORDER BY e.faculty_code COLLATE NOCASE, e.from_date, e.submitted_at`).all(month)
    .map((e) => {
      // Checked again on every read, so a faculty or batch added since the form was read counts.
      const { faculty_id: facultyId, problems } = checkEntry(e, found);
      const status = e.status ?? 'pending';
      return {
        ...e,
        faculty_id: facultyId ?? e.faculty_id,
        status,
        problems,
        label: kindInfo(e.kind)?.label ?? 'Not a form choice',
        effect: effectOf(e, status),
      };
    });
}

inputsRouter.get('/', (req, res) => {
  const month = monthParam(req.query.month);
  const entries = entriesOf(month);
  const replied = new Map();
  for (const e of entries.filter((x) => x.source === 'form' && x.faculty_id)) replied.set(e.faculty_id, (replied.get(e.faculty_id) ?? 0) + 1);
  const teaching = new Set(db.prepare(`
    SELECT faculty_id AS id FROM batch_assignments WHERE faculty_id IS NOT NULL
    UNION SELECT faculty_id FROM batch_assignment_substitutes`).all().map((r) => r.id));
  const faculties = db.prepare('SELECT id, code, name FROM faculties ORDER BY code COLLATE NOCASE').all()
    .map((f) => ({ ...f, replies: replied.get(f.id) ?? 0, teaching: teaching.has(f.id) }));
  res.json({
    month,
    deadline: db.prepare('SELECT deadline FROM input_months WHERE month = ?').get(month)?.deadline ?? null,
    sync: inputSyncStatus(),
    kinds: INPUT_KINDS,
    entries,
    faculties,
  });
});

inputsRouter.put('/months/:month', (req, res) => {
  const month = monthParam(req.params.month);
  const deadline = req.body?.deadline ? String(req.body.deadline) : null;
  if (deadline && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) throw fail(400, 'Give the deadline as a date and time.');
  db.prepare('INSERT INTO input_months (month, deadline) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET deadline = excluded.deadline').run(month, deadline);
  res.json({ month, deadline });
});

inputsRouter.post('/sync', async (_req, res) => {
  const run = await runInputSync();
  res.json({ run, sync: inputSyncStatus() });
});

/* ---------- reviewing ---------- */

function approve(entry) {
  const { problems, faculty_id: facultyId } = checkEntry(entry, lookups());
  if (problems.length) throw fail(400, `This entry can’t be approved yet: ${problems.join(' ')}`);
  const eventIds = [];
  if (entry.kind === 'event' && entry.from_date && entry.from_time && entry.to_time) {
    const found = lookups();
    const facultyIds = [...new Set([facultyId, ...otherFacultyIds(entry, found.faculties)].filter(Boolean))];
    const title = (entry.details.split('\n')[0].trim() || `${entry.faculty_code} commitment`).slice(0, 120);
    const addEvent = db.prepare('INSERT INTO schedule_events (date, start_time, end_time, title, room_id, online) VALUES (?, ?, ?, ?, NULL, 0)');
    const addFaculty = db.prepare('INSERT INTO schedule_event_faculty (event_id, faculty_id) VALUES (?, ?)');
    for (const date of datesOf(entry)) {
      const id = Number(addEvent.run(date, entry.from_time, entry.to_time, title).lastInsertRowid);
      facultyIds.forEach((f) => addFaculty.run(id, f));
      eventIds.push(id);
    }
  }
  db.prepare('INSERT INTO input_reviews (entry_key, status, reviewed_at, event_ids) VALUES (?, ?, ?, ?)')
    .run(entry.entry_key, 'approved', new Date().toISOString(), JSON.stringify(eventIds));
}

function setStatus(entry, status) {
  tx(() => {
    dropReview(entry.entry_key);
    if (status === 'approved') approve(entry);
    else if (status === 'rejected') {
      db.prepare('INSERT INTO input_reviews (entry_key, status, reviewed_at) VALUES (?, ?, ?)').run(entry.entry_key, 'rejected', new Date().toISOString());
    }
  });
}

function findEntry(id) {
  const entry = db.prepare('SELECT * FROM input_entries WHERE id = ?').get(Number(id));
  if (!entry) throw fail(404, 'That entry is gone. The form responses may have been read again; reload the page.');
  return entry;
}

inputsRouter.post('/entries/:id/review', (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) throw fail(400, 'Status must be approved, rejected or pending.');
  setStatus(findEntry(req.params.id), status);
  res.json({ ok: true });
});

// Approves every waiting entry of the month that has no problems.
inputsRouter.post('/approve', (req, res) => {
  const month = monthParam(req.body?.month);
  const waiting = db.prepare(`
    SELECT e.* FROM input_entries e LEFT JOIN input_reviews v ON v.entry_key = e.entry_key
    WHERE e.month = ? AND v.entry_key IS NULL`).all(month);
  const found = lookups();
  const ready = waiting.filter((e) => !checkEntry(e, found).problems.length);
  tx(() => ready.forEach((e) => approve(e)));
  res.json({ approved: ready.length, left: waiting.length - ready.length });
});

/* ---------- entries the admin adds ---------- */

function readEntry(body, month) {
  const kind = String(body?.kind ?? '');
  if (!kindInfo(kind)) throw fail(400, 'Choose what it is.');
  const optional = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const entry = {
    source: 'admin',
    month,
    kind,
    faculty_code: '',
    faculty_id: null,
    from_date: optional(body.from_date),
    to_date: optional(body.to_date),
    from_time: optional(body.from_time),
    to_time: optional(body.to_time),
    batch_codes: String(body.batch_codes ?? '').trim().slice(0, 300),
    others: String(body.others ?? '').trim().slice(0, 300),
    room_id: body.room_id ? Number(body.room_id) : null,
    details: String(body.details ?? '').trim().slice(0, 2000),
  };
  for (const d of [entry.from_date, entry.to_date]) if (d && !isIsoDate(d)) throw fail(400, 'That is not a real date.');
  for (const t of [entry.from_time, entry.to_time]) if (t && !isTime(t)) throw fail(400, 'Give times as HH:MM.');
  if (body.faculty_id) {
    const f = db.prepare('SELECT id, code FROM faculties WHERE id = ?').get(Number(body.faculty_id));
    if (!f) throw fail(404, 'That faculty no longer exists.');
    Object.assign(entry, { faculty_id: f.id, faculty_code: f.code });
  }
  const { problems } = checkEntry(entry, lookups());
  if (problems.length) throw fail(400, problems.join(' '));
  return entry;
}

inputsRouter.post('/entries', (req, res) => {
  const entry = readEntry(req.body, monthParam(req.body?.month));
  entry.entry_key = `admin:${crypto.randomUUID()}`;
  entry.submitted_at = new Date().toISOString().slice(0, 16);
  const id = tx(() => {
    const newId = insertEntry(entry);
    approve(entry); // the admin's own entries count straight away
    return newId;
  });
  res.status(201).json({ id });
});

inputsRouter.delete('/entries/:id', (req, res) => {
  const entry = findEntry(req.params.id);
  if (entry.source !== 'admin') throw fail(400, 'Form answers can’t be deleted here. Reject it instead, or delete the response in the sheet.');
  tx(() => {
    dropReview(entry.entry_key);
    db.prepare('DELETE FROM input_entries WHERE id = ?').run(entry.id);
  });
  res.status(204).end();
});
