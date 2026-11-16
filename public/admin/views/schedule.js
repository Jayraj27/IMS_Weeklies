/*
 * The weekly schedule: generate a week, adjust any class, then confirm what was taught.
 */

import { h, store, api, refresh, pageHead, button, formDialog, confirmDialog, toast, plural, field } from '../lib.js';
import { WEEK, addDays, formatDate, formatTime, todayIso, weekdayOf } from '../calendar.js';

const view = { week: null, batch: '', mode: 'day' };

const weekStartOf = (iso) => addDays(iso, -WEEK.indexOf(weekdayOf(iso)));
const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const subjectMatches = (session, slot) => {
  const [a, b] = [String(session ?? '').trim().toLowerCase(), String(slot ?? '').trim().toLowerCase()];
  return Boolean(a && b) && (a === b || words(a).includes(b));
};

function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  return `${formatDate(weekStart)} – ${formatDate(end)}`;
}

/** Why a batch can't be scheduled yet, or null if it can. */
function missingFor(batch) {
  const missing = [];
  if (!batch.timings.length) missing.push('class times');
  if (!batch.flow) missing.push('a master flow');
  return missing.length ? missing : null;
}

/* ---------- changing one class ---------- */

async function updateClass(cls, changes, message) {
  await api('PUT', `/schedule/classes/${cls.id}`, changes);
  if ('status' in changes || 'session_id' in changes) await refresh();
  if (message) toast(message);
  store.render();
}

function sessionDialog(cls) {
  const batch = store.state.batches.find((b) => b.id === cls.batch_id);
  const flow = store.state.flows.find((f) => f.id === batch?.flow?.id);
  if (!flow) {
    toast('This batch has no master flow any more.', true);
    return;
  }
  const select = h(
    'select',
    { 'aria-label': 'Session for this class', value: cls.session_id ?? '' },
    h('option', { value: '' }, 'No session'),
    flow.sessions.map((s, i) => h('option', { value: s.id }, `${i + 1}. ${s.topic_code ? `${s.topic_code} · ` : ''}${s.topic} (${s.subject})`)),
  );
  formDialog({
    title: `${cls.batch_name}, ${weekdayOf(cls.date)} ${formatDate(cls.date)}`,
    body: [field('Session', select, `${formatTime(cls.start_time)} – ${formatTime(cls.end_time)}. Changing it here doesn’t move the sessions in other classes.`)],
    onSubmit: () => updateClass(cls, { session_id: select.value ? Number(select.value) : null }, 'Session changed'),
  });
}

function facultySelect(cls) {
  const batch = store.state.batches.find((b) => b.id === cls.batch_id);
  const fromSlots = [];
  for (const slot of batch?.assignments ?? []) {
    if (!subjectMatches(cls.subject, slot.subject)) continue;
    for (const id of [slot.faculty_id, ...slot.substitute_ids]) if (id && !fromSlots.includes(id)) fromSlots.push(id);
  }
  const all = store.state.faculties;
  const option = (f) => h('option', { value: f.id }, `${f.code} · ${f.name}${f.week_offs.length ? ` (off ${f.week_offs.join(', ')})` : ''}`);
  return h(
    'select',
    {
      class: 'class-faculty no-print',
      'aria-label': `Faculty for ${cls.batch_name} on ${formatDate(cls.date)} at ${formatTime(cls.start_time)}`,
      value: cls.faculty_id ?? '',
      disabled: cls.status === 'cancelled',
      onchange: (e) => updateClass(cls, { faculty_id: e.target.value ? Number(e.target.value) : null }).catch((err) => { toast(err.message, true); store.render(); }),
    },
    h('option', { value: '' }, 'No faculty'),
    fromSlots.length ? h('optgroup', { label: `This batch’s ${cls.subject ?? ''} slot`.replace('  ', ' ') }, fromSlots.map((id) => all.find((f) => f.id === id)).filter(Boolean).map(option)) : null,
    h('optgroup', { label: 'All faculty' }, all.filter((f) => !fromSlots.includes(f.id)).map(option)),
  );
}

function statusSelect(cls) {
  return h(
    'select',
    {
      class: `class-status status-${cls.status} no-print`,
      'aria-label': `Status of ${cls.batch_name} on ${formatDate(cls.date)} at ${formatTime(cls.start_time)}`,
      value: cls.status,
      onchange: (e) => {
        const status = e.target.value;
        const said = { done: 'Marked done. Its session now counts as finished.', cancelled: 'Class cancelled', planned: 'Back to planned' }[status];
        updateClass(cls, { status }, said).catch((err) => { toast(err.message, true); store.render(); });
      },
    },
    h('option', { value: 'planned' }, 'Planned'),
    h('option', { value: 'done' }, 'Done'),
    h('option', { value: 'cancelled' }, 'Cancelled'),
  );
}

function sessionCell(cls) {
  const text = cls.session_id
    ? [h('b', null, `${cls.no}. ${cls.topic_code || ''}`), ' ', cls.topic, ' ', h('span', { class: 'chip' }, cls.subject)]
    : h('span', { class: 'chip warn' }, 'No session');
  return h(
    'td',
    { class: 'session-cell' },
    h('div', null, text),
    cls.homework && /^https?:\/\//i.test(cls.homework)
      ? h('a', { class: 'small-text', href: cls.homework, target: '_blank', rel: 'noopener noreferrer' }, 'Homework')
      : cls.homework ? h('div', { class: 'muted small-text' }, `Homework: ${cls.homework}`) : null,
    cls.status !== 'done' ? h('button', { class: 'btn small quiet no-print', type: 'button', onclick: () => sessionDialog(cls) }, 'Change') : null,
  );
}

function flagList(cls) {
  if (!cls.flags.length && !cls.edited) return null;
  return h(
    'div',
    { class: 'class-flags' },
    cls.flags.map((f) => h('div', { class: f.startsWith('Covered by') ? 'flag-info' : 'flag-warn' }, f)),
    cls.edited ? h('div', { class: 'muted small-text' }, 'Changed by hand') : null,
  );
}

function classRow(cls, { showDate, showBatch = true }) {
  return h(
    'tr',
    { class: `class-row ${cls.status}` },
    showDate ? h('td', { class: 'nowrap' }, `${weekdayOf(cls.date)} ${formatDate(cls.date)}`) : null,
    h('td', { class: 'nowrap' }, `${formatTime(cls.start_time)} – ${formatTime(cls.end_time)}`),
    showBatch ? h('td', { class: 'nowrap' }, h('b', null, cls.batch_name)) : null,
    sessionCell(cls),
    h('td', null,
      facultySelect(cls),
      h('span', { class: 'print-only' }, cls.faculty_code ? `${cls.faculty_code} · ${cls.faculty_name}` : '—'),
      flagList(cls)),
    h('td', null, statusSelect(cls), h('span', { class: 'print-only' }, cls.status)),
  );
}

function classTable(classes, options) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'schedule-table' },
      h('thead', null, h('tr', null,
        options.showDate ? h('th', null, 'Date') : null,
        h('th', null, 'Time'),
        options.showBatch === false ? null : h('th', null, 'Batch'),
        h('th', null, 'Session'),
        h('th', null, 'Faculty'),
        h('th', null, 'Status'))),
      h('tbody', null, classes.map((c) => classRow(c, options))),
    ),
  );
}

function byDay(classes, weekStart) {
  const sections = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const today = classes.filter((c) => c.date === date);
    if (!today.length) continue;
    sections.push(h('h2', { class: 'section' }, `${weekdayOf(date)}, ${formatDate(date)}`, date === todayIso() ? h('span', { class: 'chip accent', style: 'margin-left:8px' }, 'Today') : null));
    sections.push(classTable(today, { showDate: false }));
  }
  return sections;
}

function byFaculty(classes) {
  const groups = new Map();
  for (const c of classes) {
    const key = c.faculty_id ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 0) return -1;
    if (b === 0) return 1;
    return groups.get(a)[0].faculty_code.localeCompare(groups.get(b)[0].faculty_code);
  });
  return keys.flatMap((key) => {
    const list = groups.get(key);
    const live = list.filter((c) => c.status !== 'cancelled').length;
    const title = key === 0 ? 'No faculty yet' : `${list[0].faculty_code} · ${list[0].faculty_name}`;
    return [
      h('h2', { class: 'section' }, title, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${plural(live, 'class', 'classes')}`)),
      classTable(list, { showDate: true }),
    ];
  });
}

/* ---------- the page ---------- */

export function scheduleView(query) {
  if (query.has('week')) view.week = weekStartOf(query.get('week'));
  if (query.has('batch')) view.batch = query.get('batch');
  view.week ??= weekStartOf(todayIso());

  const { batches } = store.state;
  const go = (week) => {
    location.hash = `#/schedule?week=${week}${view.batch ? `&batch=${view.batch}` : ''}`;
  };

  const schedulable = batches.filter((b) => b.timings.length);
  const batchSelect = h(
    'select',
    {
      'aria-label': 'Batch',
      value: view.batch,
      onchange: (e) => {
        view.batch = e.target.value;
        go(view.week);
      },
    },
    h('option', { value: '' }, `All batches with class times (${schedulable.length})`),
    schedulable.map((b) => h('option', { value: b.id }, b.name)),
  );
  const jump = h('input', { type: 'date', 'aria-label': 'Go to the week of', value: view.week, onchange: (e) => e.target.value && go(weekStartOf(e.target.value)) });

  const listSlot = h('div', null, h('p', { class: 'muted' }, 'Loading the week…'));
  let loaded = [];

  const generate = async () => {
    const target = view.batch ? batches.find((b) => String(b.id) === view.batch)?.name : 'every batch with class times';
    const planned = loaded.filter((c) => c.status === 'planned');
    const edited = planned.filter((c) => c.edited).length;
    if (planned.length) {
      const sure = await confirmDialog({
        title: 'Generate this week again?',
        message: `This replaces ${plural(planned.length, 'planned class', 'planned classes')} for ${target}${edited ? `, including ${edited} you changed by hand` : ''}. Classes marked done or cancelled stay as they are.`,
        confirmLabel: 'Generate again',
        danger: Boolean(edited),
      });
      if (!sure) return;
    }
    try {
      const result = await api('POST', '/schedule/generate', { week: view.week, batch_id: view.batch ? Number(view.batch) : undefined });
      toast(`Planned ${plural(result.created, 'class', 'classes')} for ${plural(result.batches, 'batch', 'batches')}${result.flagged ? `. ${result.flagged} need attention.` : '.'}`);
      if (result.skipped.length) toast(`Skipped: ${result.skipped.map((s) => `${s.batch} (${s.reason})`).join(' ')}`, true);
      store.render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  const markDone = async () => {
    const planned = loaded.filter((c) => c.status === 'planned' && c.session_id);
    if (!planned.length) {
      toast('There are no planned classes with a session to mark done.');
      return;
    }
    const sure = await confirmDialog({
      title: 'Mark this week done?',
      message: `${plural(planned.length, 'planned class', 'planned classes')} will be marked done, and their sessions will count as finished in Batch progress. Cancel any class that didn’t happen first.`,
      confirmLabel: 'Mark done',
      danger: false,
    });
    if (!sure) return;
    const { done } = await api('POST', '/schedule/done', { week: view.week, batch_id: view.batch ? Number(view.batch) : undefined });
    await refresh();
    toast(`${plural(done, 'class', 'classes')} marked done`);
    store.render();
  };

  const notReady = batches.filter((b) => b.active_students > 0 && missingFor(b));
  const chosen = view.batch ? batches.find((b) => String(b.id) === view.batch) : null;
  const chosenMissing = chosen ? missingFor(chosen) : null;

  const params = new URLSearchParams({ week: view.week });
  if (view.batch) params.set('batch', view.batch);
  api('GET', `/schedule?${params}`)
    .then(({ classes }) => {
      loaded = classes;
      if (!classes.length) {
        const reason = chosenMissing
          ? `${chosen.name} needs ${chosenMissing.join(' and ')} before it can be scheduled.`
          : schedulable.length
            ? 'Nothing is planned for this week yet. Generate it to fill each class with the next sessions from its master flow.'
            : 'No batch has class times yet. Add them on the Batches page first.';
        listSlot.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'No classes this week'), h('p', null, reason)));
        return;
      }
      const live = classes.filter((c) => c.status !== 'cancelled');
      const attention = live.filter((c) => !c.faculty_id || !c.session_id).length;
      const summary = h('p', { class: 'muted no-print', style: 'margin:0 0 6px' },
        `${plural(live.length, 'class', 'classes')} · ${classes.filter((c) => c.status === 'done').length} done`,
        attention ? h('span', { class: 'chip warn', style: 'margin-left:8px' }, `${attention} need attention`) : null);
      listSlot.replaceChildren(summary, ...(view.mode === 'faculty' ? byFaculty(classes) : byDay(classes, view.week)));
    })
    .catch((err) => listSlot.replaceChildren(h('p', { class: 'form-error', style: 'margin:0' }, err.message)));

  const modeTabs = h('div', { class: 'tabs no-print', role: 'group', 'aria-label': 'Arrange by' },
    [['day', 'By day'], ['faculty', 'By faculty']].map(([mode, label]) => h('button', {
      class: 'tab',
      type: 'button',
      'aria-pressed': String(view.mode === mode),
      onclick: () => {
        view.mode = mode;
        store.render();
      },
    }, label)));

  return h(
    'div',
    null,
    pageHead('Weekly schedule', 'Each class gets the next unfinished session of its batch’s master flow, and the faculty in the slot for that subject. Change anything, then mark the week done once it’s taught.',
      button('Print', () => window.print()),
      button('Mark week done', markDone),
      button('Generate week', generate, 'primary')),
    h('div', { class: 'week-bar no-print' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous week', onclick: () => go(addDays(view.week, -7)) }, '←'),
      h('b', { class: 'week-label' }, weekLabel(view.week)),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Next week', onclick: () => go(addDays(view.week, 7)) }, '→'),
      button('This week', () => go(weekStartOf(todayIso())), 'quiet'),
      jump,
      batchSelect),
    h('h1', { class: 'print-only print-title' }, `Schedule · ${weekLabel(view.week)}${chosen ? ` · ${chosen.name}` : ''}`),
    notReady.length
      ? h('details', { class: 'panel attention no-print' },
          h('summary', null, `${plural(notReady.length, 'running batch', 'running batches')} can’t be scheduled yet`),
          h('ul', { class: 'attention-list', style: 'margin-top:8px' }, notReady.map((b) => h('li', null, h('b', null, b.name), ` needs ${missingFor(b).join(' and ')}`))))
      : null,
    modeTabs,
    listSlot,
  );
}
