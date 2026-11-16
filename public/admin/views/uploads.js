/* The three bulk uploads. Each shows what it read before anything is saved. */

import { h, field, formDialog, save, toast, plural, store } from '../lib.js';
import { parseAssignmentUpload, parseFacultyUpload, parseTimetableUpload } from '../imports.js';
import { formatDate, formatTime, weekdayOf } from '../calendar.js';

function uploadDialog({ title, help, placeholder, parse, summarize, columns, cells, send }) {
  const area = h('textarea', { placeholder, 'aria-label': 'Rows to upload', oninput: update });
  const file = h('input', {
    type: 'file',
    accept: '.csv,.tsv,.txt',
    'aria-label': 'Choose a CSV file',
    onchange: async () => {
      if (!file.files[0]) return;
      area.value = await file.files[0].text();
      update();
    },
  });
  const preview = h('div', { role: 'status' });

  function update() {
    const { rows, problems, notes } = parse(area.value);
    // A message about the previous attempt no longer applies once the rows change.
    const oldError = area.closest('dialog')?.querySelector('.form-error');
    if (oldError) oldError.hidden = true;
    const danger = { class: 'hint', style: 'color:var(--danger)' };
    preview.replaceChildren(
      ...problems.slice(0, 6).map((p) => h('p', danger, p)),
      ...(problems.length > 6 ? [h('p', danger, `…and ${problems.length - 6} more.`)] : []),
      ...notes.slice(0, 3).map((n) => h('p', { class: 'hint' }, n)),
      ...(rows.length
        ? [
            h('p', { class: 'hint' }, h('b', null, summarize(rows))),
            h(
              'div',
              { class: 'table-wrap upload-preview' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, columns.map((c) => h('th', null, c)))),
                h('tbody', null, rows.slice(0, 30).map((r) => h('tr', null, cells(r).map((c) => h('td', null, c))))),
              ),
            ),
            rows.length > 30 ? h('p', { class: 'hint' }, `Showing the first 30 of ${rows.length}.`) : '',
          ]
        : []),
    );
  }

  formDialog({
    title,
    wide: true,
    submitLabel: 'Save',
    body: [
      field('Paste rows copied from Excel or Google Sheets', area, help),
      field('Or choose a CSV file', file),
      preview,
    ],
    onSubmit: async () => {
      const { rows, problems } = parse(area.value);
      if (problems.length) throw new Error('Fix the problems listed above first. Nothing has been saved.');
      if (!rows.length) throw new Error('Paste or choose at least one row, with its heading row.');
      await send(rows);
    },
  });
}

const orDash = (value) => value || '–';

export function facultyUpload() {
  uploadDialog({
    title: 'Upload faculty',
    placeholder: 'Faculty Code\tName\tCourses\tSubjects\tTopics\tWeek-offs\nRS01\tRiya Shah\tCAT, CMAT\tQA, DILR\tArithmetic; QA 1.5A\tSun, Wed',
    help: 'Faculty Code is needed; Name is needed for anyone new. Separate list items with commas, and topics with semicolons if their names contain commas. A code already in the program updates that faculty, and a column you leave out stays unchanged. Several rows with the same code are combined.',
    parse: parseFacultyUpload,
    summarize: (rows) => {
      const known = new Set(store.state.faculties.map((f) => f.code.toLowerCase()));
      const updated = rows.filter((r) => known.has(r.code.toLowerCase())).length;
      return `Ready: ${rows.length - updated} new, ${updated} to update`;
    },
    columns: ['Code', 'Name', 'Courses', 'Subjects', 'Topics', 'Week-offs'],
    cells: (r) => [r.code, orDash(r.name), orDash(r.courses?.join(', ')), orDash(r.subjects?.join(', ')), orDash(r.topics?.join('; ')), r.week_offs ? r.week_offs.join(', ') || 'None' : '–'],
    send: async (rows) => {
      const { added, updated } = await save('POST', '/faculties/import', { rows });
      toast(`Faculty saved: ${added} added, ${updated} updated`);
    },
  });
}

export function assignmentUpload() {
  uploadDialog({
    title: 'Upload batch faculty',
    placeholder: 'Batch\tSlot\tFaculty Code\tSubstitutes\n26CA02\tMentor\tPD04\t\n26CA02\tQA1\tRS01\tAM02, PD04',
    help: 'One row per batch and slot. Batch, Slot and Faculty Code are needed; Substitutes are in order of preference, separated by commas. Only the slots you list change. Leave Faculty Code blank to clear a slot’s primary faculty.',
    parse: parseAssignmentUpload,
    summarize: (rows) => `Ready: ${plural(rows.length, 'slot')} across ${plural(new Set(rows.map((r) => r.batch.toLowerCase())).size, 'batch', 'batches')}`,
    columns: ['Batch', 'Slot', 'Primary', 'Substitutes'],
    cells: (r) => [r.batch, r.slot, orDash(r.faculty), orDash(r.substitutes.join(', '))],
    send: async (rows) => {
      const result = await save('POST', '/batches/assignments/import', { rows });
      toast(`Saved ${plural(result.updated, 'slot')} across ${plural(result.batches, 'batch', 'batches')}`);
      if (result.outside_course.length) {
        toast(`Not listed for this batch’s course: ${result.outside_course.slice(0, 4).join('; ')}${result.outside_course.length > 4 ? '…' : ''}. Saved anyway.`, true);
      }
    },
  });
}

export function timetableUpload() {
  uploadDialog({
    title: 'Upload batch timetable',
    placeholder: 'Batch\tWeekdays\tStart Time\tEnd Time\tStart Date\tEnd Date\n26CA02\tMon, Wed\t6:00 PM\t8:00 PM\t1/7/2026\t\n26CA02\tSat\t9:00 AM\t12:00 PM\t\t',
    help: 'Use one row per set of hours, so Mon/Wed evenings and Saturday mornings are two rows. Weekdays can be “Mon, Wed” or “Mon-Fri”. Times need AM or PM unless they’re 24-hour. Dates are read day first. Each batch listed gets exactly these hours in place of its old ones.',
    parse: parseTimetableUpload,
    summarize: (rows) => `Ready: ${plural(rows.length, 'row')} for ${plural(new Set(rows.map((r) => r.batch.toLowerCase())).size, 'batch', 'batches')}`,
    columns: ['Batch', 'Weekdays', 'Hours', 'Start date', 'End date'],
    cells: (r) => {
      const dated = (iso) => (iso ? `${formatDate(iso)} (${weekdayOf(iso)})` : '–');
      return [r.batch, r.days.join(', '), r.start && r.end ? `${formatTime(r.start)} – ${formatTime(r.end)}` : '–', dated(r.start_date), dated(r.end_date)];
    },
    send: async (rows) => {
      const result = await save('POST', '/batches/timetable/import', { rows });
      toast(`Timetable saved for ${plural(result.batches, 'batch', 'batches')}`);
    },
  });
}
