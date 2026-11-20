/*
 * Reads the three bulk uploads: faculty, batch faculty and batch timetable. Columns are
 * found by heading, so their order doesn't matter and extra columns are ignored. No page
 * or server code here; the server checks codes against real data when it receives them.
 */

import { splitCells } from './views/parse-sessions.js';
import { parseDateText, parseDays, parseTime, parseTimeRange } from './calendar.js';

const headingKey = (text) => text.toLowerCase().replace(/[^a-z]/g, '');
const splitList = (text) => text.split(/\s*[,;|\n]\s*/).map((s) => s.trim()).filter(Boolean);

/** Topic names can contain commas, so a semicolon or | wins if the cell uses one. */
export function splitTopics(text) {
  const separator = /[;|\n]/.test(text) ? /\s*[;|\n]\s*/ : /\s*,\s*/;
  return text.split(separator).map((s) => s.trim()).filter(Boolean);
}

function readTable(text, columns, required) {
  const separator = text.includes('\t') ? '\t' : ',';
  const rows = splitCells(text, separator).map((r) => r.map((c) => c.trim()));
  const needed = Object.keys(required);
  const headerIndex = rows.findIndex((r) => {
    const fields = r.map((c) => columns[headingKey(c)]);
    return needed.every((f) => fields.includes(f));
  });
  if (headerIndex < 0) {
    const names = Object.values(required).join(', ');
    return { records: [], problems: text.trim() ? [`Include the heading row, with at least: ${names}.`] : [], present: new Set() };
  }
  const fieldAt = rows[headerIndex].map((c) => columns[headingKey(c)]);
  const records = [];
  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (!cells.some(Boolean)) return;
    const record = { line: headerIndex + offset + 2 };
    cells.forEach((value, i) => {
      const field = fieldAt[i];
      if (!field) return;
      // "Substitute 1" and "Substitute 2" both add to the same list.
      record[field] = record[field] && value ? `${record[field]}, ${value}` : record[field] || value;
    });
    records.push(record);
  });
  return { records, problems: [], present: new Set(fieldAt.filter(Boolean)) };
}

/* ---------- faculty ---------- */

const FACULTY_COLUMNS = {
  facultycode: 'code', code: 'code', facultyid: 'code', uid: 'code',
  name: 'name', facultyname: 'name',
  course: 'courses', courses: 'courses', coursesteach: 'courses', coursesteaches: 'courses', coursescanteach: 'courses', coursestheyteach: 'courses', coursecanteach: 'courses',
  subject: 'subjects', subjects: 'subjects', subjectscanteach: 'subjects', subjectstheycanteach: 'subjects',
  topic: 'topics', topics: 'topics', topicscanteach: 'topics', topicstheycanteach: 'topics',
  email: 'email', emailid: 'email', mail: 'email', gmail: 'email', emailaddress: 'email', calendaremail: 'email',
  weekoff: 'week_offs', weekoffs: 'week_offs', weeklyoff: 'week_offs', weeklyoffs: 'week_offs', off: 'week_offs', offday: 'week_offs', offdays: 'week_offs',
};

/**
 * One row per faculty, or several rows per faculty (one per course, say), which are
 * combined. A column left out of the file leaves that detail unchanged on the server.
 */
export function parseFacultyUpload(text) {
  const { records, problems, present } = readTable(text, FACULTY_COLUMNS, { code: 'Faculty Code' });
  const byCode = new Map();
  const notes = [];
  for (const r of records) {
    if (!r.code) {
      problems.push(`Line ${r.line}: Faculty Code is missing.`);
      continue;
    }
    const key = r.code.toLowerCase();
    if (!byCode.has(key)) byCode.set(key, { code: r.code, name: '', email: '', courses: [], subjects: [], topics: [], week_offs: [] });
    const row = byCode.get(key);
    if (r.name && row.name && r.name.toLowerCase() !== row.name.toLowerCase()) {
      problems.push(`Line ${r.line}: ${r.code} is also named "${row.name}". One code can only be one person.`);
    }
    row.name ||= r.name ?? '';
    const email = String(r.email ?? '').trim();
    if (email && row.email && email.toLowerCase() !== row.email.toLowerCase()) problems.push(`Line ${r.line}: ${r.code} already has the email ${row.email}.`);
    if (email && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(email)) problems.push(`Line ${r.line}: "${email}" is not an email address.`);
    row.email ||= email;
    row.courses.push(...splitList(r.courses ?? ''));
    row.subjects.push(...splitList(r.subjects ?? ''));
    row.topics.push(...splitTopics(r.topics ?? ''));
    const { days, bad } = parseDays(r.week_offs);
    if (bad.length) problems.push(`Line ${r.line}: "${bad.join(', ')}" is not a day of the week.`);
    row.week_offs.push(...days);
  }
  const unique = (list) => [...new Map(list.map((v) => [v.toLowerCase(), v])).values()];
  const rows = [...byCode.values()].map((row) => {
    const result = { code: row.code, name: row.name };
    // An Email column with an empty cell clears it; no Email column leaves it as it is.
    if (present.has('email')) result.email = row.email;
    for (const field of ['courses', 'subjects', 'topics', 'week_offs']) {
      if (present.has(field)) result[field] = unique(row[field]);
    }
    return result;
  });
  return { rows, problems, notes };
}

/* ---------- which faculty teaches a batch ---------- */

const ASSIGNMENT_COLUMNS = {
  batch: 'batch', batchcode: 'batch', batchname: 'batch',
  slot: 'slot', role: 'slot', slotname: 'slot', type: 'slot',
  subject: 'subject',
  faculty: 'faculty', facultycode: 'faculty', primary: 'faculty', primaryfaculty: 'faculty', primaryfacultycode: 'faculty',
  substitute: 'substitutes', substitutes: 'substitutes', substitution: 'substitutes', substitutions: 'substitutes', substitutefaculty: 'substitutes', sub: 'substitutes', subs: 'substitutes', substitutecode: 'substitutes', substitutecodes: 'substitutes',
};

/** One row per batch and slot: Batch, Slot, Faculty Code, Substitutes. */
export function parseAssignmentUpload(text) {
  const { records, problems } = readTable(text, ASSIGNMENT_COLUMNS, { batch: 'Batch', slot: 'Slot', faculty: 'Faculty Code' });
  const rows = [];
  for (const r of records) {
    if (!r.batch || !r.slot) {
      problems.push(`Line ${r.line}: needs both a batch and a slot.`);
      continue;
    }
    rows.push({
      batch: r.batch,
      slot: r.slot,
      subject: r.subject ?? '',
      faculty: r.faculty ?? '',
      substitutes: (r.substitutes ?? '').split(/\s*[,;|/]\s*/).filter(Boolean),
    });
  }
  return { rows, problems, notes: [] };
}

/* ---------- when a batch meets ---------- */

const TIMETABLE_COLUMNS = {
  batch: 'batch', batchcode: 'batch', batchname: 'batch',
  day: 'days', days: 'days', weekday: 'days', weekdays: 'days',
  starttime: 'start', start: 'start', from: 'start', fromtime: 'start',
  endtime: 'end', end: 'end', to: 'end', totime: 'end',
  time: 'range', timing: 'range', timings: 'range',
  startdate: 'start_date', batchstartdate: 'start_date', fromdate: 'start_date',
  enddate: 'end_date', batchenddate: 'end_date', todate: 'end_date',
};

/** One row per set of hours. Mon/Wed evenings and Saturday mornings are two rows. */
export function parseTimetableUpload(text) {
  const { records, problems } = readTable(text, TIMETABLE_COLUMNS, { batch: 'Batch', days: 'Weekdays' });
  const rows = [];
  for (const r of records) {
    const say = (message) => problems.push(`Line ${r.line}: ${message}.`);
    if (!r.batch) {
      say('the batch is missing');
      continue;
    }
    const { days, bad } = parseDays(r.days);
    if (bad.length) say(`"${bad.join(', ')}" is not a day of the week`);
    if (!days.length && !bad.length) say('needs at least one weekday');

    let start;
    let end;
    if (r.range) {
      const range = parseTimeRange(r.range);
      if (range.error) say(range.error);
      ({ start, end } = range);
    } else if (r.start && r.end) {
      const [from, to] = [parseTime(r.start), parseTime(r.end)];
      if (from.error) say(from.error);
      if (to.error) say(to.error);
      [start, end] = [from.time, to.time];
    } else {
      say('needs a start and end time, or a Timing such as 6:00 PM - 8:00 PM');
    }
    if (start && end && start >= end) say(`the class must end after it starts (${r.range ?? `${r.start} to ${r.end}`})`);

    const row = { batch: r.batch, days, start, end };
    for (const [field, label] of [['start_date', 'start date'], ['end_date', 'end date']]) {
      if (!r[field]) continue;
      row[field] = parseDateText(r[field]);
      if (!row[field]) say(`"${r[field]}" is not a ${label} that could be read`);
    }
    rows.push(row);
  }
  return { rows, problems, notes: [] };
}
