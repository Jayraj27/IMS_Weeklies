import {
  h, store, guard, api, field, pageHead, emptyState, button, checkGroup, formDialog,
  deleteDialog, save, refresh, toast, plural,
} from '../lib.js';
import { parseSessions } from './parse-sessions.js';

/* ---------- list of flows ---------- */

function reach(flow) {
  const { batches, flows } = store.state;
  const names = (ids) => batches.filter((b) => ids.includes(b.id)).map((b) => b.name);
  if (flow.scope === 'batches') {
    const list = names(flow.batch_ids);
    return list.length ? `${plural(list.length, 'batch', 'batches')}: ${list.join(', ')}` : 'No batches left in this group';
  }
  const inCourse = batches.filter((b) => b.course_id === flow.course_id);
  const overridden = flows.filter((f) => f.course_id === flow.course_id && f.scope === 'batches').flatMap((f) => f.batch_ids).length;
  if (!inCourse.length) return 'Course-wide. No batches yet.';
  return overridden
    ? `Course-wide: ${inCourse.length - overridden} of ${inCourse.length} batches. The rest follow their own group flow.`
    : `Course-wide: all ${plural(inCourse.length, 'batch', 'batches')}`;
}

function subjectCounts(sessions) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.subject, (counts.get(s.subject) ?? 0) + 1);
  return [...counts].map(([subject, n]) => `${subject} ${n}`).join(' · ');
}

export function flowsView() {
  const { courses, flows } = store.state;
  const subtitle = 'The order of sessions for each variant of a course, mapped to the batches that follow it. Upload one, then set where each batch has reached.';
  const add = h('a', { class: 'btn primary', href: '#/flows/new' }, 'New master flow');

  if (!courses.length) {
    return h('div', null, pageHead('Master flows', subtitle), emptyState('Add a course first', 'A master flow belongs to a course.', h('a', { class: 'btn primary', href: '#/courses' }, 'Go to courses')));
  }
  if (!flows.length) {
    return h('div', null, pageHead('Master flows', subtitle), emptyState('No master flows yet', 'Lay out the syllabus session by session, or paste it from a spreadsheet.', add));
  }

  const sections = courses
    .map((course) => ({ course, list: flows.filter((f) => f.course_id === course.id) }))
    .filter((s) => s.list.length)
    .map(({ course, list }) => [
      h('h2', { class: 'section' }, course.name),
      h(
        'div',
        { class: 'flow-list' },
        list.map((flow) =>
          h(
            'article',
            { class: 'flow-card' },
            h(
              'div',
              null,
              h('h3', null, h('a', { href: `#/flows/${flow.id}` }, flow.name)),
              h('p', { class: 'flow-meta' }, reach(flow)),
              h('p', { class: 'flow-meta' }, plural(flow.sessions.length, 'session'), flow.sessions.length ? ` · ${subjectCounts(flow.sessions)}` : ''),
            ),
            h(
              'div',
              { class: 'row-actions' },
              h('a', { class: 'btn small quiet', href: `#/progress?flow=${flow.id}` }, 'Batch progress'),
              h('a', { class: 'btn small quiet', href: `#/flows/new?from=${flow.id}` }, 'Duplicate'),
              button('Delete', () => deleteDialog({
                title: `Delete ${flow.name}?`,
                message: `Its ${plural(flow.sessions.length, 'session')} will be deleted. This can’t be undone.`,
                path: `/flows/${flow.id}`,
                done: 'Flow deleted',
              }), 'small link-danger'),
            ),
          ),
        ),
      ),
    ]);

  return h('div', null, pageHead('Master flows', subtitle, add), sections);
}

/* ---------- editing one flow ---------- */

function startingDraft(idText, query) {
  const { flows, courses } = store.state;
  if (idText !== 'new') {
    const flow = flows.find((f) => f.id === Number(idText));
    return flow && { ...flow, batch_ids: [...flow.batch_ids], sessions: flow.sessions.map((s) => ({ ...s })) };
  }
  const source = flows.find((f) => f.id === Number(query.get('from')));
  if (source) {
    return {
      id: null,
      course_id: source.course_id,
      name: `${source.name} copy`,
      scope: 'batches', // a course can only have one course-wide flow
      batch_ids: [],
      // Without ids: these rows are new sessions, with their own progress.
      sessions: source.sessions.map(({ id, ...s }) => s),
    };
  }
  const courseId = Number(query.get('course')) || courses[0]?.id;
  return { id: null, course_id: courseId, name: '', scope: 'batches', batch_ids: [], sessions: [] };
}

function uploadDialog(existingCount, onAdd) {
  const area = h('textarea', {
    placeholder: 'No\tTopic Code\tTopic\tArea\tSubject\tHomework link\n1\tQA 1.5A\tPercentages (A)\tArithmetic\tQA\thttps://…',
    'aria-label': 'Sessions to paste',
    oninput: update,
  });
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
  const summary = h('div', { class: 'hint', role: 'status' });
  const replaceBox = h('input', { type: 'checkbox', checked: existingCount > 0 });

  function update() {
    const { sessions, problems, notes } = parseSessions(area.value);
    const oldError = area.closest('dialog')?.querySelector('.form-error');
    if (oldError) oldError.hidden = true;
    const counts = new Map();
    for (const s of sessions) counts.set(s.subject, (counts.get(s.subject) ?? 0) + 1);
    const breakdown = [...counts].map(([subject, n]) => `${subject} ${n}`).join(' · ');
    const danger = { style: 'color:var(--danger)' };
    summary.replaceChildren(
      h('p', null, sessions.length ? `Ready: ${plural(sessions.length, 'session')} · ${breakdown}` : ''),
      ...problems.slice(0, 5).map((p) => h('p', danger, p)),
      problems.length > 5 ? h('p', danger, `…and ${problems.length - 5} more.`) : null,
      ...notes.slice(0, 3).map((n) => h('p', null, n)),
    );
  }

  formDialog({
    title: 'Upload sessions',
    submitLabel: 'Use these sessions',
    wide: true,
    body: [
      field('Paste rows copied from Excel or Google Sheets', area, 'Include the heading row. Columns are found by name: Topic and Subject are needed; Topic Code, Area and Homework link are optional. Summary rows above the headings are ignored.'),
      field('Or choose a CSV file', file, 'For an Excel file, copy and paste the rows, or save it as CSV first.'),
      existingCount
        ? h('label', { class: 'check', style: 'margin-bottom:12px' }, replaceBox, `Replace the ${plural(existingCount, 'existing session')}, instead of adding after them`)
        : null,
      summary,
    ],
    onSubmit: async () => {
      const { sessions, problems } = parseSessions(area.value);
      if (problems.length) throw new Error('Fix the lines listed above first.');
      if (!sessions.length) throw new Error('Paste or choose at least one session.');
      onAdd(sessions, replaceBox.checked);
    },
  });
}

export function flowEditorView(idText, query) {
  const draft = startingDraft(idText, query);
  if (!draft) {
    return emptyState('Flow not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/flows' }, 'Back to master flows'));
  }
  const { courses, flows, batches } = store.state;
  const isNew = draft.id == null;

  const status = h('span', { class: 'status' }, isNew ? 'Not created yet' : 'All changes saved');
  const errorEl = h('p', { class: 'error', role: 'alert', hidden: true });
  function markDirty() {
    guard.dirty = true;
    status.textContent = 'Unsaved changes';
    status.classList.add('dirty');
  }

  /* --- details --- */

  const nameInput = h('input', { maxLength: 80, required: true, value: draft.name, placeholder: 'e.g. CAT 2026 standard flow', oninput: (e) => { draft.name = e.target.value; markDirty(); } });
  const courseSelect = h(
    'select',
    {
      disabled: !isNew,
      value: draft.course_id,
      onchange: (e) => {
        draft.course_id = Number(e.target.value);
        draft.batch_ids = [];
        markDirty();
        drawScope();
      },
    },
    courses.map((c) => h('option', { value: c.id }, c.name)),
  );

  const scopeSlot = h('div');
  let batchBoxes = null;

  function drawScope() {
    const wide = flows.find((f) => f.course_id === draft.course_id && f.scope === 'course' && f.id !== draft.id);
    if (wide && draft.scope === 'course') draft.scope = 'batches';

    const radio = (value, label, disabled) =>
      h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'flow-scope', checked: draft.scope === value, disabled,
          onchange: () => { draft.scope = value; markDirty(); drawScope(); } }),
        label);

    const courseBatches = batches.filter((b) => b.course_id === draft.course_id);
    const options = courseBatches.map((b) => {
      const other = flows.find((f) => f.id !== draft.id && f.batch_ids.includes(b.id));
      const variantText = b.variants.length > 2 ? `${b.variants.slice(0, 2).join(', ')} +${b.variants.length - 2}` : b.variants.join(', ');
      return {
        value: b.id,
        label: [
          other ? `${b.name} (in ${other.name})` : b.name,
          variantText ? h('span', { class: 'muted check-note' }, variantText) : null,
        ],
        disabled: Boolean(other),
        title: other ? `Already follows ${other.name}. Remove it there first.` : undefined,
      };
    });
    batchBoxes = draft.scope === 'batches' && courseBatches.length
      ? checkGroup('Batches following this flow', options, draft.batch_ids, {
          hint: 'Each batch shows its students’ Current Variants from the student sheet.',
          onChange: () => { draft.batch_ids = batchBoxes.values(); markDirty(); },
        })
      : null;

    const noBatchesNote = draft.scope === 'batches' && !courseBatches.length
      ? h('p', { class: 'hint', style: 'margin-bottom:14px' }, 'This course has no batches yet. Create them first, then choose them here.')
      : null;
    scopeSlot.replaceChildren(
      h('fieldset', { class: 'field' },
        h('legend', null, 'Applies to'),
        h('div', { class: 'check-group' },
          radio('course', 'The whole course', Boolean(wide)),
          radio('batches', 'A group of batches', false)),
        wide ? h('p', { class: 'hint' }, `The course-wide flow for this course is “${wide.name}”.`) : null),
      ...[noBatchesNote, batchBoxes].filter(Boolean),
    );
  }
  drawScope();

  /* --- sessions --- */

  const tbody = h('tbody');
  const totalEl = h('span', { class: 'session-total', role: 'status' });
  let dragFrom = null;

  function moveSession(from, to) {
    if (to < 0 || to >= draft.sessions.length || from === to) return;
    const [item] = draft.sessions.splice(from, 1);
    draft.sessions.splice(to, 0, item);
    markDirty();
    drawSessions();
  }

  function updateTotal() {
    const breakdown = subjectCounts(draft.sessions.filter((s) => String(s.subject).trim()));
    totalEl.textContent = `${plural(draft.sessions.length, 'session')}${breakdown ? ` · ${breakdown}` : ''}`;
  }

  function sessionRow(session, i) {
    const row = h(
      'tr',
      {
        ondragover: (e) => {
          if (dragFrom == null) return;
          e.preventDefault();
          row.classList.add(dragFrom < i ? 'drop-after' : 'drop-before');
        },
        ondragleave: () => row.classList.remove('drop-after', 'drop-before'),
        ondrop: (e) => {
          e.preventDefault();
          row.classList.remove('drop-after', 'drop-before');
          if (dragFrom != null) moveSession(dragFrom, i);
          dragFrom = null;
        },
        ondragstart: (e) => {
          dragFrom = i;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          row.classList.add('dragging');
        },
        ondragend: () => {
          row.draggable = false;
          row.classList.remove('dragging');
          dragFrom = null;
        },
      },
      // Only the handle starts a drag, so selecting text in the inputs still works.
      h('td', { class: 'handle', title: 'Drag to reorder', onmousedown: () => { row.draggable = true; }, onmouseup: () => { row.draggable = false; } }, '⠿'),
      h('td', { class: 'pos' }, i + 1),
      h('td', { class: 'col-code' }, h('input', { 'aria-label': `Session ${i + 1} topic code`, maxLength: 60, value: session.topic_code, oninput: (e) => { session.topic_code = e.target.value; markDirty(); } })),
      h('td', { class: 'col-topic' }, h('input', { 'aria-label': `Session ${i + 1} topic`, maxLength: 300, value: session.topic, oninput: (e) => { session.topic = e.target.value; markDirty(); } })),
      h('td', { class: 'col-area' }, h('input', { 'aria-label': `Session ${i + 1} area`, maxLength: 80, value: session.area, oninput: (e) => { session.area = e.target.value; markDirty(); } })),
      h('td', { class: 'col-subject' }, h('input', { 'aria-label': `Session ${i + 1} subject`, list: 'subject-list', maxLength: 60, value: session.subject, oninput: (e) => { session.subject = e.target.value; markDirty(); updateTotal(); } })),
      h('td', { class: 'col-homework' }, h('input', { 'aria-label': `Session ${i + 1} homework link`, maxLength: 600, value: session.homework, oninput: (e) => { session.homework = e.target.value; markDirty(); } })),
      h('td', { class: 'nowrap' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move session ${i + 1} up`, disabled: i === 0, onclick: () => moveSession(i, i - 1) }, '↑'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move session ${i + 1} down`, disabled: i === draft.sessions.length - 1, onclick: () => moveSession(i, i + 1) }, '↓'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove session ${i + 1}`, onclick: () => { draft.sessions.splice(i, 1); markDirty(); drawSessions(); } }, '×')),
    );
    return row;
  }

  function drawSessions() {
    tbody.replaceChildren(
      ...(draft.sessions.length
        ? draft.sessions.map(sessionRow)
        : [h('tr', null, h('td', { colspan: 8, class: 'muted', style: 'text-align:center;padding:20px' }, 'No sessions yet. Upload them, or add them one at a time.'))]),
    );
    updateTotal();
  }
  drawSessions();

  function addSession() {
    const last = draft.sessions.at(-1);
    draft.sessions.push({ topic_code: '', topic: '', area: last?.area ?? '', subject: last?.subject ?? '', homework: '' });
    markDirty();
    drawSessions();
    tbody.lastChild.querySelector('input').focus();
  }

  /* --- saving --- */

  function checkSessions() {
    const blank = (s) => ![s.topic_code, s.topic, s.homework].some((v) => String(v).trim());
    const firstBad = draft.sessions.findIndex((s) => !blank(s) && (!String(s.subject).trim() || !String(s.topic).trim()));
    if (firstBad >= 0) throw new Error(`Session ${firstBad + 1} needs both a subject and a topic.`);
    return draft.sessions.filter((s) => !blank(s));
  }

  const saveBtn = h('button', {
    class: 'btn primary',
    type: 'button',
    onclick: async () => {
      errorEl.hidden = true;
      saveBtn.disabled = true;
      try {
        const body = {
          name: draft.name,
          course_id: draft.course_id,
          scope: draft.scope,
          batch_ids: draft.batch_ids,
          sessions: checkSessions(),
        };
        if (isNew) {
          const { id } = await api('POST', '/flows', body);
          await refresh();
          guard.dirty = false;
          location.hash = `#/flows/${id}`;
          toast('Master flow created');
        } else {
          const { progress_lost: lost } = await save('PUT', `/flows/${draft.id}`, body, 'Master flow saved');
          if (lost) toast(`${plural(lost, 'finished mark')} removed along with the deleted sessions. Check Batch progress.`, true);
        }
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
      }
    },
  }, isNew ? 'Create flow' : 'Save flow');

  return h(
    'div',
    null,
    h('a', { class: 'back-link', href: '#/flows' }, '← Master flows'),
    pageHead(isNew ? 'New master flow' : draft.name),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'field-row' }, field('Flow name', nameInput), field('Course', courseSelect)),
      scopeSlot,
    ),
    h('h2', { class: 'section' }, 'Sessions, in teaching order'),
    h(
      'div',
      { class: 'table-wrap sessions' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null,
          h('th', null, h('span', { class: 'sr-only' }, 'Drag')),
          h('th', { class: 'num' }, 'No'),
          h('th', null, 'Topic code'),
          h('th', null, 'Topic'),
          h('th', null, 'Area'),
          h('th', null, 'Subject'),
          h('th', null, 'Homework link'),
          h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
        tbody,
      ),
    ),
    h(
      'div',
      { class: 'session-actions' },
      button('Upload sessions', () =>
        uploadDialog(draft.sessions.length, (added, replace) => {
          draft.sessions = replace ? added : [...draft.sessions, ...added];
          markDirty();
          drawSessions();
        }), 'primary'),
      button('Add session', addSession),
      totalEl,
    ),
    h('div', { class: 'savebar' }, status, h('a', { class: 'btn', href: '#/flows' }, 'Back'), saveBtn, errorEl),
  );
}
