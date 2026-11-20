import express from 'express';
import { db, tx } from './db.js';
import { studentsRouter } from './students/routes.js';
import { scheduleRouter } from './schedule/routes.js';
import { reportsRouter } from './reports/routes.js';
import { inputsRouter } from './inputs/routes.js';
import { calendarStatus, requestCalendarSync, runCalendarSync } from './calendar/sync.js';
import { syncStatus } from './students/sync.js';
import { activeStudentCount, linkReport, reconcileStudentLinks } from './students/link.js';
import { normalizeCode, variantKey, yearFromCode } from './students/variants.js';
import { matchSessions } from './flows/match.js';
import { findOverlap, groupTimings, isIsoDate, isTime, formatTime } from '../public/admin/calendar.js';
import { courseSubjects, dayChoiceOf } from '../public/admin/course-sheet.js';
import { MENTOR, buildCourseSheet, readCourseSheet, sheetRows, slotsFor } from './batches/course-sheet.js';

export const api = express.Router();
api.use(express.json({ limit: '5mb' }));
// Any saved change may move a class, a block or a faculty, so faculty calendars are
// brought up to date shortly after. Only real differences are sent to Google.
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.path !== '/calendars/sync') res.on('finish', () => { if (res.statusCode < 400) requestCalendarSync(); });
  next();
});
api.use('/students', studentsRouter);
api.use('/schedule', scheduleRouter);
api.get('/calendars', (_req, res) => res.json(calendarStatus()));
api.post('/calendars/sync', async (_req, res) => {
  const result = await runCalendarSync();
  res.json({ result, status: calendarStatus() });
});
api.use('/reports', reportsRouter);
api.use('/inputs', inputsRouter);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const invalid = (message) => new HttpError(400, message);
const conflict = (message) => new HttpError(409, message);

/* ---------- input checks ---------- */

function text(value, label, { required = true, max = 120 } = {}) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw invalid(`${label} is required.`);
  if (s.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  return s;
}

function whole(value, label, min, max, { required = true } = {}) {
  if (value === '' || value == null) {
    if (required) throw invalid(`${label} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function list(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be a list.`);
  return value;
}

function assertUnique(names, label) {
  const seen = new Set();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) throw invalid(`${label} "${name}" appears more than once.`);
    seen.add(key);
  }
}

function findOr404(table, id, label) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, `That ${label} no longer exists.`);
  return row;
}

// Reuses an existing spelling so "quant" and "Quant" stay one subject everywhere.
const subjectLookup = db.prepare(`
  SELECT subject FROM faculty_subjects WHERE subject = ?1 COLLATE NOCASE
  UNION ALL SELECT subject FROM course_roles WHERE subject = ?1 COLLATE NOCASE
  UNION ALL SELECT subject FROM batch_assignments WHERE subject = ?1 COLLATE NOCASE
  UNION ALL SELECT subject FROM flow_sessions WHERE subject = ?1 COLLATE NOCASE
  LIMIT 1`);

function subjectOf(value, label = 'Subject', opts) {
  const s = text(value, label, { required: false, max: 60, ...opts });
  if (!s) return null;
  return subjectLookup.get(s)?.subject ?? s;
}

/* ---------- reading everything ---------- */

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

/** Areas, plus topic codes that name one session (not repeated ones like "Test"). */
function topicSuggestions(flows) {
  const sessions = flows.flatMap((f) => f.sessions);
  const codeCounts = new Map();
  for (const s of new Set(sessions.map((x) => `${x.topic_code}|${x.topic}`))) {
    const code = s.split('|')[0];
    if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }
  const areas = sessions.map((s) => s.area).filter(Boolean);
  const codes = [...codeCounts].filter(([, n]) => n === 1).map(([code]) => code);
  return [...new Set([...areas, ...codes])].sort(collator.compare);
}

function progressSummary(sessions, finishedIds = new Set()) {
  const nextIndex = sessions.findIndex((s) => !finishedIds.has(s.id));
  const next = sessions[nextIndex];
  return {
    done: sessions.filter((s) => finishedIds.has(s.id)).length,
    total: sessions.length,
    next: next ? { no: nextIndex + 1, topic_code: next.topic_code, topic: next.topic, subject: next.subject } : null,
  };
}

function readState() {
  const all = (sql) => db.prepare(sql).all();

  const roles = groupBy(all('SELECT * FROM course_roles ORDER BY position'), 'course_id');
  const courses = all('SELECT * FROM courses').map((c) => ({
    id: c.id,
    name: c.name,
    roles: (roles.get(c.id) ?? []).map((r) => ({ name: r.name, subject: r.subject })),
  }));
  courses.sort((a, b) => collator.compare(a.name, b.name));

  const fCourses = groupBy(all('SELECT * FROM faculty_courses'), 'faculty_id');
  const fSubjects = groupBy(all('SELECT * FROM faculty_subjects ORDER BY subject'), 'faculty_id');
  const fOffs = groupBy(all('SELECT * FROM faculty_week_offs'), 'faculty_id');
  const fTopics = groupBy(all('SELECT * FROM faculty_topics ORDER BY topic'), 'faculty_id');
  const faculties = all('SELECT * FROM faculties').map((f) => ({
    ...f,
    course_ids: (fCourses.get(f.id) ?? []).map((x) => x.course_id),
    subjects: (fSubjects.get(f.id) ?? []).map((x) => x.subject),
    topics: (fTopics.get(f.id) ?? []).map((x) => x.topic),
    week_offs: (fOffs.get(f.id) ?? [])
      .map((x) => x.day)
      .sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)),
  }));
  faculties.sort((a, b) => collator.compare(a.name, b.name));

  const flowBatches = groupBy(all('SELECT * FROM flow_batches'), 'flow_id');
  const sessions = groupBy(all('SELECT * FROM flow_sessions ORDER BY position'), 'flow_id');
  const flows = all('SELECT * FROM flows').map((f) => ({
    ...f,
    batch_ids: (flowBatches.get(f.id) ?? []).map((x) => x.batch_id),
    sessions: (sessions.get(f.id) ?? []).map(({ id, subject, topic, topic_code, area, homework }) => ({
      id,
      topic_code,
      topic,
      area,
      subject,
      homework,
    })),
  }));
  flows.sort((a, b) => collator.compare(a.name, b.name));

  const groupFlowOf = new Map();
  const courseFlowOf = new Map();
  for (const flow of flows) {
    if (flow.scope === 'course') courseFlowOf.set(flow.course_id, flow);
    for (const id of flow.batch_ids) groupFlowOf.set(id, flow);
  }

  const finished = new Map();
  for (const { batch_id: batchId, session_id: sessionId } of all('SELECT batch_id, session_id FROM batch_session_progress')) {
    if (!finished.has(batchId)) finished.set(batchId, new Set());
    finished.get(batchId).add(sessionId);
  }
  const flowsById = new Map(flows.map((f) => [f.id, f]));

  const links = linkReport();
  const studentCounts = new Map(links.counts.map((c) => [c.batch_id, c]));
  const variantsOf = new Map(links.batch_variants.map((v) => [v.batch_id, v.variants.split(',')]));
  const substitutes = groupBy(all('SELECT * FROM batch_assignment_substitutes ORDER BY position'), 'assignment_id');
  const timings = groupBy(all('SELECT * FROM batch_timings ORDER BY start_time'), 'batch_id');
  const assignments = groupBy(all('SELECT * FROM batch_assignments ORDER BY position'), 'batch_id');
  const batches = all('SELECT * FROM batches').map((b) => {
    const flow = groupFlowOf.get(b.id) ?? courseFlowOf.get(b.course_id) ?? null;
    return {
      ...b,
      student_count: studentCounts.get(b.id)?.total ?? 0,
      active_students: studentCounts.get(b.id)?.active ?? 0,
      variants: variantsOf.get(b.id) ?? [],
      progress: flow ? progressSummary(flowsById.get(flow.id).sessions, finished.get(b.id)) : null,
      assignments: (assignments.get(b.id) ?? []).map(({ id, role, subject, faculty_id }) => ({
        role,
        subject,
        faculty_id,
        substitute_ids: (substitutes.get(id) ?? []).map((s) => s.faculty_id),
      })),
      timings: (timings.get(b.id) ?? []).map(({ weekday, start_time, end_time }) => ({ weekday, start_time, end_time })),
      flow: flow && { id: flow.id, name: flow.name, scope: flow.scope },
    };
  });
  batches.sort((a, b) => b.year - a.year || collator.compare(a.name, b.name));

  const rooms = all('SELECT * FROM rooms');
  rooms.sort((a, b) => collator.compare(a.name, b.name));

  const subjects = all(`
    SELECT subject FROM faculty_subjects
    UNION SELECT subject FROM course_roles WHERE subject IS NOT NULL
    UNION SELECT subject FROM batch_assignments WHERE subject IS NOT NULL
    UNION SELECT subject FROM flow_sessions`)
    .map((r) => r.subject)
    .sort(collator.compare);

  // Students aren't included here: there are thousands, so that page loads them in pages.
  const sync = syncStatus();
  return {
    courses,
    faculties,
    batches,
    flows,
    rooms,
    subjects,
    topic_suggestions: topicSuggestions(flows),
    student_count: db.prepare('SELECT COUNT(*) AS n FROM students').get().n,
    variants: links.variants,
    variant_map: db.prepare('SELECT variant, course_id FROM variant_courses ORDER BY variant COLLATE NOCASE').all(),
    batches_waiting: links.waiting,
    batches_mismatched: links.mismatched,
    student_sync: {
      configured: sync.configured,
      last_ok: sync.last_run ? sync.last_run.ok : null,
      last_error: sync.last_run?.error ?? null,
      last_success_at: sync.last_success?.finished_at ?? null,
    },
  };
}

api.get('/state', (_req, res) => res.json(readState()));

/* ---------- courses ---------- */

function parseCourse(body) {
  const name = text(body.name, 'Course name', { max: 60 });
  const roles = list(body.roles, 'Faculty slots').map((r) => ({
    name: text(r.name, 'Slot name', { max: 40 }),
    subject: subjectOf(r.subject),
  }));
  assertUnique(roles.map((r) => r.name), 'Slot');
  const variants = body.variants === undefined
    ? undefined
    : list(body.variants, 'Variants').map((v) => text(v, 'Variant', { max: 200 }));
  return { name, roles, variants };
}

/**
 * Makes exactly these variants belong to the course. A ticked variant moves here from any
 * other course; an unticked one that was here is left with no course.
 */
function setCourseVariants(courseId, variants) {
  db.prepare('DELETE FROM variant_courses WHERE course_id = ?').run(courseId);
  const upsert = db.prepare(`
    INSERT INTO variant_courses (variant_key, variant, course_id) VALUES (?, ?, ?)
    ON CONFLICT (variant_key) DO UPDATE SET variant = excluded.variant, course_id = excluded.course_id`);
  for (const v of variants) upsert.run(variantKey(v), v, courseId);
}

// One variant at a time, from the Courses page. course_id null takes it out of any course.
api.put('/variants', (req, res) => {
  const variant = text(req.body.variant, 'Variant', { max: 200 });
  const courseId = req.body.course_id ? Number(req.body.course_id) : null;
  if (courseId) findOr404('courses', courseId, 'course');
  tx(() => {
    if (courseId) {
      db.prepare(`
        INSERT INTO variant_courses (variant_key, variant, course_id) VALUES (?, ?, ?)
        ON CONFLICT (variant_key) DO UPDATE SET variant = excluded.variant, course_id = excluded.course_id`)
        .run(variantKey(variant), variant, courseId);
    } else {
      db.prepare('DELETE FROM variant_courses WHERE variant_key = ?').run(variantKey(variant));
    }
    reconcileStudentLinks();
  });
  res.json({ variant, course_id: courseId });
});

function assertCourseNameFree(name, exceptId = 0) {
  const clash = db.prepare('SELECT id FROM courses WHERE name = ? AND id <> ?').get(name, exceptId);
  if (clash) throw conflict(`A course named "${name}" already exists.`);
}

function writeRoles(courseId, roles) {
  db.prepare('DELETE FROM course_roles WHERE course_id = ?').run(courseId);
  const insert = db.prepare(
    'INSERT INTO course_roles (course_id, position, name, subject) VALUES (?, ?, ?, ?)',
  );
  roles.forEach((r, i) => insert.run(courseId, i, r.name, r.subject));
}

// Adds new slots to a course's existing batches. It never removes one, because
// removing would silently drop the faculty assigned to it.
function addMissingSlots(courseId, roles) {
  const batches = db.prepare('SELECT id FROM batches WHERE course_id = ?').all(courseId);
  const existing = db.prepare('SELECT role, position FROM batch_assignments WHERE batch_id = ?');
  const insert = db.prepare(
    'INSERT INTO batch_assignments (batch_id, position, role, subject) VALUES (?, ?, ?, ?)',
  );
  for (const { id } of batches) {
    const rows = existing.all(id);
    const have = new Set(rows.map((r) => r.role.toLowerCase()));
    let position = rows.reduce((max, r) => Math.max(max, r.position), -1);
    for (const role of roles) {
      if (!have.has(role.name.toLowerCase())) insert.run(id, ++position, role.name, role.subject);
    }
  }
}

api.post('/courses', (req, res) => {
  const { name, roles, variants } = parseCourse(req.body);
  assertCourseNameFree(name);
  const id = tx(() => {
    const courseId = Number(db.prepare('INSERT INTO courses (name) VALUES (?)').run(name).lastInsertRowid);
    writeRoles(courseId, roles);
    if (variants) setCourseVariants(courseId, variants);
    reconcileStudentLinks();
    return courseId;
  });
  res.status(201).json({ id });
});

api.put('/courses/:id', (req, res) => {
  const course = findOr404('courses', req.params.id, 'course');
  const { name, roles, variants } = parseCourse(req.body);
  assertCourseNameFree(name, course.id);
  tx(() => {
    db.prepare('UPDATE courses SET name = ? WHERE id = ?').run(name, course.id);
    writeRoles(course.id, roles);
    if (variants) setCourseVariants(course.id, variants);
    if (req.body.apply_to_batches) addMissingSlots(course.id, roles);
    reconcileStudentLinks();
  });
  res.json({ id: course.id });
});

api.delete('/courses/:id', (req, res) => {
  const course = findOr404('courses', req.params.id, 'course');
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE course_id = ?`).get(course.id).n;
  const batches = count('batches');
  const flows = count('flows');
  if (batches || flows) {
    const parts = [];
    if (batches) parts.push(`${batches} batch${batches === 1 ? '' : 'es'}`);
    if (flows) parts.push(`${flows} master flow${flows === 1 ? '' : 's'}`);
    throw conflict(`${course.name} still has ${parts.join(' and ')}. Delete those first.`);
  }
  tx(() => {
    db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
    reconcileStudentLinks();
  });
  res.status(204).end();
});

/* ---------- faculties ---------- */

function parseFaculty(body) {
  const code = text(body.code, 'Faculty code', { max: 20 });
  const name = text(body.name, 'Faculty name');
  const courseIds = [...new Set(list(body.course_ids, 'Courses').map(Number))];
  for (const id of courseIds) findOr404('courses', id, 'course');

  const subjects = new Map();
  for (const raw of list(body.subjects, 'Subjects')) {
    const subject = subjectOf(raw);
    if (subject) subjects.set(subject.toLowerCase(), subject);
  }

  const weekOffs = [...new Set(list(body.week_offs, 'Week-offs'))];
  for (const day of weekOffs) {
    if (!DAYS.includes(day)) throw invalid(`"${day}" is not a day of the week.`);
  }
  return { code, name, email: emailOf(body.email), courseIds, subjects: [...subjects.values()], topics: parseTopics(body.topics), weekOffs };
}

/** The Google account a faculty's calendar is shared with; empty means none. */
function emailOf(value, prefix = '') {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return null;
  if (email.length > 200 || !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/.test(email)) throw invalid(`${prefix}"${email}" is not an email address.`);
  return email;
}

function parseTopics(value) {
  const topics = new Map();
  for (const raw of list(value, 'Topics')) {
    const topic = text(raw, 'Topic', { max: 300 });
    topics.set(topic.toLowerCase(), topic);
  }
  return [...topics.values()];
}

function assertCodeFree(code, exceptId = 0) {
  const clash = db.prepare('SELECT name FROM faculties WHERE code = ? AND id <> ?').get(code, exceptId);
  if (clash) throw conflict(`Faculty code "${code}" is already used by ${clash.name}.`);
}

function writeFacultyDetails(id, { courseIds, subjects, topics, weekOffs }) {
  for (const table of ['faculty_courses', 'faculty_subjects', 'faculty_topics', 'faculty_week_offs']) {
    db.prepare(`DELETE FROM ${table} WHERE faculty_id = ?`).run(id);
  }
  const addTopic = db.prepare('INSERT INTO faculty_topics (faculty_id, topic) VALUES (?, ?)');
  topics.forEach((t) => addTopic.run(id, t));
  const addCourse = db.prepare('INSERT INTO faculty_courses (faculty_id, course_id) VALUES (?, ?)');
  const addSubject = db.prepare('INSERT INTO faculty_subjects (faculty_id, subject) VALUES (?, ?)');
  const addOff = db.prepare('INSERT INTO faculty_week_offs (faculty_id, day) VALUES (?, ?)');
  courseIds.forEach((c) => addCourse.run(id, c));
  subjects.forEach((s) => addSubject.run(id, s));
  weekOffs.forEach((d) => addOff.run(id, d));
}

function refuseAll(errors) {
  const shown = errors.slice(0, 6).join(' ');
  const more = errors.length > 6 ? ` …and ${errors.length - 6} more.` : '';
  throw invalid(`Nothing was changed. ${shown}${more}`);
}

// Faculty Code is the unique ID: a known code updates that faculty, a new one adds them.
// A column missing from the upload leaves that detail as it is.
api.post('/faculties/import', (req, res) => {
  const rows = list(req.body.rows, 'Rows');
  if (!rows.length) throw invalid('There are no faculty to upload.');
  const courseByName = new Map(db.prepare('SELECT id, name FROM courses').all().map((c) => [c.name.toLowerCase(), c.id]));
  const existing = db.prepare('SELECT * FROM faculties WHERE code = ?');
  const errors = [];

  const parsed = rows.map((row) => {
    const code = text(row.code, 'Faculty Code', { max: 20 });
    const found = existing.get(code);
    const name = text(row.name, 'Name', { required: false }) || found?.name;
    if (!name) errors.push(`${code}: a new faculty needs a name.`);

    let courseIds = null;
    if (row.courses !== undefined) {
      courseIds = [];
      for (const courseName of list(row.courses, 'Courses')) {
        const id = courseByName.get(String(courseName).trim().toLowerCase());
        if (id) courseIds.push(id);
        else errors.push(`${code}: there is no course named "${courseName}". Add it under Courses first.`);
      }
      courseIds = [...new Set(courseIds)];
    }

    let email;
    try {
      email = row.email === undefined ? undefined : emailOf(row.email, `${code}: `);
    } catch (err) {
      errors.push(err.message);
    }

    const weekOffs = row.week_offs === undefined ? null : [...new Set(list(row.week_offs, 'Week-offs'))];
    for (const day of weekOffs ?? []) {
      if (!DAYS.includes(day)) errors.push(`${code}: "${day}" is not a day of the week.`);
    }

    let subjects = null;
    if (row.subjects !== undefined) {
      const unique = new Map();
      for (const raw of list(row.subjects, 'Subjects')) {
        const subject = subjectOf(raw);
        if (subject) unique.set(subject.toLowerCase(), subject);
      }
      subjects = [...unique.values()];
    }
    return { code, name, email, found, courseIds, subjects, weekOffs, topics: row.topics === undefined ? null : parseTopics(row.topics) };
  });

  const codes = parsed.map((p) => p.code.toLowerCase());
  for (const code of new Set(codes.filter((c, i) => codes.indexOf(c) !== i))) errors.push(`${code} appears more than once.`);
  if (errors.length) refuseAll(errors);

  const current = (table, column, id) => db.prepare(`SELECT ${column} AS v FROM ${table} WHERE faculty_id = ?`).all(id).map((r) => r.v);
  let added = 0;
  let updated = 0;
  tx(() => {
    for (const p of parsed) {
      let id = p.found?.id;
      if (id) {
        // The code keeps its original spelling; "rs01" in an upload is still RS01.
        db.prepare('UPDATE faculties SET name = ?, email = ? WHERE id = ?').run(p.name, p.email === undefined ? p.found.email : p.email, id);
        updated += 1;
      } else {
        id = Number(db.prepare('INSERT INTO faculties (code, name, email) VALUES (?, ?, ?)').run(p.code, p.name, p.email ?? null).lastInsertRowid);
        added += 1;
      }
      writeFacultyDetails(id, {
        courseIds: p.courseIds ?? current('faculty_courses', 'course_id', id),
        subjects: p.subjects ?? current('faculty_subjects', 'subject', id),
        topics: p.topics ?? current('faculty_topics', 'topic', id),
        weekOffs: p.weekOffs ?? current('faculty_week_offs', 'day', id),
      });
    }
  });
  res.json({ added, updated });
});

api.post('/faculties', (req, res) => {
  const data = parseFaculty(req.body);
  assertCodeFree(data.code);
  const id = tx(() => {
    const facultyId = Number(
      db.prepare('INSERT INTO faculties (code, name, email) VALUES (?, ?, ?)').run(data.code, data.name, data.email).lastInsertRowid,
    );
    writeFacultyDetails(facultyId, data);
    return facultyId;
  });
  res.status(201).json({ id });
});

api.put('/faculties/:id', (req, res) => {
  const faculty = findOr404('faculties', req.params.id, 'faculty');
  const data = parseFaculty(req.body);
  if (!('email' in req.body)) data.email = faculty.email; // left out: unchanged
  assertCodeFree(data.code, faculty.id);
  tx(() => {
    db.prepare('UPDATE faculties SET code = ?, name = ?, email = ? WHERE id = ?').run(data.code, data.name, data.email, faculty.id);
    writeFacultyDetails(faculty.id, data);
  });
  res.json({ id: faculty.id });
});

api.delete('/faculties/:id', (req, res) => {
  const faculty = findOr404('faculties', req.params.id, 'faculty');
  db.prepare('DELETE FROM faculties WHERE id = ?').run(faculty.id);
  res.status(204).end();
});

/* ---------- batches ---------- */

// Batch codes must be unique everywhere, because students link to a batch by code alone.
function assertCodeUnused(code, exceptId = 0) {
  const key = normalizeCode(code);
  const clash = db.prepare('SELECT name, id FROM batches WHERE id <> ?').all(exceptId)
    .find((b) => normalizeCode(b.name) === key);
  if (clash) throw conflict(`A batch with the code "${clash.name}" already exists.`);
}

function writeSlot(batchId, position, { role, subject, facultyId, substituteIds }) {
  const id = db.prepare('INSERT INTO batch_assignments (batch_id, position, role, subject, faculty_id) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, position, role, subject, facultyId).lastInsertRowid;
  const addSub = db.prepare('INSERT INTO batch_assignment_substitutes (assignment_id, position, faculty_id) VALUES (?, ?, ?)');
  substituteIds.forEach((facultyIdOfSub, i) => addSub.run(id, i, facultyIdOfSub));
}

/** Checks one batch's class times. A faulty time is refused here, never stored. */
function parseTimings(value, label = '') {
  const timings = list(value, 'Class times').map((t) => {
    if (!DAYS.includes(t.weekday)) throw invalid(`${label}"${t.weekday}" is not a day of the week.`);
    if (!isTime(t.start_time) || !isTime(t.end_time)) throw invalid(`${label}Enter a start and end time for ${t.weekday}.`);
    if (t.start_time >= t.end_time) {
      throw invalid(`${label}On ${t.weekday}, the class must end after it starts (${formatTime(t.start_time)} to ${formatTime(t.end_time)}).`);
    }
    return { weekday: t.weekday, start_time: t.start_time, end_time: t.end_time };
  });
  const clash = findOverlap(timings);
  if (clash) {
    const [a, b] = clash;
    throw invalid(`${label}Two classes overlap on ${a.weekday}: ${formatTime(a.start_time)} – ${formatTime(a.end_time)} and ${formatTime(b.start_time)} – ${formatTime(b.end_time)}.`);
  }
  return timings;
}

function writeTimings(batchId, timings) {
  db.prepare('DELETE FROM batch_timings WHERE batch_id = ?').run(batchId);
  const insert = db.prepare('INSERT INTO batch_timings (batch_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  timings.forEach((t) => insert.run(batchId, t.weekday, t.start_time, t.end_time));
}

const batchesByCode = () => new Map(db.prepare('SELECT * FROM batches ORDER BY id').all().map((b) => [normalizeCode(b.name), b]));

// Batch, Slot, Faculty Code, Substitutes. Only the slots listed change. A slot the batch
// doesn't have yet is added, so a batch can differ from its course.
api.post('/batches/assignments/import', (req, res) => {
  const rows = list(req.body.rows, 'Rows');
  if (!rows.length) throw invalid('There are no assignments to upload.');
  const batches = batchesByCode();
  const facultyByCode = new Map(db.prepare('SELECT * FROM faculties').all().map((f) => [f.code.toLowerCase(), f]));
  const teaches = db.prepare('SELECT 1 FROM faculty_courses WHERE faculty_id = ? AND course_id = ?');
  const errors = [];
  const outsideCourse = new Set();
  const seen = new Set();

  const faculty = (code, context) => {
    const found = facultyByCode.get(String(code).trim().toLowerCase());
    if (!found) errors.push(`${context}: there is no faculty with code "${code}".`);
    return found;
  };

  const parsed = rows.map((row) => {
    const batchCode = text(row.batch, 'Batch', { max: 60 });
    const slot = text(row.slot, 'Slot', { max: 40 });
    const context = `${batchCode} ${slot}`;
    const batch = batches.get(normalizeCode(batchCode));
    if (!batch) errors.push(`There is no batch "${batchCode}". Add it, or check the student sheet sync.`);

    const key = `${normalizeCode(batchCode)}|${slot.toLowerCase()}`;
    if (seen.has(key)) errors.push(`${context} appears more than once.`);
    seen.add(key);

    const primary = row.faculty ? faculty(row.faculty, context) : null;
    const subs = list(row.substitutes, 'Substitutes').map((code) => faculty(code, context)).filter(Boolean);
    const substituteIds = [...new Set(subs.map((f) => f.id))];
    if (primary && substituteIds.includes(primary.id)) errors.push(`${context}: ${primary.code} can't be both primary and substitute.`);
    if (batch) {
      for (const f of [primary, ...subs].filter(Boolean)) {
        if (!teaches.get(f.id, batch.course_id)) outsideCourse.add(`${f.code} in ${batch.name}`);
      }
    }
    return { batch, slot, subject: subjectOf(row.subject), facultyId: primary?.id ?? null, substituteIds };
  });
  if (errors.length) refuseAll(errors);

  let slotsAdded = 0;
  tx(() => {
    const find = db.prepare('SELECT * FROM batch_assignments WHERE batch_id = ? AND role = ?');
    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM batch_assignments WHERE batch_id = ?');
    const remove = db.prepare('DELETE FROM batch_assignments WHERE id = ?');
    for (const p of parsed) {
      const existing = find.get(p.batch.id, p.slot);
      if (existing) remove.run(existing.id);
      else slotsAdded += 1;
      writeSlot(p.batch.id, existing?.position ?? nextPosition.get(p.batch.id).n, {
        role: existing?.role ?? p.slot,
        subject: p.subject ?? existing?.subject ?? null,
        facultyId: p.facultyId,
        substituteIds: p.substituteIds,
      });
    }
  });
  res.json({ updated: parsed.length, slots_added: slotsAdded, batches: new Set(parsed.map((p) => p.batch.id)).size, outside_course: [...outsideCourse] });
});

// Batch, Weekdays, times, dates. Each batch listed gets exactly the hours in the upload.
api.post('/batches/timetable/import', (req, res) => {
  const rows = list(req.body.rows, 'Rows');
  if (!rows.length) throw invalid('There are no class times to upload.');
  const batches = batchesByCode();
  const errors = [];
  const perBatch = new Map();

  for (const row of rows) {
    const batchCode = text(row.batch, 'Batch', { max: 60 });
    const batch = batches.get(normalizeCode(batchCode));
    if (!batch) {
      errors.push(`There is no batch "${batchCode}". Add it, or check the student sheet sync.`);
      continue;
    }
    if (!perBatch.has(batch.id)) perBatch.set(batch.id, { batch, timings: [], start_date: undefined, end_date: undefined });
    const entry = perBatch.get(batch.id);
    for (const weekday of list(row.days, 'Weekdays')) {
      entry.timings.push({ weekday, start_time: row.start, end_time: row.end });
    }
    for (const field of ['start_date', 'end_date']) {
      if (!row[field]) continue;
      if (!isIsoDate(row[field])) errors.push(`${batchCode}: "${row[field]}" is not a real date.`);
      if (entry[field] && entry[field] !== row[field]) errors.push(`${batchCode} has two different ${field.replace('_', ' ')}s.`);
      entry[field] = row[field];
    }
  }

  const prepared = [];
  for (const entry of perBatch.values()) {
    try {
      entry.parsed = parseTimings(entry.timings, `${entry.batch.name}: `);
      const start = entry.start_date ?? entry.batch.start_date;
      const end = entry.end_date ?? entry.batch.end_date;
      if (start && end && end < start) errors.push(`${entry.batch.name}: the end date is before the start date.`);
      prepared.push({ ...entry, start, end });
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) refuseAll(errors);

  tx(() => {
    const setDates = db.prepare('UPDATE batches SET start_date = ?, end_date = ? WHERE id = ?');
    for (const entry of prepared) {
      writeTimings(entry.batch.id, entry.parsed);
      setDates.run(entry.start ?? null, entry.end ?? null, entry.batch.id);
    }
  });
  res.json({ batches: prepared.length, class_times: prepared.reduce((sum, e) => sum + e.parsed.length, 0) });
});

/* ---------- the course faculty sheet ---------- */

function slotsOfBatch(batchId) {
  const subs = db.prepare(`
    SELECT s.faculty_id, f.code FROM batch_assignment_substitutes s JOIN faculties f ON f.id = s.faculty_id
    WHERE s.assignment_id = ? ORDER BY s.position`);
  return db.prepare(`
    SELECT a.*, f.code AS faculty_code FROM batch_assignments a LEFT JOIN faculties f ON f.id = a.faculty_id
    WHERE a.batch_id = ? ORDER BY a.position`).all(batchId)
    .map((a) => {
      const list = subs.all(a.id);
      return { ...a, substitute_ids: list.map((s) => s.faculty_id), substitute_codes: list.map((s) => s.code) };
    });
}

const flowSubjectsOf = (courseId) => courseSubjects(db.prepare('SELECT * FROM flows WHERE course_id = ?').all(courseId)
  .map((f) => ({ sessions: db.prepare('SELECT subject FROM flow_sessions WHERE flow_id = ?').all(f.id) })));

// Batches still running (or not yet started), in code order.
const sheetBatchesOf = (courseId) => db.prepare("SELECT * FROM batches WHERE course_id = ? AND (end_date IS NULL OR end_date >= date('now'))")
  .all(courseId).sort((a, b) => collator.compare(a.name, b.name));

api.get('/courses/:id/faculty-sheet', (req, res) => {
  const course = findOr404('courses', req.params.id, 'course');
  const found = flowSubjectsOf(course.id);
  if (!found.length) throw invalid(`Upload a master flow for ${course.name} first. Its subjects become the sheet’s columns.`);
  const asked = req.query.subjects == null ? null : String(req.query.subjects).split(',').map((s) => s.trim()).filter(Boolean);
  const subjects = asked
    ? found.filter((s) => asked.some((a) => a.toLowerCase() === s.subject.toLowerCase())).map((s) => s.subject)
    : found.filter((s) => !s.covered_by).map((s) => s.subject);

  const facultyRows = db.prepare('SELECT * FROM faculties').all().sort((a, b) => collator.compare(a.code, b.code));
  const detail = (table, column, id) => db.prepare(`SELECT ${column} AS v FROM ${table} WHERE faculty_id = ?`).all(id).map((r) => r.v);
  const file = buildCourseSheet({
    course,
    subjects,
    batches: sheetBatchesOf(course.id).map((b) => ({
      name: b.name,
      timings: db.prepare('SELECT weekday, start_time, end_time FROM batch_timings WHERE batch_id = ?').all(b.id),
      slots: slotsOfBatch(b.id),
    })),
    faculties: facultyRows.map((f) => ({
      code: f.code,
      name: f.name,
      subjects: detail('faculty_subjects', 'subject', f.id),
      week_offs: detail('faculty_week_offs', 'day', f.id).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)),
    })),
  });
  const safeName = course.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'course';
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${safeName}-faculty-sheet.xlsx"`,
  });
  res.send(file);
});

const describeSlot = (primary, subs) => (primary || subs.length
  ? `${primary || 'nobody'}${subs.length ? `, substitute ${subs.join(', ')}` : ''}`
  : 'nobody');
const describeHours = (timings) => (timings.length
  ? groupTimings(timings).map((g) => `${dayChoiceOf(g.days)} ${g.start_time}–${g.end_time}`).join('; ')
  : 'no class times');

// Reads a filled course faculty sheet. Without apply it only reports what would change;
// with apply it saves everything, or nothing if any row has a problem.
api.post('/courses/:id/faculty-sheet', (req, res) => {
  const course = findOr404('courses', req.params.id, 'course');
  const encoded = String(req.body?.file ?? '');
  if (!encoded) throw invalid('Choose the filled sheet to upload.');
  let parsed;
  try {
    parsed = readCourseSheet(sheetRows(Buffer.from(encoded, 'base64'), String(req.body?.name ?? '')));
  } catch (err) {
    throw invalid(err.message);
  }
  const errors = [...parsed.problems];
  const notes = [];
  if (!parsed.batches.length && !errors.length) errors.push('The sheet has no batch rows.');

  const batches = batchesByCode();
  const facultyByCode = new Map(db.prepare('SELECT * FROM faculties').all().map((f) => [f.code.toLowerCase(), f]));
  const teachesCourse = db.prepare('SELECT 1 FROM faculty_courses WHERE faculty_id = ? AND course_id = ?');
  const subjectsOf = db.prepare('SELECT subject FROM faculty_subjects WHERE faculty_id = ?');
  const flowSubjects = flowSubjectsOf(course.id).map((s) => s.subject.toLowerCase());
  const courseName = (id) => db.prepare('SELECT name FROM courses WHERE id = ?').get(id)?.name ?? 'another course';

  const plans = [];
  for (const entry of parsed.batches) {
    const batch = batches.get(normalizeCode(entry.code));
    if (!batch) {
      errors.push(`There is no batch "${entry.code}". Add it, or check the student sheet sync.`);
      continue;
    }
    if (batch.course_id !== course.id) {
      errors.push(`${batch.name} belongs to ${courseName(batch.course_id)}, not ${course.name}.`);
      continue;
    }
    const plan = { batch, changes: [], timings: null, slots: [] };

    if (entry.timings.length) {
      try {
        plan.timings = parseTimings(entry.timings, `${batch.name}: `);
        const before = db.prepare('SELECT weekday, start_time, end_time FROM batch_timings WHERE batch_id = ?').all(batch.id);
        const [was, now] = [describeHours(before), describeHours(plan.timings)];
        if (was !== now) plan.changes.push(`Class times: ${now} (was ${was})`);
      } catch (err) {
        errors.push(err.message);
      }
    }

    const slots = slotsOfBatch(batch.id);
    const used = new Set();
    for (const { subject, ranks } of parsed.subjects) {
      const code = (rank) => entry.faculty.get(`${subject.toLowerCase()}|${rank}`) ?? '';
      const lookup = (rank) => {
        const value = code(rank);
        if (!value) return null;
        const f = facultyByCode.get(value.toLowerCase());
        if (!f) errors.push(`${batch.name} ${subject}${ranks.length > 1 ? rank : ''}: there is no faculty with code "${value}".`);
        return f ?? null;
      };
      const primary = lookup(1);
      const sub = ranks.includes(2) ? lookup(2) : null;
      if (primary && sub && primary.id === sub.id) errors.push(`${batch.name} ${subject}: ${primary.code} can’t be both primary and substitute.`);

      const current = slotsFor(subject, slots);
      current.forEach((s) => used.add(s.id));
      const mentor = subject.toLowerCase() === MENTOR.toLowerCase();
      // Rank 2 left out of the sheet (Mentor) keeps the slot's existing substitutes.
      const keepSubs = !ranks.includes(2) ? (current[0]?.substitute_ids ?? []) : null;
      const next = {
        remove: current.map((s) => s.id),
        position: current.length ? Math.min(...current.map((s) => s.position)) : null,
        role: mentor ? (current[0]?.role ?? MENTOR) : subject,
        subject: mentor ? (current[0]?.subject ?? null) : subject,
        facultyId: primary?.id ?? null,
        substituteIds: keepSubs ?? (sub ? [sub.id] : []),
      };
      plan.slots.push(next);

      const was = current.length > 1
        ? current.map((s) => `${s.role} ${describeSlot(s.faculty_code, s.substitute_codes)}`).join('; ')
        : describeSlot(current[0]?.faculty_code, current[0]?.substitute_codes ?? []);
      const nowSubs = keepSubs ? (current[0]?.substitute_codes ?? []) : sub ? [sub.code] : [];
      const now = describeSlot(primary?.code, nowSubs);
      if (current.length > 1 || was !== now || (current[0] && current[0].role.toLowerCase() !== next.role.toLowerCase())) {
        plan.changes.push(`${next.role}: ${now} (was ${current.length ? was : 'no slot'})`);
      }

      for (const f of [primary, sub].filter(Boolean)) {
        if (!teachesCourse.get(f.id, course.id)) notes.push(`${f.code} (${batch.name} ${subject}) isn’t listed for ${course.name}.`);
        const listed = subjectsOf.all(f.id).map((r) => r.subject.toLowerCase());
        if (!mentor && listed.length && !listed.includes(subject.toLowerCase())) notes.push(`${f.code} (${batch.name}) isn’t listed for ${subject}.`);
      }
    }
    for (const s of slots) {
      if (used.has(s.id) || s.role.toLowerCase() === MENTOR.toLowerCase()) continue;
      if (s.subject && !flowSubjects.includes(s.subject.toLowerCase())) {
        notes.push(`${batch.name} keeps its ${s.role} slot (${s.subject}), but no subject in ${course.name}’s master flow is called ${s.subject}, so the scheduler won’t use it.`);
      }
    }
    plans.push(plan);
  }

  const summary = {
    batches: plans.map((p) => ({ name: p.batch.name, changes: p.changes })),
    changed: plans.filter((p) => p.changes.length).length,
    notes: [...new Set(notes)],
    errors,
  };
  if (!req.body?.apply) return res.json({ ...summary, applied: false });
  if (errors.length) refuseAll(errors);

  tx(() => {
    const remove = db.prepare('DELETE FROM batch_assignments WHERE id = ?');
    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM batch_assignments WHERE batch_id = ?');
    for (const plan of plans) {
      if (plan.timings) writeTimings(plan.batch.id, plan.timings);
      for (const slot of plan.slots) {
        slot.remove.forEach((id) => remove.run(id));
        writeSlot(plan.batch.id, slot.position ?? nextPosition.get(plan.batch.id).n, slot);
      }
    }
  });
  res.json({ ...summary, applied: true });
});

// Sheet batches appear by themselves. This is for a batch being planned before its
// first student reaches the sheet; it links up once that code appears there.
api.post('/batches', (req, res) => {
  const course = findOr404('courses', req.body.course_id, 'course');
  const code = text(req.body.code, 'Batch code', { max: 60 });
  const year = req.body.year ? whole(req.body.year, 'Year', 2000, 2100) : yearFromCode(code);
  if (!year) throw invalid('Enter the year. It could not be worked out from this code.');
  assertCodeUnused(code);

  const id = tx(() => {
    const batchId = Number(
      db.prepare('INSERT INTO batches (course_id, year, name) VALUES (?, ?, ?)').run(course.id, year, code).lastInsertRowid,
    );
    const roles = db.prepare('SELECT * FROM course_roles WHERE course_id = ? ORDER BY position').all(course.id);
    const addSlot = db.prepare(
      'INSERT INTO batch_assignments (batch_id, position, role, subject) VALUES (?, ?, ?, ?)',
    );
    roles.forEach((r, position) => addSlot.run(batchId, position, r.name, r.subject));
    reconcileStudentLinks();
    return batchId;
  });
  res.status(201).json({ id });
});

api.put('/batches/:id', (req, res) => {
  const batch = findOr404('batches', req.params.id, 'batch');
  const name = text(req.body.name, 'Batch code', { max: 60 });
  const year = whole(req.body.year, 'Year', 2000, 2100);
  const mode = req.body.mode === undefined ? batch.mode : req.body.mode;
  if (!['classroom', 'online'].includes(mode)) throw invalid('A batch is either classroom or online.');

  if (normalizeCode(name) !== normalizeCode(batch.name) && activeStudentCount(batch.id)) {
    throw conflict('This code comes from the student sheet and has active students. Change it in the sheet instead.');
  }
  assertCodeUnused(name, batch.id);

  const slots = list(req.body.assignments, 'Faculty slots').map((a) => {
    const facultyId = a.faculty_id ? Number(a.faculty_id) : null;
    if (facultyId) findOr404('faculties', facultyId, 'faculty');
    const role = text(a.role, 'Slot name', { max: 40 });
    const substituteIds = [...new Set(list(a.substitute_ids, 'Substitutes').map(Number))];
    for (const id of substituteIds) findOr404('faculties', id, 'faculty');
    if (facultyId && substituteIds.includes(facultyId)) {
      throw invalid(`${role}: the primary faculty can't also be a substitute for the same slot.`);
    }
    return { role, subject: subjectOf(a.subject), facultyId, substituteIds };
  });
  assertUnique(slots.map((s) => s.role), 'Slot');

  const newTimings = req.body.timings === undefined ? null : parseTimings(req.body.timings);
  const dateOf = (field, label) => {
    if (req.body[field] === undefined) return batch[field];
    const value = String(req.body[field] ?? '').trim();
    if (value && !isIsoDate(value)) throw invalid(`${label} is not a real date.`);
    return value || null;
  };
  const startDate = dateOf('start_date', 'Start date');
  const endDate = dateOf('end_date', 'End date');
  if (startDate && endDate && endDate < startDate) throw invalid('The end date is before the start date.');

  tx(() => {
    db.prepare('UPDATE batches SET name = ?, year = ?, start_date = ?, end_date = ?, mode = ? WHERE id = ?').run(name, year, startDate, endDate, mode, batch.id);
    db.prepare('DELETE FROM batch_assignments WHERE batch_id = ?').run(batch.id);
    slots.forEach((s, i) => writeSlot(batch.id, i, s));
    if (newTimings) writeTimings(batch.id, newTimings);
    reconcileStudentLinks();
  });
  res.json({ id: batch.id });
});

api.delete('/batches/:id', (req, res) => {
  const batch = findOr404('batches', req.params.id, 'batch');
  const active = activeStudentCount(batch.id);
  if (active) {
    throw conflict(`${batch.name} has ${active} active student${active === 1 ? '' : 's'} in the sheet, so it would come straight back. Move them in the sheet first.`);
  }
  tx(() => {
    db.prepare('DELETE FROM batches WHERE id = ?').run(batch.id);
    reconcileStudentLinks();
  });
  res.status(204).end();
});

/* ---------- master flows ---------- */

function parseFlow(body, courseId, flowId) {
  const name = text(body.name, 'Flow name', { max: 80 });
  const scope = body.scope === 'batches' ? 'batches' : 'course';

  const nameClash = db
    .prepare('SELECT id FROM flows WHERE course_id = ? AND name = ? AND id <> ?')
    .get(courseId, name, flowId);
  if (nameClash) throw conflict(`This course already has a flow named "${name}".`);

  let batchIds = [];
  if (scope === 'course') {
    const other = db
      .prepare("SELECT name FROM flows WHERE course_id = ? AND scope = 'course' AND id <> ?")
      .get(courseId, flowId);
    if (other) {
      throw conflict(`This course already has a course-wide flow ("${other.name}"). Choose specific batches instead.`);
    }
  } else {
    batchIds = [...new Set(list(body.batch_ids, 'Batches').map(Number))];
    if (!batchIds.length) throw invalid('Choose at least one batch for this flow.');
    for (const id of batchIds) {
      const batch = findOr404('batches', id, 'batch');
      if (batch.course_id !== courseId) throw invalid(`${batch.name} belongs to a different course.`);
      const taken = db
        .prepare(`SELECT f.name FROM flow_batches fb JOIN flows f ON f.id = fb.flow_id
                  WHERE fb.batch_id = ? AND fb.flow_id <> ?`)
        .get(id, flowId);
      if (taken) throw conflict(`${batch.name} already follows "${taken.name}". Remove it from that flow first.`);
    }
  }

  const sessions = list(body.sessions, 'Sessions').map((s, i) => {
    const label = `Session ${i + 1}`;
    return {
      id: s.id ? Number(s.id) : null,
      subject: subjectOf(s.subject, `${label}: subject`, { required: true }),
      topic: text(s.topic, `${label}: topic`, { max: 300 }),
      code: text(s.topic_code, `${label}: topic code`, { required: false, max: 60 }),
      area: text(s.area, `${label}: area`, { required: false, max: 80 }),
      homework: text(s.homework, `${label}: homework`, { required: false, max: 600 }),
    };
  });
  return { name, scope, batchIds, sessions };
}

function writeFlowDetails(flowId, { batchIds, sessions }) {
  db.prepare('DELETE FROM flow_batches WHERE flow_id = ?').run(flowId);
  const addBatch = db.prepare('INSERT INTO flow_batches (flow_id, batch_id) VALUES (?, ?)');
  batchIds.forEach((id) => addBatch.run(flowId, id));

  // Sessions are updated in place, not recreated, because batch progress points at them.
  const existing = db.prepare('SELECT id, topic_code AS code, topic FROM flow_sessions WHERE flow_id = ?').all(flowId);
  const ids = matchSessions(existing, sessions);
  const kept = new Set(ids.filter(Boolean));

  const removedIds = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  const countProgress = db.prepare('SELECT COUNT(*) AS n FROM batch_session_progress WHERE session_id = ?');
  const progressLost = removedIds.reduce((sum, id) => sum + countProgress.get(id).n, 0);
  const remove = db.prepare('DELETE FROM flow_sessions WHERE id = ?');
  removedIds.forEach((id) => remove.run(id));

  const update = db.prepare('UPDATE flow_sessions SET position = ?, subject = ?, topic = ?, topic_code = ?, area = ?, homework = ? WHERE id = ?');
  const insert = db.prepare(
    'INSERT INTO flow_sessions (flow_id, position, subject, topic, topic_code, area, homework) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  sessions.forEach((s, i) => {
    if (ids[i]) update.run(i, s.subject, s.topic, s.code, s.area, s.homework, ids[i]);
    else insert.run(flowId, i, s.subject, s.topic, s.code, s.area, s.homework);
  });
  return { progress_lost: progressLost };
}

/* ---------- batch progress ---------- */

/** A batch follows its group flow if it has one, otherwise its course-wide flow. */
function flowIdOfBatch(batch) {
  const group = db.prepare('SELECT flow_id FROM flow_batches WHERE batch_id = ?').get(batch.id);
  if (group) return group.flow_id;
  return db.prepare("SELECT id FROM flows WHERE course_id = ? AND scope = 'course'").get(batch.course_id)?.id ?? null;
}

api.get('/flows/:id/progress', (req, res) => {
  const flow = findOr404('flows', req.params.id, 'flow');
  const rows = db.prepare(`
    SELECT p.batch_id, p.session_id FROM batch_session_progress p
    JOIN flow_sessions s ON s.id = p.session_id WHERE s.flow_id = ?`).all(flow.id);
  const finished = {};
  for (const row of rows) (finished[row.batch_id] ??= []).push(row.session_id);
  res.json({ finished });
});

// Replaces which sessions of its current flow a batch has finished.
api.put('/batches/:id/progress', (req, res) => {
  const batch = findOr404('batches', req.params.id, 'batch');
  const flowId = flowIdOfBatch(batch);
  if (!flowId) throw conflict(`${batch.name} has no master flow yet.`);

  const valid = new Set(db.prepare('SELECT id FROM flow_sessions WHERE flow_id = ?').all(flowId).map((s) => s.id));
  const finished = [...new Set(list(req.body.finished, 'Finished sessions').map(Number))];
  if (finished.some((id) => !valid.has(id))) throw invalid('Those sessions are not in this batch’s master flow. Reload the page and try again.');

  tx(() => {
    const keep = new Set(finished);
    const remove = db.prepare('DELETE FROM batch_session_progress WHERE batch_id = ? AND session_id = ?');
    for (const id of valid) if (!keep.has(id)) remove.run(batch.id, id);
    const add = db.prepare('INSERT OR IGNORE INTO batch_session_progress (batch_id, session_id, marked_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    finished.forEach((id) => add.run(batch.id, id, now));
  });
  res.json({ id: batch.id, finished: finished.length });
});

api.post('/flows', (req, res) => {
  const course = findOr404('courses', req.body.course_id, 'course');
  const data = parseFlow(req.body, course.id, 0);
  const id = tx(() => {
    const flowId = Number(
      db.prepare('INSERT INTO flows (course_id, name, scope) VALUES (?, ?, ?)')
        .run(course.id, data.name, data.scope).lastInsertRowid,
    );
    writeFlowDetails(flowId, data);
    return flowId;
  });
  res.status(201).json({ id });
});

api.put('/flows/:id', (req, res) => {
  const flow = findOr404('flows', req.params.id, 'flow');
  const data = parseFlow(req.body, flow.course_id, flow.id);
  const result = tx(() => {
    db.prepare('UPDATE flows SET name = ?, scope = ? WHERE id = ?').run(data.name, data.scope, flow.id);
    return writeFlowDetails(flow.id, data);
  });
  res.json({ id: flow.id, ...result });
});

api.delete('/flows/:id', (req, res) => {
  const flow = findOr404('flows', req.params.id, 'flow');
  db.prepare('DELETE FROM flows WHERE id = ?').run(flow.id);
  res.status(204).end();
});

/* ---------- rooms ---------- */

function parseRoom(body, exceptId = 0) {
  const name = text(body.name, 'Room name', { max: 60 });
  const clash = db.prepare('SELECT id FROM rooms WHERE name = ? AND id <> ?').get(name, exceptId);
  if (clash) throw conflict(`A room named "${name}" already exists.`);
  return {
    name,
    capacity: whole(body.capacity, 'Capacity', 1, 5000, { required: false }),
    location: text(body.location, 'Location', { required: false }) || null,
  };
}

api.post('/rooms', (req, res) => {
  const r = parseRoom(req.body);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO rooms (name, capacity, location) VALUES (?, ?, ?)')
    .run(r.name, r.capacity, r.location);
  res.status(201).json({ id: Number(lastInsertRowid) });
});

api.put('/rooms/:id', (req, res) => {
  const room = findOr404('rooms', req.params.id, 'room');
  const r = parseRoom(req.body, room.id);
  db.prepare('UPDATE rooms SET name = ?, capacity = ?, location = ? WHERE id = ?')
    .run(r.name, r.capacity, r.location, room.id);
  res.json({ id: room.id });
});

api.delete('/rooms/:id', (req, res) => {
  const room = findOr404('rooms', req.params.id, 'room');
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  res.status(204).end();
});

/* ---------- fallbacks ---------- */

api.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Something went wrong on the server.' : err.message;
  res.status(status).json({ error: message });
});
