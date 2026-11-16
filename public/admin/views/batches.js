import {
  h, store, field, pageHead, emptyState, button, formDialog, deleteDialog,
  save, courseName, plural,
} from '../lib.js';
import {
  WEEK, addDays, classesBetween, describeTiming, formatDate, formatTime, groupTimings, todayIso,
} from '../calendar.js';
import { assignmentUpload, timetableUpload } from './uploads.js';

const filter = { course: '', year: '' };

const sameText = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/* ---------- creating batches ---------- */

function createDialog() {
  const { courses } = store.state;
  const preset = Number(filter.course) || courses[0]?.id;
  const course = h('select', { required: true, value: preset }, courses.map((c) => h('option', { value: c.id }, c.name)));
  const code = h('input', { required: true, maxLength: 60, placeholder: 'e.g. 27CA05' });
  const year = h('input', { type: 'number', min: 2000, max: 2100, placeholder: 'From the code' });

  formDialog({
    title: 'Add a planned batch',
    submitLabel: 'Add batch',
    body: [
      h('p', { class: 'hint', style: 'margin:0 0 14px' }, 'Batches in the student sheet appear here by themselves. Use this only for a batch with no students in the sheet yet, and use the code the sheet will use, so its students link up.'),
      field('Course', course),
      h('div', { class: 'field-row' }, field('Batch code', code), field('Year (optional)', year)),
    ],
    onSubmit: () =>
      save('POST', '/batches', { course_id: Number(course.value), code: code.value, year: year.value }, `${code.value.trim()} added. Assign faculty next.`),
  });
}

/* ---------- batch codes that need a decision ---------- */

function attentionPanel() {
  const { batches_waiting: waiting, batches_mismatched: mismatched } = store.state;
  if (!waiting.length && !mismatched.length) return null;
  return h(
    'section',
    { class: 'panel attention' },
    waiting.length
      ? [
          h('h2', { class: 'section' }, `${plural(waiting.length, 'batch code')} in the sheet can’t be placed in a course yet`),
          h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'Their students’ Current Variant isn’t ticked into any course yet. Tick it on the Courses page and they’ll appear.'),
          h('ul', { class: 'attention-list' }, waiting.map((w) =>
            h('li', null, h('span', { class: 'code' }, w.code), ` · ${plural(w.active, 'active student')} · `, h('span', { class: 'muted' }, w.variants.replaceAll(',', ', '))))),
          h('a', { class: 'btn small', href: '#/courses' }, 'Go to courses'),
        ]
      : null,
    mismatched.length
      ? [
          h('h2', { class: 'section' }, `${plural(mismatched.length, 'batch', 'batches')} with students from another course`),
          h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'These are left as they are, so no assignments are lost. Check the students’ Current Variant in the sheet.'),
          h('ul', { class: 'attention-list' }, mismatched.map((m) =>
            h('li', null, h('span', { class: 'code' }, m.code), ` · ${plural(m.students, 'student')} · `, h('span', { class: 'muted' }, m.variants.replaceAll(',', ', '))))),
        ]
      : null,
  );
}

/* ---------- assigning faculty ---------- */

function teaches(faculty, courseId, subject) {
  if (!faculty.course_ids.includes(courseId)) return false;
  return !subject?.trim() || faculty.subjects.some((s) => sameText(s, subject));
}

function facultyLabel(f) {
  const off = f.week_offs.length ? ` · off ${f.week_offs.join(', ')}` : '';
  return `${f.name} (${f.code})${off}`;
}

function facultyOptions(slot, courseId, exclude = []) {
  const faculties = store.state.faculties.filter((f) => !exclude.includes(f.id));
  const matching = faculties.filter((f) => teaches(f, courseId, slot.subject));
  const others = faculties.filter((f) => !teaches(f, courseId, slot.subject));
  const option = (f) => h('option', { value: f.id }, facultyLabel(f));
  const subjectPart = slot.subject?.trim() ? ` · ${slot.subject.trim()}` : '';
  return [
    matching.length ? h('optgroup', { label: `Teaches ${courseName(courseId)}${subjectPart}` }, matching.map(option)) : null,
    others.length ? h('optgroup', { label: 'Other faculty' }, others.map(option)) : null,
  ];
}

function facultySelect(slot, courseId, onPick) {
  return h(
    'select',
    {
      'aria-label': `Faculty for ${slot.role || 'this slot'}`,
      value: slot.faculty_id ?? '',
      onchange: (e) => onPick(e.target.value ? Number(e.target.value) : null),
    },
    h('option', { value: '' }, 'Unfilled'),
    facultyOptions(slot, courseId),
  );
}

function substituteRow(slot, courseId, redraw) {
  const facultyOf = (id) => store.state.faculties.find((f) => f.id === id);
  const taken = [slot.faculty_id, ...slot.substitute_ids].filter(Boolean);
  const options = facultyOptions(slot, courseId, taken).filter(Boolean);
  return h(
    'div',
    { class: 'sub-row' },
    h('span', { class: 'sub-label' }, 'Substitutes'),
    slot.substitute_ids.map((id, i) => {
      const f = facultyOf(id);
      return h(
        'span',
        { class: 'tag', title: f ? facultyLabel(f) : '' },
        `${i + 1}. ${f?.code ?? 'Removed'}`,
        h('button', {
          type: 'button',
          'aria-label': `Remove substitute ${f?.code ?? ''} from ${slot.role || 'this slot'}`,
          onclick: () => {
            slot.substitute_ids.splice(i, 1);
            redraw();
          },
        }, '×'),
      );
    }),
    options.length
      ? h(
          'select',
          {
            class: 'sub-add',
            'aria-label': `Add substitute for ${slot.role || 'this slot'}`,
            onchange: (e) => {
              if (!e.target.value) return;
              slot.substitute_ids.push(Number(e.target.value));
              redraw();
            },
          },
          h('option', { value: '' }, 'Add substitute…'),
          options,
        )
      : null,
  );
}

function batchDialog(batch) {
  const fromSheet = batch.active_students > 0;
  const name = h('input', { required: true, maxLength: 60, value: batch.name, readOnly: fromSheet });
  const year = h('input', { type: 'number', required: true, min: 2000, max: 2100, value: batch.year });
  const startDate = h('input', { type: 'date', 'aria-label': 'Batch start date', value: batch.start_date ?? '', onchange: drawUpcoming });
  const endDate = h('input', { type: 'date', 'aria-label': 'Batch end date', value: batch.end_date ?? '', onchange: drawUpcoming });
  const slots = batch.assignments.map((a) => ({ ...a, subject: a.subject ?? '', substitute_ids: [...a.substitute_ids] }));
  const rowsEl = h('div', { class: 'slot-rows' });

  // One row per set of hours, so "Mon, Wed 6-8 pm" is one row, not two.
  const classTimes = groupTimings(batch.timings).map((g) => ({ days: new Set(g.days), start: g.start_time, end: g.end_time }));
  const timesEl = h('div', { class: 'time-rows' });
  const upcomingEl = h('div', { class: 'upcoming', role: 'status' });

  const batchDays = () => WEEK.filter((d) => classTimes.some((t) => t.days.has(d)));

  function flatTimings() {
    return classTimes
      .filter((t) => t.days.size && t.start && t.end)
      .flatMap((t) => [...t.days].map((weekday) => ({ weekday, start_time: t.start, end_time: t.end })));
  }

  function warningsFor(slot) {
    const f = store.state.faculties.find((x) => x.id === slot.faculty_id);
    if (!f) return [];
    const warnings = [];
    if (!teaches(f, batch.course_id, slot.subject)) {
      warnings.push(f.course_ids.includes(batch.course_id)
        ? `${f.name} isn't listed for ${slot.subject.trim()}.`
        : `${f.name} isn't listed as teaching ${courseName(batch.course_id)}.`);
    }
    const clash = batchDays().filter((d) => f.week_offs.includes(d));
    if (clash.length) {
      const cover = store.state.faculties.filter((x) => slot.substitute_ids.includes(x.id) && !clash.some((d) => x.week_offs.includes(d)));
      const coverText = cover.length ? ` ${cover[0].name} can cover.` : ' No substitute here covers it.';
      warnings.push(`${f.name} has ${clash.join(', ')} off, and this batch meets then.${coverText}`);
    }
    return warnings;
  }

  function draw() {
    const noFaculty = !store.state.faculties.length;
    rowsEl.replaceChildren(
      h('div', { class: 'slot-row with-faculty slot-head' }, h('span', null, 'Slot'), h('span', null, 'Subject'), h('span', null, 'Primary faculty'), h('span', { style: 'width:28px' })),
      ...slots.map((slot, i) =>
        h(
          'div',
          { class: 'slot-row with-faculty' },
          h('input', { 'aria-label': `Slot ${i + 1} name`, placeholder: 'e.g. QA1', maxLength: 40, value: slot.role, required: true, oninput: (e) => (slot.role = e.target.value) }),
          h('input', { 'aria-label': `Slot ${i + 1} subject`, list: 'subject-list', placeholder: 'Optional', maxLength: 60, value: slot.subject,
            oninput: (e) => (slot.subject = e.target.value),
            onchange: () => draw() }),
          facultySelect(slot, batch.course_id, (id) => {
            slot.faculty_id = id;
            slot.substitute_ids = slot.substitute_ids.filter((s) => s !== id);
            draw();
          }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${slot.role || 'slot'}`, onclick: () => { slots.splice(i, 1); draw(); } }, '×'),
          substituteRow(slot, batch.course_id, draw),
          warningsFor(slot).map((w) => h('p', { class: 'slot-warn' }, w)),
        ),
      ),
    );
    if (noFaculty) rowsEl.append(h('p', { class: 'hint' }, 'No faculty added yet. Add them under Faculties, then assign them here.'));
  }

  function drawUpcoming() {
    const timings = flatTimings();
    const today = todayIso();
    const [from, to] = [startDate.value, endDate.value];
    if (!timings.length) {
      upcomingEl.replaceChildren(h('p', { class: 'hint' }, 'Add class times to see the upcoming classes.'));
      return;
    }
    if (to && to < today) {
      upcomingEl.replaceChildren(h('p', { class: 'hint' }, `This batch ended on ${formatDate(to)}.`));
      return;
    }
    const classes = classesBetween(timings, { from: today, to: addDays(from && from > today ? from : today, 28), startDate: from, endDate: to }).slice(0, 6);
    upcomingEl.replaceChildren(
      h('span', { class: 'label' }, 'Next classes'),
      classes.length
        ? h('ul', { class: 'upcoming-list' }, classes.map((c) => h('li', null, `${c.weekday}, ${formatDate(c.date)}`, h('span', { class: 'muted' }, ` · ${formatTime(c.start_time)} – ${formatTime(c.end_time)}`))))
        : h('p', { class: 'hint' }, 'No classes fall in the next four weeks.'),
    );
  }

  function drawTimes() {
    timesEl.replaceChildren(
      ...classTimes.map((t, i) =>
        h(
          'div',
          { class: 'time-row' },
          h(
            'div',
            { class: 'check-group day-group', role: 'group', 'aria-label': `Class time ${i + 1} days` },
            WEEK.map((day) =>
              h('label', { class: 'check day-check' },
                h('input', {
                  type: 'checkbox',
                  checked: t.days.has(day),
                  onchange: (e) => {
                    if (e.target.checked) t.days.add(day);
                    else t.days.delete(day);
                    draw();
                    drawUpcoming();
                  },
                }),
                day)),
          ),
          h('input', { type: 'time', 'aria-label': `Class time ${i + 1} start`, value: t.start, onchange: (e) => { t.start = e.target.value; drawUpcoming(); } }),
          h('span', { class: 'muted' }, 'to'),
          h('input', { type: 'time', 'aria-label': `Class time ${i + 1} end`, value: t.end, onchange: (e) => { t.end = e.target.value; drawUpcoming(); } }),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Remove class time ${i + 1}`,
            onclick: () => {
              classTimes.splice(i, 1);
              drawTimes();
              draw();
              drawUpcoming();
            },
          }, '×'),
        ),
      ),
    );
  }

  draw();
  drawTimes();
  drawUpcoming();

  formDialog({
    title: `${batch.name}`,
    wide: true,
    body: [
      h('div', { class: 'field-row' }, field('Batch code', name, fromSheet ? 'Comes from the student sheet.' : null), field('Year', year)),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, 'Timetable'),
        h('div', { class: 'field-row' }, field('Start date', startDate), field('End date (optional)', endDate)),
        timesEl,
        button('Add class time', () => { classTimes.push({ days: new Set(), start: '', end: '' }); drawTimes(); }, 'small'),
        upcomingEl),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, 'Faculty assignment'),
        rowsEl,
        button('Add slot', () => { slots.push({ role: '', subject: '', faculty_id: null, substitute_ids: [] }); draw(); rowsEl.lastChild.querySelector('input').focus(); }, 'small'),
        h('p', { class: 'hint' }, 'Changes to slots here affect this batch only. Faculty who match the course and subject are listed first. Substitutes are in order of preference.'),
      ),
    ],
    onSubmit: async () => {
      for (const t of classTimes) {
        const anything = t.days.size || t.start || t.end;
        if (anything && (!t.days.size || !t.start || !t.end)) throw new Error('Each class time needs at least one day, a start and an end.');
      }
      await save('PUT', `/batches/${batch.id}`, {
        name: name.value,
        year: Number(year.value),
        assignments: slots,
        timings: flatTimings(),
        start_date: startDate.value,
        end_date: endDate.value,
      }, `${name.value.trim()} saved`);
    },
  });
}

/* ---------- the batch tables ---------- */

function slotTitle(primary, slot) {
  const subs = slot.substitute_ids.map((id) => store.state.faculties.find((x) => x.id === id)?.code).filter(Boolean);
  return subs.length ? `${primary.name}
Substitutes: ${subs.join(', ')}` : primary.name;
}

function batchTable(group) {
  const { faculties } = store.state;
  const course = store.state.courses.find((c) => c.id === group.courseId);
  const roles = [...course.roles.map((r) => r.name)];
  const seen = new Set(roles.map((r) => r.toLowerCase()));
  for (const b of group.batches) {
    for (const a of b.assignments) {
      if (!seen.has(a.role.toLowerCase())) {
        seen.add(a.role.toLowerCase());
        roles.push(a.role);
      }
    }
  }

  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'matrix' },
      h('thead', null, h('tr', null,
        h('th', null, 'Batch'),
        h('th', null, 'Active students'),
        h('th', { style: 'text-align:left' }, 'Timetable'),
        roles.map((r) => h('th', null, r)),
        h('th', null, 'Master flow'),
        h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
      h(
        'tbody',
        null,
        group.batches.map((b) =>
          h(
            'tr',
            null,
            h('td', null, h('button', { class: 'batch-open', type: 'button', onclick: () => batchDialog(b) }, b.name)),
            h('td', null, b.student_count
              ? h('a', { href: `#/students?batch=${encodeURIComponent(b.name)}`, title: `${b.student_count} in the sheet, including inactive` }, b.active_students)
              : h('span', { class: 'chip', title: 'No student in the sheet has this batch code yet' }, 'Planned')),
            h('td', { class: 'timing-cell' }, b.timings.length
              ? groupTimings(b.timings).map((g) => h('div', null, describeTiming(g)))
              : h('span', { class: 'chip warn' }, 'Not set')),
            roles.map((role) => {
              const slot = b.assignments.find((a) => sameText(a.role, role));
              if (!slot) return h('td', { class: 'slot-none', title: 'This batch has no such slot' }, '–');
              const f = faculties.find((x) => x.id === slot.faculty_id);
              return f
                ? h('td', { class: 'code', title: slotTitle(f, slot) }, slot.substitute_ids.length ? `${f.code} +${slot.substitute_ids.length}` : f.code)
                : h('td', { class: 'slot-open' }, 'Unfilled');
            }),
            h('td', null, b.flow
              ? [h('a', { href: `#/flows/${b.flow.id}` }, b.flow.name), ' ', h('a', { class: 'muted', href: `#/progress?flow=${b.flow.id}`, title: 'Sessions finished. Open batch progress' }, `${b.progress.done}/${b.progress.total}`)]
              : h('span', { class: 'chip warn' }, 'None')),
            h('td', null, h('div', { class: 'row-actions' },
              button('Assign', () => batchDialog(b), 'small quiet'),
              button('Delete', () => deleteDialog({
                title: `Delete ${b.name}?`,
                message: 'Its faculty assignments will be removed too. Master flows are kept. A batch with active students in the sheet can’t be deleted.',
                path: `/batches/${b.id}`,
                done: 'Batch deleted',
              }), 'small link-danger'))),
          ),
        ),
      ),
    ),
  );
}

export function batchesView(query) {
  const { batches, courses } = store.state;
  if (query.has('course')) filter.course = query.get('course');
  if (!courses.some((c) => String(c.id) === filter.course)) filter.course = '';

  const subtitle = 'Batch codes come from the student sheet. Open a batch to assign faculty; the table shows who fills each slot, by faculty code.';
  const add = button('Add planned batch', createDialog);

  if (!courses.length) {
    return h('div', null, pageHead('Batches', subtitle), attentionPanel(), emptyState('Add a course first', 'Each batch belongs to a course, so batches from the sheet appear once their course exists.', h('a', { class: 'btn primary', href: '#/courses' }, 'Go to courses')));
  }
  if (!batches.length) {
    return h('div', null, pageHead('Batches', subtitle, add), attentionPanel(), emptyState('No batches yet', 'Batches appear by themselves when the student sheet syncs. Each one gets its course’s faculty slots, ready to assign.', h('a', { class: 'btn', href: '#/students' }, 'Check the student sync')));
  }

  const years = [...new Set(batches.map((b) => b.year))].sort((a, b) => b - a);
  if (filter.year && !years.includes(Number(filter.year))) filter.year = '';

  const redraw = () => store.render();
  const filters = h(
    'div',
    { class: 'filters' },
    h('select', { 'aria-label': 'Filter by course', value: filter.course, onchange: (e) => { filter.course = e.target.value; history.replaceState(null, '', '#/batches'); redraw(); } },
      h('option', { value: '' }, 'All courses'),
      courses.map((c) => h('option', { value: c.id }, c.name))),
    h('select', { 'aria-label': 'Filter by year', value: filter.year, onchange: (e) => { filter.year = e.target.value; redraw(); } },
      h('option', { value: '' }, 'All years'),
      years.map((y) => h('option', { value: y }, y))),
  );

  const shown = batches.filter(
    (b) => (!filter.course || b.course_id === Number(filter.course)) && (!filter.year || b.year === Number(filter.year)),
  );

  const groups = [];
  for (const course of courses) {
    for (const year of years) {
      const inGroup = shown.filter((b) => b.course_id === course.id && b.year === year);
      if (inGroup.length) groups.push({ courseId: course.id, courseName: course.name, year, batches: inGroup });
    }
  }

  return h(
    'div',
    null,
    pageHead('Batches', subtitle, button('Upload batch faculty', assignmentUpload), button('Upload timetable', timetableUpload), add),
    attentionPanel(),
    filters,
    groups.length
      ? groups.map((g) => [
          h('h2', { class: 'section' }, `${g.courseName} ${g.year} `, h('span', { class: 'muted', style: 'font-weight:400' }, `· ${plural(g.batches.length, 'batch', 'batches')}`)),
          batchTable(g),
        ])
      : h('p', { class: 'muted' }, 'No batches match this filter.'),
  );
}
