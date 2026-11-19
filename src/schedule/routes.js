/*
 * The weekly schedule: generate a week, move and adjust classes on the day grid, add
 * other blocks such as meetings, and mark classes done, which records their sessions as
 * finished in Batch progress.
 *
 * Clashes (a room or faculty in two places, a week-off, a room too small) are worked out
 * each time a week is read, so they're always current after any change.
 */

import express from 'express';
import { db, tx } from '../db.js';
import { addDays, isIsoDate, isTime, weekdayOf } from '../../public/admin/calendar.js';
import { generateWeek, overlaps, weekStartOf } from './generate.js';
import { weekWorkbook } from './export.js';
import { inputEffects } from '../inputs/effects.js';

export const scheduleRouter = express.Router();

const STATUSES = ['planned', 'done', 'cancelled'];
const ACTIVE = "LOWER(TRIM(status)) = 'active'";

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

const roomList = () => db.prepare('SELECT id, name, capacity FROM rooms').all();
const batchSize = (batchId) => db.prepare(`SELECT COUNT(*) AS n FROM students WHERE batch_id = ? AND ${ACTIVE}`).get(batchId).n;

function slotsOf(batchId) {
  const subs = db.prepare('SELECT faculty_id FROM batch_assignment_substitutes WHERE assignment_id = ? ORDER BY position');
  return db.prepare('SELECT * FROM batch_assignments WHERE batch_id = ? ORDER BY position').all(batchId)
    .map((a) => ({ role: a.role, subject: a.subject, faculty_id: a.faculty_id, substitute_ids: subs.all(a.id).map((s) => s.faculty_id) }));
}

function checkTimes(start, end) {
  if (!isTime(start) || !isTime(end)) throw fail(400, 'Enter a start and end time.');
  if (start >= end) throw fail(400, 'A class must end after it starts.');
}

function checkRoom(roomId) {
  if (roomId && !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) throw fail(404, 'That room no longer exists.');
}

/* ---------- reading a week ---------- */

function loadWeek(weekStart) {
  const [from, to] = [weekStart, addDays(weekStart, 6)];
  const classes = db.prepare(`
    SELECT c.id, c.batch_id, c.date, c.start_time, c.end_time, c.session_id, c.faculty_id, c.status, c.edited, c.note,
           c.flags, c.room_id, c.online,
           b.name AS batch_name, b.mode AS batch_mode, s.position, s.topic_code, s.topic, s.subject, s.area, s.homework,
           f.code AS faculty_code, f.name AS faculty_name, r.name AS room_name, r.capacity AS room_capacity
    FROM schedule_classes c
    JOIN batches b ON b.id = c.batch_id
    LEFT JOIN flow_sessions s ON s.id = c.session_id
    LEFT JOIN faculties f ON f.id = c.faculty_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE c.date BETWEEN ? AND ?
    ORDER BY c.date, c.start_time, b.name`).all(from, to)
    .map((c) => ({ ...c, online: Boolean(c.online), edited: Boolean(c.edited), flags: JSON.parse(c.flags), no: c.position == null ? null : c.position + 1 }));

  const sizes = new Map();
  for (const c of classes) if (!sizes.has(c.batch_id)) sizes.set(c.batch_id, batchSize(c.batch_id));
  for (const c of classes) c.batch_size = sizes.get(c.batch_id);

  const eventFaculty = db.prepare('SELECT faculty_id FROM schedule_event_faculty WHERE event_id = ?');
  const events = db.prepare(`
    SELECT e.*, r.name AS room_name FROM schedule_events e LEFT JOIN rooms r ON r.id = e.room_id
    WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.start_time`).all(from, to)
    .map((e) => ({ ...e, online: Boolean(e.online), faculty_ids: eventFaculty.all(e.id).map((r) => r.faculty_id) }));
  return { classes, events };
}

/** Every clash, week-off and room problem in a week, keyed "class:ID" or "event:ID". */
function findWarnings({ classes, events }) {
  const faculties = new Map(facultyList().map((f) => [f.id, f]));
  const items = [
    ...classes.filter((c) => c.status !== 'cancelled').map((c) => ({
      key: `class:${c.id}`, date: c.date, start_time: c.start_time, end_time: c.end_time,
      room_id: c.online ? null : c.room_id, room_name: c.room_name,
      faculty_ids: c.faculty_id ? [c.faculty_id] : [], label: c.batch_name,
    })),
    ...events.map((e) => ({
      key: `event:${e.id}`, date: e.date, start_time: e.start_time, end_time: e.end_time,
      room_id: e.online ? null : e.room_id, room_name: e.room_name, faculty_ids: e.faculty_ids, label: e.title,
    })),
  ];
  const warnings = new Map(items.map((i) => [i.key, []]));
  const add = (key, text) => { if (!warnings.get(key).includes(text)) warnings.get(key).push(text); };
  const dates = [...classes, ...events].map((x) => x.date).sort();
  const effects = dates.length ? inputEffects(dates[0], dates.at(-1)) : inputEffects('9999-12-31', '0000-01-01');

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (const id of a.faculty_ids) {
      const f = faculties.get(id);
      if (f?.week_offs.includes(weekdayOf(a.date)) && !effects.extraDays.has(`${id}|${a.date}`)) add(a.key, `${f.code} has ${weekdayOf(a.date)} off.`);
      const gone = effects.away.find((x) => x.faculty_id === id && overlaps(x, a));
      if (gone) add(a.key, `${f?.code ?? 'A faculty'} is ${gone.reason}.`);
    }
    const shut = a.room_id && effects.roomsShut.find((x) => x.room_id === a.room_id && overlaps(x, a));
    if (shut) add(a.key, `${shut.room_name} is closed then.`);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (!overlaps(a, b)) continue;
      if (a.room_id && a.room_id === b.room_id) {
        add(a.key, `${a.room_name} is also booked for ${b.label}.`);
        add(b.key, `${b.room_name} is also booked for ${a.label}.`);
      }
      for (const id of a.faculty_ids.filter((x) => b.faculty_ids.includes(x))) {
        const code = faculties.get(id)?.code ?? 'A faculty';
        add(a.key, `${code} is also with ${b.label} then.`);
        add(b.key, `${code} is also with ${a.label} then.`);
      }
    }
  }
  for (const c of classes) {
    if (c.status === 'cancelled') continue;
    const key = `class:${c.id}`;
    const shut = effects.closures.find((x) => (!x.batch_ids || x.batch_ids.includes(c.batch_id)) && overlaps(x, c));
    if (shut) add(key, `${shut.reason}.`);
    if (!c.online && !c.room_id) add(key, 'No room yet.');
    if (!c.online && c.room_capacity != null && c.batch_size > c.room_capacity) {
      add(key, `${c.batch_size} active students, but ${c.room_name} seats ${c.room_capacity}.`);
    }
  }
  return warnings;
}

scheduleRouter.get('/', (req, res) => {
  const weekStart = weekOf(req.query.week);
  const week = loadWeek(weekStart);
  // Clashes are found across every batch, even when only one batch is shown.
  const warnings = findWarnings(week);
  const batchId = req.query.batch ? Number(req.query.batch) : null;
  res.json({
    week: weekStart,
    classes: week.classes.filter((c) => !batchId || c.batch_id === batchId).map((c) => ({ ...c, warnings: warnings.get(`class:${c.id}`) ?? [] })),
    events: batchId ? [] : week.events.map((e) => ({ ...e, warnings: warnings.get(`event:${e.id}`) ?? [] })),
  });
});

// The whole week as one .xlsx file: a tab per day like the Day grid, and a list of every class.
scheduleRouter.get('/export', (req, res) => {
  const weekStart = weekOf(req.query.week);
  const week = loadWeek(weekStart);
  const warnings = findWarnings(week);
  const file = weekWorkbook({
    weekStart,
    classes: week.classes.map((c) => ({ ...c, warnings: warnings.get(`class:${c.id}`) ?? [] })),
    events: week.events.map((e) => ({ ...e, warnings: warnings.get(`event:${e.id}`) ?? [] })),
    rooms: roomList(),
    faculties: facultyList(),
    colourBy: req.query.colour === 'batch' ? 'batch' : 'faculty',
  });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="schedule-week-of-${weekStart}.xlsx"`,
  });
  res.send(file);
});

/* ---------- generating ---------- */

// Replaces the planned classes of the chosen batches for that week. Classes already marked
// done or cancelled stay as they are, and keep their time and room.
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

    const { classes: kept, events } = loadWeek(weekStart);
    const live = kept.filter((c) => c.status !== 'cancelled');
    const bookings = [
      ...live.filter((c) => c.faculty_id).map((c) => ({ ...c, batch_name: c.batch_name })),
      ...events.flatMap((e) => e.faculty_ids.map((faculty_id) => ({ faculty_id, date: e.date, start_time: e.start_time, end_time: e.end_time, batch_name: e.title }))),
    ];
    const effects = inputEffects(weekStart, weekEnd);
    const roomBookings = [...live, ...events, ...effects.roomsShut].filter((x) => x.room_id && !x.online);

    const batches = ready.map(({ batch, flowId, timings }) => {
      const finished = db.prepare('SELECT session_id FROM batch_session_progress WHERE batch_id = ?').all(batch.id).map((r) => r.session_id);
      const plannedElsewhere = db.prepare("SELECT session_id FROM schedule_classes WHERE batch_id = ? AND status <> 'cancelled' AND session_id IS NOT NULL").all(batch.id).map((r) => r.session_id);
      const lastRoom = db.prepare('SELECT room_id FROM schedule_classes WHERE batch_id = ? AND room_id IS NOT NULL ORDER BY date DESC, start_time DESC LIMIT 1').get(batch.id);
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
        size: batchSize(batch.id),
        online: batch.mode === 'online',
        preferred_room_id: lastRoom?.room_id ?? null,
      };
    });

    const closed = [];
    const planned = generateWeek({
      weekStart, batches, faculties: facultyList(), bookings, rooms: roomList(), roomBookings,
      away: effects.away, extraDays: effects.extraDays, closures: effects.closures, closed,
    });
    const insert = db.prepare(`
      INSERT INTO schedule_classes (batch_id, date, start_time, end_time, session_id, faculty_id, room_id, online, status, edited, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?)`);
    for (const c of planned) insert.run(c.batch_id, c.date, c.start_time, c.end_time, c.session_id, c.faculty_id, c.room_id, c.online, JSON.stringify(c.flags));
    return {
      created: planned.length,
      flagged: planned.filter((c) => (c.flags.length && !/^(Covered by|Switched from)/.test(c.flags[0])) || (!c.online && !c.room_id)).length,
      no_room: planned.filter((c) => !c.online && !c.room_id).length,
      replaced: replaced.n ?? 0,
      replaced_edited: replaced.edited ?? 0,
      closed: closed.length,
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
  if ('date' in body) {
    if (!isIsoDate(body.date)) throw fail(400, 'That is not a real date.');
    next.date = body.date;
  }
  if ('start_time' in body) next.start_time = body.start_time;
  if ('end_time' in body) next.end_time = body.end_time;
  checkTimes(next.start_time, next.end_time);
  if ('online' in body) next.online = body.online ? 1 : 0;
  if ('room_id' in body) {
    next.room_id = body.room_id ? Number(body.room_id) : null;
    checkRoom(next.room_id);
  }
  if (next.online) next.room_id = null;
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw fail(400, 'Status must be planned, done or cancelled.');
    next.status = body.status;
  }
  if ('note' in body) next.note = String(body.note ?? '').trim().slice(0, 300) || null;
  if (next.status === 'done' && !next.session_id) throw fail(400, 'Choose the session taught before marking the class done.');

  const fields = ['session_id', 'faculty_id', 'date', 'start_time', 'end_time', 'room_id', 'online'];
  const changedByHand = fields.some((f) => next[f] !== current[f]);
  // The generator's notes explain its choice of faculty; once someone picks by hand they no longer apply.
  const choiceChanged = next.session_id !== current.session_id || next.faculty_id !== current.faculty_id;
  tx(() => {
    if (current.status === 'done' && (next.status !== 'done' || next.session_id !== current.session_id)) {
      unmarkFinished(current.batch_id, current.session_id, current.id);
    }
    if (next.status === 'done') markFinished(current.batch_id, next.session_id);
    db.prepare(`
      UPDATE schedule_classes SET session_id = ?, faculty_id = ?, date = ?, start_time = ?, end_time = ?, room_id = ?, online = ?,
        status = ?, note = ?, edited = ?, flags = ? WHERE id = ?`)
      .run(next.session_id, next.faculty_id, next.date, next.start_time, next.end_time, next.room_id, next.online,
        next.status, next.note, current.edited || changedByHand ? 1 : 0, choiceChanged ? '[]' : current.flags, current.id);
  });
  res.json({ id: current.id });
});

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

/* ---------- other blocks: meetings, workshops ---------- */

function parseEvent(body) {
  const title = String(body?.title ?? '').trim().replace(/\s+/g, ' ');
  if (!title) throw fail(400, 'Give the block a title.');
  if (title.length > 120) throw fail(400, 'The title must be 120 characters or fewer.');
  if (!isIsoDate(body.date)) throw fail(400, 'That is not a real date.');
  checkTimes(body.start_time, body.end_time);
  const online = body.online ? 1 : 0;
  const roomId = online || !body.room_id ? null : Number(body.room_id);
  checkRoom(roomId);
  const facultyIds = [...new Set((Array.isArray(body.faculty_ids) ? body.faculty_ids : []).map(Number))];
  for (const id of facultyIds) if (!db.prepare('SELECT 1 FROM faculties WHERE id = ?').get(id)) throw fail(404, 'A chosen faculty no longer exists.');
  return { title, date: body.date, start_time: body.start_time, end_time: body.end_time, room_id: roomId, online, facultyIds };
}

function writeEventFaculty(eventId, facultyIds) {
  db.prepare('DELETE FROM schedule_event_faculty WHERE event_id = ?').run(eventId);
  const insert = db.prepare('INSERT INTO schedule_event_faculty (event_id, faculty_id) VALUES (?, ?)');
  facultyIds.forEach((id) => insert.run(eventId, id));
}

scheduleRouter.post('/events', (req, res) => {
  const e = parseEvent(req.body);
  const id = tx(() => {
    const eventId = Number(db.prepare('INSERT INTO schedule_events (date, start_time, end_time, title, room_id, online) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.date, e.start_time, e.end_time, e.title, e.room_id, e.online).lastInsertRowid);
    writeEventFaculty(eventId, e.facultyIds);
    return eventId;
  });
  res.status(201).json({ id });
});

scheduleRouter.put('/events/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(Number(req.params.id));
  if (!current) throw fail(404, 'That block no longer exists. Reload the week.');
  const merged = { ...current, online: Boolean(current.online), ...req.body };
  if (!('faculty_ids' in req.body)) merged.faculty_ids = db.prepare('SELECT faculty_id FROM schedule_event_faculty WHERE event_id = ?').all(current.id).map((r) => r.faculty_id);
  const e = parseEvent(merged);
  tx(() => {
    db.prepare('UPDATE schedule_events SET date = ?, start_time = ?, end_time = ?, title = ?, room_id = ?, online = ? WHERE id = ?')
      .run(e.date, e.start_time, e.end_time, e.title, e.room_id, e.online, current.id);
    writeEventFaculty(current.id, e.facultyIds);
  });
  res.json({ id: current.id });
});

scheduleRouter.delete('/events/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM schedule_events WHERE id = ?').run(Number(req.params.id));
  if (!changes) throw fail(404, 'That block no longer exists.');
  res.status(204).end();
});
