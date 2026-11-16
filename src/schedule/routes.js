/*
 * The weekly schedule: generate a week, adjust single classes, and mark classes done,
 * which records their sessions as finished in Batch progress.
 */

import express from 'express';
import { db, tx } from '../db.js';
import { addDays, isIsoDate, weekdayOf } from '../../public/admin/calendar.js';
import { generateWeek, overlaps, weekStartOf } from './generate.js';

export const scheduleRouter = express.Router();

const STATUSES = ['planned', 'done', 'cancelled'];

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function weekOf(value) {
  const text = String(value ?? '').trim();
  if (!isIsoDate(text)) throw fail(400, 'Choose a week by one of its dates, as YYYY-MM-DD.');
  return weekStartOf(text);
}

function findBatch(id) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(Number(id));
  if (!batch) throw fail(404, 'That batch no longer exists.');
  return batch;
}

/** A batch follows its group flow if it has one, otherwise its course-wide flow. */
function flowIdOf(batch) {
  const group = db.prepare('SELECT flow_id FROM flow_batches WHERE batch_id = ?').get(batch.id);
  if (group) return group.flow_id;
  return db.prepare("SELECT id FROM flows WHERE course_id = ? AND scope = 'course'").get(batch.course_id)?.id ?? null;
}

function facultyList() {
  const offs = new Map();
  for (const row of db.prepare('SELECT faculty_id, day FROM faculty_week_offs').all()) {
    if (!offs.has(row.faculty_id)) offs.set(row.faculty_id, []);
    offs.get(row.faculty_id).push(row.day);
  }
  return db.prepare('SELECT id, code, name FROM faculties').all().map((f) => ({ ...f, week_offs: offs.get(f.id) ?? [] }));
}

function slotsOf(batchId) {
  const subs = db.prepare('SELECT faculty_id FROM batch_assignment_substitutes WHERE assignment_id = ? ORDER BY position');
  return db.prepare('SELECT * FROM batch_assignments WHERE batch_id = ? ORDER BY position').all(batchId)
    .map((a) => ({ role: a.role, subject: a.subject, faculty_id: a.faculty_id, substitute_ids: subs.all(a.id).map((s) => s.faculty_id) }));
}

const classesInWeek = (weekStart) =>
  db.prepare(`
    SELECT c.*, b.name AS batch_name FROM schedule_classes c JOIN batches b ON b.id = c.batch_id
    WHERE c.date BETWEEN ? AND ?`).all(weekStart, addDays(weekStart, 6));

/** Warnings for a class whose faculty was chosen by hand. */
function checkFaculty({ id, faculty_id: facultyId, date, start_time, end_time }) {
  if (!facultyId) return [];
  const faculty = facultyList().find((f) => f.id === facultyId);
  const flags = [];
  if (faculty.week_offs.includes(weekdayOf(date))) flags.push(`${faculty.code} has ${weekdayOf(date)} off.`);
  const clash = classesInWeek(weekStartOf(date)).find((c) => c.id !== id && c.status !== 'cancelled' && c.faculty_id === facultyId && overlaps(c, { date, start_time, end_time }));
  if (clash) flags.push(`${faculty.code} is also teaching ${clash.batch_name} at this time.`);
  return flags;
}

function markFinished(batchId, sessionId) {
  if (!sessionId) return;
  db.prepare('INSERT OR IGNORE INTO batch_session_progress (batch_id, session_id, marked_at) VALUES (?, ?, ?)')
    .run(batchId, sessionId, new Date().toISOString());
}

/** Only unmarks a session if no other done class of the batch taught it. */
function unmarkFinished(batchId, sessionId, exceptClassId) {
  if (!sessionId) return;
  const other = db.prepare("SELECT 1 FROM schedule_classes WHERE batch_id = ? AND session_id = ? AND status = 'done' AND id <> ?")
    .get(batchId, sessionId, exceptClassId);
  if (!other) db.prepare('DELETE FROM batch_session_progress WHERE batch_id = ? AND session_id = ?').run(batchId, sessionId);
}

/* ---------- reading a week ---------- */

scheduleRouter.get('/', (req, res) => {
  const weekStart = weekOf(req.query.week);
  const params = [weekStart, addDays(weekStart, 6)];
  let filter = '';
  if (req.query.batch) {
    filter = 'AND c.batch_id = ?';
    params.push(Number(req.query.batch));
  }
  const classes = db.prepare(`
    SELECT c.id, c.batch_id, c.date, c.start_time, c.end_time, c.session_id, c.faculty_id, c.status, c.edited, c.note, c.flags,
           b.name AS batch_name, s.position, s.topic_code, s.topic, s.subject, s.area, s.homework,
           f.code AS faculty_code, f.name AS faculty_name
    FROM schedule_classes c
    JOIN batches b ON b.id = c.batch_id
    LEFT JOIN flow_sessions s ON s.id = c.session_id
    LEFT JOIN faculties f ON f.id = c.faculty_id
    WHERE c.date BETWEEN ? AND ? ${filter}
    ORDER BY c.date, c.start_time, b.name`).all(...params)
    .map((c) => ({ ...c, edited: Boolean(c.edited), flags: JSON.parse(c.flags), no: c.position == null ? null : c.position + 1 }));
  res.json({ week: weekStart, classes });
});

/* ---------- generating ---------- */

// Replaces the planned classes of the chosen batches for that week. Classes already marked
// done or cancelled stay as they are, and keep their time.
scheduleRouter.post('/generate', (req, res) => {
  const weekStart = weekOf(req.body?.week);
  const weekEnd = addDays(weekStart, 6);
  const targets = req.body?.batch_id
    ? [findBatch(req.body.batch_id)]
    : db.prepare('SELECT * FROM batches WHERE id IN (SELECT DISTINCT batch_id FROM batch_timings) ORDER BY name').all();

  const skipped = [];
  const ready = [];
  for (const batch of targets) {
    const flowId = flowIdOf(batch);
    const timings = db.prepare('SELECT weekday, start_time, end_time FROM batch_timings WHERE batch_id = ?').all(batch.id);
    if (!timings.length) skipped.push({ batch: batch.name, reason: 'It has no class times. Add them on the Batches page.' });
    else if (!flowId) skipped.push({ batch: batch.name, reason: 'It has no master flow. Map it to one under Master flows.' });
    else ready.push({ batch, flowId, timings });
  }

  const result = tx(() => {
    const ids = ready.map((r) => r.batch.id);
    const placeholders = ids.map(() => '?').join(',') || 'NULL';
    const replaced = db.prepare(`SELECT COUNT(*) AS n, SUM(edited) AS edited FROM schedule_classes WHERE status = 'planned' AND date BETWEEN ? AND ? AND batch_id IN (${placeholders})`)
      .get(weekStart, weekEnd, ...ids);
    db.prepare(`DELETE FROM schedule_classes WHERE status = 'planned' AND date BETWEEN ? AND ? AND batch_id IN (${placeholders})`)
      .run(weekStart, weekEnd, ...ids);

    const bookings = classesInWeek(weekStart).filter((c) => c.status !== 'cancelled' && c.faculty_id);
    const batches = ready.map(({ batch, flowId, timings }) => {
      const finished = db.prepare('SELECT session_id FROM batch_session_progress WHERE batch_id = ?').all(batch.id).map((r) => r.session_id);
      const plannedElsewhere = db.prepare("SELECT session_id FROM schedule_classes WHERE batch_id = ? AND status <> 'cancelled' AND session_id IS NOT NULL").all(batch.id).map((r) => r.session_id);
      return {
        id: batch.id,
        name: batch.name,
        timings,
        start_date: batch.start_date,
        end_date: batch.end_date,
        slots: slotsOf(batch.id),
        sessions: db.prepare('SELECT id, subject FROM flow_sessions WHERE flow_id = ? ORDER BY position').all(flowId),
        unavailable: new Set([...finished, ...plannedElsewhere]),
        occupied: db.prepare('SELECT date, start_time FROM schedule_classes WHERE batch_id = ? AND date BETWEEN ? AND ?').all(batch.id, weekStart, weekEnd),
      };
    });

    const planned = generateWeek({ weekStart, batches, faculties: facultyList(), bookings });
    const insert = db.prepare(`
      INSERT INTO schedule_classes (batch_id, date, start_time, end_time, session_id, faculty_id, status, edited, flags)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', 0, ?)`);
    for (const c of planned) insert.run(c.batch_id, c.date, c.start_time, c.end_time, c.session_id, c.faculty_id, JSON.stringify(c.flags));
    return {
      created: planned.length,
      flagged: planned.filter((c) => c.flags.length && !c.flags[0].startsWith('Covered by')).length,
      replaced: replaced.n ?? 0,
      replaced_edited: replaced.edited ?? 0,
    };
  });
  res.json({ week: weekStart, ...result, batches: ready.length, skipped });
});

/* ---------- one class ---------- */

scheduleRouter.put('/classes/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM schedule_classes WHERE id = ?').get(Number(req.params.id));
  if (!current) throw fail(404, 'That class no longer exists. Reload the week.');
  const body = req.body ?? {};
  const next = { ...current };

  if ('session_id' in body) {
    const sessionId = body.session_id ? Number(body.session_id) : null;
    if (sessionId) {
      const flowId = flowIdOf(findBatch(current.batch_id));
      const ok = db.prepare('SELECT 1 FROM flow_sessions WHERE id = ? AND flow_id = ?').get(sessionId, flowId);
      if (!ok) throw fail(400, 'That session is not in this batch’s master flow.');
    }
    next.session_id = sessionId;
  }
  if ('faculty_id' in body) {
    const facultyId = body.faculty_id ? Number(body.faculty_id) : null;
    if (facultyId && !db.prepare('SELECT 1 FROM faculties WHERE id = ?').get(facultyId)) throw fail(404, 'That faculty no longer exists.');
    next.faculty_id = facultyId;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw fail(400, 'Status must be planned, done or cancelled.');
    next.status = body.status;
  }
  if ('note' in body) next.note = String(body.note ?? '').trim().slice(0, 300) || null;
  if (next.status === 'done' && !next.session_id) throw fail(400, 'Choose the session taught before marking the class done.');

  const changedByHand = next.session_id !== current.session_id || next.faculty_id !== current.faculty_id;
  tx(() => {
    if (current.status === 'done' && (next.status !== 'done' || next.session_id !== current.session_id)) {
      unmarkFinished(current.batch_id, current.session_id, current.id);
    }
    if (next.status === 'done') markFinished(current.batch_id, next.session_id);
    const flags = changedByHand ? checkFaculty({ ...current, faculty_id: next.faculty_id }) : JSON.parse(current.flags);
    db.prepare('UPDATE schedule_classes SET session_id = ?, faculty_id = ?, status = ?, note = ?, edited = ?, flags = ? WHERE id = ?')
      .run(next.session_id, next.faculty_id, next.status, next.note, current.edited || changedByHand ? 1 : 0, JSON.stringify(flags), current.id);
  });
  res.json({ id: current.id });
});

// Confirms that the week's planned classes happened, so their sessions count as finished.
scheduleRouter.post('/done', (req, res) => {
  const weekStart = weekOf(req.body?.week);
  const params = [weekStart, addDays(weekStart, 6)];
  let filter = '';
  if (req.body?.batch_id) {
    filter = 'AND batch_id = ?';
    params.push(Number(req.body.batch_id));
  }
  const classes = db.prepare(`SELECT * FROM schedule_classes WHERE status = 'planned' AND session_id IS NOT NULL AND date BETWEEN ? AND ? ${filter}`).all(...params);
  tx(() => {
    const update = db.prepare("UPDATE schedule_classes SET status = 'done' WHERE id = ?");
    for (const c of classes) {
      update.run(c.id);
      markFinished(c.batch_id, c.session_id);
    }
  });
  res.json({ done: classes.length });
});
