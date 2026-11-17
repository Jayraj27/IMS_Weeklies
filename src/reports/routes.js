/*
 * Reports for the admin: how many hours each faculty teaches in a period, and where each
 * batch will be in its master flow by its end date if classes run as timetabled.
 */

import express from 'express';
import { db } from '../db.js';
import { addDays, classesBetween, formatDate, formatTime, isIsoDate, todayIso, weekdayOf } from '../../public/admin/calendar.js';
import { buildXlsx, cellRef } from '../xlsx.js';

export const reportsRouter = express.Router();

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const minutesOf = (start, end) => (Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)));
const hours = (minutes) => Math.round((minutes / 60) * 100) / 100;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function period(query) {
  const { from, to } = query;
  if (!isIsoDate(from) || !isIsoDate(to)) throw fail(400, 'Choose a start and end date.');
  if (to < from) throw fail(400, 'The end date is before the start date.');
  if (addDays(from, 400) < to) throw fail(400, 'Choose a period of a year or less.');
  return { from, to };
}

/* ---------- faculty workload ---------- */

function workload({ from, to }) {
  const classes = db.prepare(`
    SELECT c.id, c.date, c.start_time, c.end_time, c.status, c.faculty_id, c.online,
           b.name AS batch_name, co.name AS course_name, s.subject, s.topic_code, s.topic, r.name AS room_name
    FROM schedule_classes c
    JOIN batches b ON b.id = c.batch_id
    JOIN courses co ON co.id = b.course_id
    LEFT JOIN flow_sessions s ON s.id = c.session_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE c.date BETWEEN ? AND ? AND c.status <> 'cancelled'
    ORDER BY c.date, c.start_time`).all(from, to);
  const events = db.prepare(`
    SELECT e.id, e.date, e.start_time, e.end_time, e.title, ef.faculty_id
    FROM schedule_events e JOIN schedule_event_faculty ef ON ef.event_id = e.id
    WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.start_time`).all(from, to);

  const faculties = db.prepare('SELECT id, code, name FROM faculties').all().sort((a, b) => collator.compare(a.code, b.code));
  const rows = new Map(faculties.map((f) => [f.id, {
    id: f.id, code: f.code, name: f.name, classes: 0, minutes: 0, done_minutes: 0, planned_minutes: 0,
    block_minutes: 0, days: new Set(), courses: new Map(), batches: new Map(),
  }]));
  const unassigned = { classes: 0, minutes: 0 };

  for (const c of classes) {
    const m = minutesOf(c.start_time, c.end_time);
    const row = rows.get(c.faculty_id);
    if (!row) {
      unassigned.classes += 1;
      unassigned.minutes += m;
      continue;
    }
    row.classes += 1;
    row.minutes += m;
    row[c.status === 'done' ? 'done_minutes' : 'planned_minutes'] += m;
    row.days.add(c.date);
    row.courses.set(c.course_name, (row.courses.get(c.course_name) ?? 0) + m);
    row.batches.set(c.batch_name, (row.batches.get(c.batch_name) ?? 0) + m);
  }
  for (const e of events) {
    const row = rows.get(e.faculty_id);
    if (row) row.block_minutes += minutesOf(e.start_time, e.end_time);
  }

  const split = (map) => [...map].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).map(([name, m]) => ({ name, hours: hours(m) }));
  const list = [...rows.values()].map((r) => ({
    id: r.id, code: r.code, name: r.name, classes: r.classes, days: r.days.size,
    hours: hours(r.minutes), done_hours: hours(r.done_minutes), planned_hours: hours(r.planned_minutes),
    block_hours: hours(r.block_minutes), courses: split(r.courses), batches: split(r.batches),
  })).sort((a, b) => b.hours - a.hours || collator.compare(a.code, b.code));

  return {
    from, to,
    faculties: list,
    unassigned: { classes: unassigned.classes, hours: hours(unassigned.minutes) },
    total_hours: hours(list.reduce((n, f) => n + f.hours * 60, 0)),
    classes,
    events,
  };
}

reportsRouter.get('/workload', (req, res) => {
  const { classes, events, ...report } = workload(period(req.query));
  res.json(report);
});

reportsRouter.get('/workload.xlsx', (req, res) => {
  const report = workload(period(req.query));
  const head = { bold: true, fill: '#E7E6E1', border: true, wrap: true, v: 'center' };
  const cell = { border: true, borderColor: '#D9D9D9', v: 'top', wrap: true };
  const title = `Faculty workload, ${formatDate(report.from)} – ${formatDate(report.to)}`;
  const codeOf = new Map(report.faculties.map((f) => [f.id, f]));

  const summary = [
    [{ v: title, s: { bold: true, size: 13 } }],
    [{ v: 'Cancelled classes are not counted. Hours come from the weekly schedule.', s: { color: '#555555' } }],
    ['Faculty Code', 'Name', 'Classes', 'Days teaching', 'Teaching hours', 'Done', 'Still planned', 'Meeting hours', 'By course', 'By batch']
      .map((v) => ({ v, s: head })),
    ...report.faculties.map((f) => [
      f.code, f.name, f.classes, f.days, f.hours, f.done_hours, f.planned_hours, f.block_hours,
      f.courses.map((c) => `${c.name} ${c.hours}h`).join(', '), f.batches.map((b) => `${b.name} ${b.hours}h`).join(', '),
    ].map((v) => ({ v, s: cell }))),
  ];
  if (report.unassigned.classes) {
    summary.push([{ v: `No faculty yet: ${report.unassigned.classes} classes, ${report.unassigned.hours} hours`, s: { bold: true, color: '#B91C1C' } }]);
  }

  const detail = [
    ['Date', 'Day', 'Start', 'End', 'Hours', 'Faculty Code', 'Faculty', 'Type', 'Course', 'Batch / block', 'Subject', 'Topic', 'Room', 'Status']
      .map((v) => ({ v, s: head })),
    ...[
      ...report.classes.map((c) => ({
        sort: `${c.date} ${c.start_time}`,
        cells: [formatDate(c.date), weekdayOf(c.date), formatTime(c.start_time), formatTime(c.end_time), hours(minutesOf(c.start_time, c.end_time)),
          codeOf.get(c.faculty_id)?.code ?? '', codeOf.get(c.faculty_id)?.name ?? 'No faculty yet', 'Class', c.course_name, c.batch_name,
          c.subject ?? '', [c.topic_code, c.topic].filter(Boolean).join(' '), c.online ? 'Online' : c.room_name ?? '', c.status === 'done' ? 'Done' : 'Planned'],
      })),
      ...report.events.map((e) => ({
        sort: `${e.date} ${e.start_time}`,
        cells: [formatDate(e.date), weekdayOf(e.date), formatTime(e.start_time), formatTime(e.end_time), hours(minutesOf(e.start_time, e.end_time)),
          codeOf.get(e.faculty_id)?.code ?? '', codeOf.get(e.faculty_id)?.name ?? '', 'Meeting', '', e.title, '', '', '', ''],
      })),
    ].sort((a, b) => a.sort.localeCompare(b.sort)).map((r) => r.cells.map((v) => ({ v, s: cell }))),
  ];

  const file = buildXlsx([
    { name: 'Workload', rows: summary, cols: [12, 22, 9, 9, 10, 9, 10, 10, 30, 40], freeze: { row: 3 }, landscape: true, fitWidth: true },
    {
      name: 'Every class', rows: detail, cols: [12, 6, 9, 9, 7, 11, 20, 9, 14, 16, 10, 30, 14, 9],
      freeze: { row: 1 }, filter: `A1:${cellRef(Math.max(1, detail.length - 1), 13)}`, landscape: true, fitWidth: true,
    },
  ]);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="faculty-workload-${report.from}-to-${report.to}.xlsx"`,
  });
  res.send(file);
});

/* ---------- flow progress and finish forecast ---------- */

const MAX_DAYS = 3 * 366;

function flowOf(batch) {
  const group = db.prepare('SELECT f.* FROM flow_batches fb JOIN flows f ON f.id = fb.flow_id WHERE fb.batch_id = ?').get(batch.id);
  return group ?? db.prepare("SELECT * FROM flows WHERE course_id = ? AND scope = 'course'").get(batch.course_id) ?? null;
}

/**
 * One class teaches one session, as the generator plans it. The finish date is the date
 * of the class that would teach the last unfinished session, counting from today.
 */
export function forecastBatch({ today, timings, startDate, endDate, total, done }) {
  const remaining = total - done;
  if (remaining <= 0) return { status: 'finished', remaining: 0 };
  if (!timings.length) return { status: 'no_times', remaining };
  const perWeek = timings.length;
  const upcoming = classesBetween(timings, { from: today, to: addDays(today, MAX_DAYS), startDate });
  const finishing = upcoming[remaining - 1];
  const result = { remaining, per_week: perWeek, finish_date: finishing?.date ?? null };
  if (!finishing) return { ...result, status: 'beyond' };
  if (!endDate) return { ...result, status: 'no_end' };
  if (endDate < today) return { ...result, status: 'ended', end_date: endDate };
  const before = upcoming.filter((c) => c.date <= endDate).length;
  if (finishing.date > endDate) {
    const short = remaining - before;
    return { ...result, status: 'late', end_date: endDate, short_by: short, late_weeks: Math.ceil(short / perWeek) };
  }
  return { ...result, status: 'on_track', end_date: endDate, spare: before - remaining };
}

reportsRouter.get('/forecast', (req, res) => {
  const today = isIsoDate(req.query.today) ? req.query.today : todayIso();
  const fourWeeksAgo = addDays(today, -28);
  const batches = db.prepare(`
    SELECT b.*, c.name AS course_name FROM batches b JOIN courses c ON c.id = b.course_id`).all()
    .sort((a, b) => collator.compare(a.name, b.name));

  const rows = [];
  const missingFlow = [];
  for (const batch of batches) {
    const flow = flowOf(batch);
    if (!flow) {
      if (!batch.end_date || batch.end_date >= today) missingFlow.push(batch.name);
      continue;
    }
    const sessions = db.prepare('SELECT id, subject, topic_code, topic FROM flow_sessions WHERE flow_id = ? ORDER BY position').all(flow.id);
    const finished = new Set(db.prepare('SELECT session_id FROM batch_session_progress WHERE batch_id = ?').all(batch.id).map((r) => r.session_id));
    const done = sessions.filter((s) => finished.has(s.id)).length;
    const timings = db.prepare('SELECT weekday, start_time, end_time FROM batch_timings WHERE batch_id = ?').all(batch.id);

    const bySubject = new Map();
    for (const s of sessions) {
      const entry = bySubject.get(s.subject) ?? { subject: s.subject, total: 0, done: 0 };
      entry.total += 1;
      if (finished.has(s.id)) entry.done += 1;
      bySubject.set(s.subject, entry);
    }
    const nextIndex = sessions.findIndex((s) => !finished.has(s.id));

    // Recent pace: classes marked done on the schedule in the last four weeks, against
    // the classes the timetable had in that time.
    const doneRecently = db.prepare("SELECT COUNT(*) AS n FROM schedule_classes WHERE batch_id = ? AND status = 'done' AND date >= ? AND date < ?")
      .get(batch.id, fourWeeksAgo, today).n;
    const expectedRecently = classesBetween(timings, { from: fourWeeksAgo, to: addDays(today, -1), startDate: batch.start_date, endDate: batch.end_date }).length;

    rows.push({
      id: batch.id,
      name: batch.name,
      course: batch.course_name,
      flow: flow.name,
      total: sessions.length,
      done,
      next: nextIndex >= 0 ? { no: nextIndex + 1, ...sessions[nextIndex] } : null,
      subjects: [...bySubject.values()].sort((a, b) => b.total - a.total),
      start_date: batch.start_date,
      end_date: batch.end_date,
      done_last_4_weeks: doneRecently,
      timetabled_last_4_weeks: expectedRecently,
      ...forecastBatch({ today, timings, startDate: batch.start_date, endDate: batch.end_date, total: sessions.length, done }),
    });
  }

  const order = { late: 0, beyond: 1, no_times: 2, no_end: 3, on_track: 4, ended: 5, finished: 6 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.late_weeks ?? 0) - (a.late_weeks ?? 0) || (a.spare ?? 0) - (b.spare ?? 0) || collator.compare(a.name, b.name));
  res.json({ today, batches: rows, missing_flow: missingFlow });
});
