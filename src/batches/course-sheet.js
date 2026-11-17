/*
 * The course faculty sheet: one row per batch with its days, hours and faculty, so a
 * whole course can be filled in at once and uploaded. Columns follow the subjects of the
 * course's master flows: QA1 is the QA primary and QA2 its substitute.
 */

import { DAY_CHOICES, dayChoiceOf, parseClock, parseDayChoice, readHeading } from '../../public/admin/course-sheet.js';
import { groupTimings } from '../../public/admin/calendar.js';
import { splitCells } from '../../public/admin/views/parse-sessions.js';
import { buildXlsx, columnName } from '../xlsx.js';
import { readXlsx } from '../xlsx-read.js';

export const MENTOR = 'Mentor';
const isMentor = (subject) => subject.toLowerCase() === MENTOR.toLowerCase();

/** The batch's slots that a sheet subject stands for: QA covers a QA slot, or QA1, QA2... */
export function slotsFor(subject, slots) {
  const key = subject.toLowerCase();
  const numbered = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\d+$`, 'i');
  return slots.filter((s) => {
    const role = String(s.role ?? '').toLowerCase();
    const subj = String(s.subject ?? '').toLowerCase();
    if (isMentor(subject)) return role === key || subj === key;
    return subj === key || role === key || (numbered.test(role) && (!subj || subj === key));
  });
}

const S = {
  head: { bold: true, fill: '#E7E6E1', border: true, wrap: true, v: 'center' },
  faculty: { bold: true, fill: '#DBEAFE', border: true, wrap: true, v: 'center', h: 'center' },
  sub: { bold: true, fill: '#EDE9FE', border: true, wrap: true, v: 'center', h: 'center' },
  cell: { border: true, borderColor: '#D9D9D9' },
  time: { border: true, borderColor: '#D9D9D9', text: true },
  note: { color: '#444444', wrap: true, v: 'top' },
};

/**
 * course: { name }, subjects: ['QA', 'VA', ...] (Mentor is always first),
 * batches: [{ name, timings, slots: [{ role, subject, faculty_code, substitute_codes }] }],
 * faculties: [{ code, name, subjects, week_offs }].
 */
export function buildCourseSheet({ course, subjects, batches, faculties }) {
  const columns = [MENTOR, ...subjects.filter((s) => !isMentor(s))];
  const header = [
    { v: 'Batch', s: S.head }, { v: 'Days', s: S.head }, { v: 'Start time (HH:MM)', s: S.head }, { v: 'End time (HH:MM)', s: S.head },
    ...columns.flatMap((subject) => (isMentor(subject)
      ? [{ v: MENTOR, s: S.faculty }]
      : [{ v: `${subject}1`, s: S.faculty }, { v: `${subject}2`, s: S.sub }])),
  ];
  const width = header.length;

  const rows = [header];
  for (const batch of batches) {
    const faculty = columns.flatMap((subject) => {
      const found = slotsFor(subject, batch.slots);
      const primary = found[0]?.faculty_code ?? '';
      if (isMentor(subject)) return [primary];
      // A second slot of the subject (QA2 under the old naming) reads as the substitute.
      const second = found[0]?.substitute_codes?.[0] ?? found[1]?.faculty_code ?? '';
      return [primary, second];
    });
    const groups = groupTimings(batch.timings);
    (groups.length ? groups : [null]).forEach((g, i) => {
      rows.push([
        batch.name,
        g ? dayChoiceOf(g.days) : '',
        g?.start_time ?? '',
        g?.end_time ?? '',
        // Faculty go on the batch's first row; extra rows are only for more class times.
        ...(i === 0 ? faculty : faculty.map(() => '')),
      ]);
    });
  }
  const last = rows.length + 40; // room to add rows, with the same formats
  while (rows.length < last) rows.push(Array(width).fill(''));
  for (const row of rows.slice(1)) {
    row.forEach((v, c) => { row[c] = { v, s: c === 2 || c === 3 ? S.time : S.cell }; });
  }

  const codesRows = [
    ['Faculty Code', 'Name', 'Subjects', 'Week-offs'].map((v) => ({ v, s: S.head })),
    ...faculties.map((f) => [f.code, f.name, f.subjects.join(', '), f.week_offs.join(', ')]),
  ];
  const facultyRange = `'Faculty codes'!$A$2:$A$${Math.max(2, faculties.length + 1)}`;

  const help = [
    `How to fill the ${course.name} faculty sheet`,
    '',
    'One row per batch. Batch is the batch code, as in the student sheet.',
    `Days: choose MWF (${DAY_CHOICES.MWF.join(', ')}), TTS (${DAY_CHOICES.TTS.join(', ')}) or Sunday. Other days can be typed, such as "Mon, Thu".`,
    'Start time and End time: 24-hour HH:MM, such as 07:00 or 18:30.',
    'A batch with two classes a day, or different hours on different days, gets one more row per set of hours: repeat the batch code and fill only Days and the times.',
    `Faculty columns take a Faculty Code (listed on the Faculty codes tab). ${MENTOR} is the batch mentor.`,
    'For each subject, column 1 is the primary faculty and column 2 the substitute, who takes the class when the primary is on week-off or busy.',
    'A faculty cell left empty means nobody for that slot. Days and times left empty leave the batch’s current hours as they are.',
    'Upload the filled file on the Batches page, under Course faculty sheet. You’ll see every change before it is saved.',
  ];

  return buildXlsx([
    {
      name: `${course.name} faculty`,
      rows,
      cols: [14, 10, 12, 12, ...header.slice(4).map(() => 11)],
      rowHeights: [32],
      freeze: { row: 1, col: 1 },
      validations: [
        { sqref: `B2:B${last}`, list: Object.keys(DAY_CHOICES), prompt: 'MWF, TTS or Sunday', error: 'Choose MWF, TTS or Sunday, or type days such as Mon, Thu.' },
        { sqref: `${columnName(4)}2:${columnName(width - 1)}${last}`, source: facultyRange, error: 'That code is not on the Faculty codes tab.' },
      ],
    },
    { name: 'Faculty codes', rows: codesRows, cols: [14, 24, 24, 14], freeze: { row: 1 } },
    { name: 'How to fill', rows: help.map((v, i) => [{ v, s: i === 0 ? { bold: true, size: 13 } : S.note }]), cols: [110] },
  ]);
}

/** Cell rows from an uploaded .xlsx (the sheet with a Batch heading) or CSV text. */
export function sheetRows(buffer, fileName = '') {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    const sheets = readXlsx(buffer);
    const found = sheets.find((s) => s.rows.some((r) => r.some((c) => readHeading(c)?.field === 'batch')));
    if (!found) throw new Error('No sheet in that file has a Batch heading. Use the course faculty template.');
    return found.rows;
  }
  if (/\.xlsx?$/i.test(fileName)) throw new Error('That file is not a readable .xlsx spreadsheet.');
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return splitCells(text, text.includes('\t') ? '\t' : ',');
}

/**
 * Reads the filled sheet into one entry per batch code, without checking codes against
 * the program. Problems name the spreadsheet row.
 */
export function readCourseSheet(rows) {
  const problems = [];
  const headerIndex = rows.findIndex((r) => r.some((c) => readHeading(c)?.field === 'batch'));
  if (headerIndex < 0) return { batches: [], subjects: [], problems: ['Include the heading row, starting with Batch.'] };

  const fields = rows[headerIndex].map((c) => readHeading(c));
  const subjects = new Map(); // lower-case subject -> { subject, ranks: Set }
  fields.forEach((f, i) => {
    if (!f?.subject) return;
    const key = f.subject.toLowerCase();
    if (!subjects.has(key)) subjects.set(key, { subject: f.subject, ranks: new Set() });
    const entry = subjects.get(key);
    if (entry.ranks.has(f.rank)) problems.push(`The heading "${rows[headerIndex][i]}" appears twice.`);
    entry.ranks.add(f.rank);
  });
  for (const field of ['days', 'start', 'end']) {
    if (!fields.some((f) => f?.field === field)) problems.push(`The ${field === 'days' ? 'Days' : field === 'start' ? 'Start time' : 'End time'} column is missing.`);
  }

  const batches = new Map();
  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    const line = headerIndex + offset + 2;
    const value = (i) => String(cells[i] ?? '').trim();
    if (!cells.some((c) => String(c ?? '').trim())) return;
    const get = (field) => value(fields.findIndex((f) => f?.field === field));
    const code = get('batch');
    if (!code) {
      problems.push(`Row ${line}: the batch code is missing.`);
      return;
    }
    const key = code.toLowerCase().replace(/\s+/g, '');
    if (!batches.has(key)) batches.set(key, { code, lines: [], timings: [], faculty: new Map() });
    const entry = batches.get(key);
    entry.lines.push(line);

    const [days, start, end] = [get('days'), get('start'), get('end')];
    if (days || start || end) {
      const d = parseDayChoice(days);
      const s = parseClock(start);
      const e = parseClock(end);
      if (!days) problems.push(`Row ${line} (${code}): choose the Days for these hours.`);
      else if (d.error) problems.push(`Row ${line} (${code}): ${d.error}.`);
      if (!start || !end) problems.push(`Row ${line} (${code}): enter both a start and an end time, as HH:MM.`);
      else if (s.error || e.error) problems.push(`Row ${line} (${code}): ${(s.error ?? e.error)}; use 24-hour HH:MM, such as 18:30.`);
      if (d.days && s.time && e.time) for (const weekday of d.days) entry.timings.push({ weekday, start_time: s.time, end_time: e.time, line });
    }

    fields.forEach((f, i) => {
      if (!f?.subject) return;
      const slot = `${f.subject.toLowerCase()}|${f.rank}`;
      const v = value(i);
      if (!v) return;
      const before = entry.faculty.get(slot);
      if (before && before.toLowerCase() !== v.toLowerCase()) {
        problems.push(`${code}: ${rows[headerIndex][i]} is ${before} on one row and ${v} on another.`);
      }
      entry.faculty.set(slot, v);
    });
  });

  return {
    batches: [...batches.values()],
    subjects: [...subjects.values()].map((s) => ({ subject: s.subject, ranks: [...s.ranks].sort() })),
    problems,
  };
}
