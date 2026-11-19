/*
 * The weekly schedule. The generator fills the week; the day grid is where it gets
 * checked and changed: rooms across the top, times down the side, one block per class.
 * Drag a block to move it, click it to edit, and clashes show on the block straight away.
 */

import { h, store, api, refresh, pageHead, button, formDialog, confirmDialog, toast, plural, field, checkGroup } from '../lib.js';
import { EVENT_COLOURS, colourFor } from '../colours.js';
import { WEEK, addDays, formatDate, formatTime, todayIso, weekdayOf } from '../calendar.js';

const view = { week: null, day: null, batch: '', mode: 'grid', colour: 'faculty' };

const PX_PER_MINUTE = 1.4; // 42px per half hour
const SNAP_MINUTES = 15;

const weekStartOf = (iso) => addDays(iso, -WEEK.indexOf(weekdayOf(iso)));
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const subjectMatches = (session, slot) => {
  const [a, b] = [String(session ?? '').trim().toLowerCase(), String(slot ?? '').trim().toLowerCase()];
  return Boolean(a && b) && (a === b || words(a).includes(b));
};

const weekLabel = (weekStart) => `${formatDate(weekStart)} – ${formatDate(addDays(weekStart, 6))}`;
const roomsSorted = () => [...store.state.rooms].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
const roomLabel = (r) => (r.capacity ? `${r.name} – ${r.capacity}` : r.name);

function missingFor(batch) {
  const missing = [];
  if (!batch.timings.length) missing.push('class times');
  if (!batch.flow) missing.push('a master flow');
  return missing.length ? missing : null;
}

const fail = (err) => { toast(err.message, true); store.render(); };

/* ---------- editing ---------- */

function roomSelect(current, online, label = 'Room') {
  return h(
    'select',
    { 'aria-label': label, value: online ? 'online' : current ?? '' },
    h('option', { value: '' }, 'No room'),
    h('option', { value: 'online' }, 'Online'),
    roomsSorted().map((r) => h('option', { value: r.id }, roomLabel(r))),
  );
}
const roomChoice = (select) => (select.value === 'online' ? { online: true, room_id: null } : { online: false, room_id: select.value ? Number(select.value) : null });

function facultyOptions(cls) {
  const batch = store.state.batches.find((b) => b.id === cls.batch_id);
  const fromSlots = [];
  for (const slot of batch?.assignments ?? []) {
    if (!subjectMatches(cls.subject, slot.subject)) continue;
    for (const id of [slot.faculty_id, ...slot.substitute_ids]) if (id && !fromSlots.includes(id)) fromSlots.push(id);
  }
  const all = store.state.faculties;
  const option = (f) => h('option', { value: f.id }, `${f.code} · ${f.name}${f.week_offs.length ? ` (off ${f.week_offs.join(', ')})` : ''}`);
  return [
    h('option', { value: '' }, 'No faculty'),
    fromSlots.length ? h('optgroup', { label: `This batch’s ${cls.subject ?? ''} slot` }, fromSlots.map((id) => all.find((f) => f.id === id)).filter(Boolean).map(option)) : null,
    h('optgroup', { label: 'All faculty' }, all.filter((f) => !fromSlots.includes(f.id)).map(option)),
  ];
}

function classDialog(cls) {
  const batch = store.state.batches.find((b) => b.id === cls.batch_id);
  const flow = store.state.flows.find((f) => f.id === batch?.flow?.id);
  const session = h(
    'select',
    { 'aria-label': 'Session', value: cls.session_id ?? '' },
    h('option', { value: '' }, 'No session'),
    (flow?.sessions ?? []).map((s, i) => h('option', { value: s.id }, `${i + 1}. ${s.topic_code ? `${s.topic_code} · ` : ''}${s.topic} (${s.subject})`)),
  );
  const faculty = h('select', { 'aria-label': 'Faculty', value: cls.faculty_id ?? '' }, facultyOptions(cls));
  const room = roomSelect(cls.room_id, cls.online);
  const date = h('input', { type: 'date', 'aria-label': 'Date', value: cls.date, required: true });
  const start = h('input', { type: 'time', 'aria-label': 'Start', value: cls.start_time, required: true });
  const end = h('input', { type: 'time', 'aria-label': 'End', value: cls.end_time, required: true });
  const status = h('select', { 'aria-label': 'Status', value: cls.status },
    h('option', { value: 'planned' }, 'Planned'), h('option', { value: 'done' }, 'Done'), h('option', { value: 'cancelled' }, 'Cancelled'));

  formDialog({
    title: `${cls.batch_name} · ${weekdayOf(cls.date)} ${formatDate(cls.date)}`,
    wide: true,
    body: [
      notes(cls),
      field('Session', session, flow ? null : 'This batch has no master flow.'),
      h('div', { class: 'field-row' }, field('Faculty', faculty), field('Room', room)),
      h('div', { class: 'field-row' }, field('Date', date), field('Start', start), field('End', end), field('Status', status)),
      h('p', { class: 'hint' }, 'Marking a class done records its session as finished in Batch progress.'),
    ],
    onSubmit: async () => {
      await api('PUT', `/schedule/classes/${cls.id}`, {
        session_id: session.value ? Number(session.value) : null,
        faculty_id: faculty.value ? Number(faculty.value) : null,
        ...roomChoice(room),
        date: date.value,
        start_time: start.value,
        end_time: end.value,
        status: status.value,
      });
      await refresh();
      if (weekStartOf(date.value) !== view.week) toast(`Moved to the week of ${formatDate(weekStartOf(date.value))}`);
      else toast('Class saved');
      store.render();
    },
  });
}

function eventDialog(event, defaults = {}) {
  const e = event ?? { title: '', date: defaults.date ?? view.day, start_time: defaults.start_time ?? '10:00', end_time: defaults.end_time ?? '11:00', room_id: null, online: false, faculty_ids: [] };
  const title = h('input', { required: true, maxLength: 120, value: e.title, placeholder: 'e.g. IPMAT 2027 planning' });
  const date = h('input', { type: 'date', required: true, value: e.date });
  const start = h('input', { type: 'time', required: true, value: e.start_time });
  const end = h('input', { type: 'time', required: true, value: e.end_time });
  const room = roomSelect(e.room_id, e.online);
  const people = checkGroup('Faculty involved', store.state.faculties.map((f) => ({ value: f.id, label: f.code, title: f.name })), e.faculty_ids, { hint: 'They’ll show as busy, so the generator won’t give them a class then.' });

  const dlg = formDialog({
    title: event ? 'Edit block' : 'Add a block',
    body: [
      field('Title', title),
      h('div', { class: 'field-row' }, field('Date', date), field('Start', start), field('End', end)),
      field('Room', room),
      people,
    ],
    onSubmit: async () => {
      const body = { title: title.value, date: date.value, start_time: start.value, end_time: end.value, ...roomChoice(room), faculty_ids: people.values() };
      if (event) await api('PUT', `/schedule/events/${event.id}`, body);
      else await api('POST', '/schedule/events', body);
      toast(event ? 'Block saved' : 'Block added');
      store.render();
    },
  });
  if (event) {
    const remove = h('button', {
      class: 'btn link-danger',
      type: 'button',
      style: 'margin-right:auto',
      onclick: async () => {
        await api('DELETE', `/schedule/events/${event.id}`);
        dlg.close();
        toast('Block deleted');
        store.render();
      },
    }, 'Delete block');
    dlg.querySelector('.dialog-foot').prepend(remove);
  }
}

/** Why the generator chose what it did, and anything that clashes. */
function notes(item) {
  const flags = item.flags ?? [];
  if (!flags.length && !item.warnings.length && !item.edited) return null;
  return h(
    'div',
    { class: 'class-flags' },
    item.warnings.map((w) => h('div', { class: 'flag-warn' }, `⚠ ${w}`)),
    flags.map((f) => h('div', { class: f.startsWith('Covered by') ? 'flag-info' : 'flag-warn' }, f)),
    item.edited ? h('div', { class: 'muted small-text' }, 'Changed by hand') : null,
  );
}

/* ---------- the day grid ---------- */

function columnsFor(classes, events) {
  const columns = roomsSorted().map((r) => ({ key: `room:${r.id}`, label: roomLabel(r), room_id: r.id, online: false }));
  columns.push({ key: 'online', label: 'Online', room_id: null, online: true, special: 'online' });
  if ([...classes, ...events].some((x) => !x.online && !x.room_id)) {
    columns.push({ key: 'none', label: 'No room yet', room_id: null, online: false, special: 'none' });
  }
  return columns;
}

const columnKeyOf = (item) => (item.online ? 'online' : item.room_id ? `room:${item.room_id}` : 'none');

/** Side-by-side lanes for blocks that overlap in one column, so a clash is visible. */
function layoutLanes(items) {
  const sorted = [...items].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const lanesEnd = [];
  for (const item of sorted) {
    let lane = lanesEnd.findIndex((end) => end <= item.start_time);
    if (lane < 0) lane = lanesEnd.length;
    lanesEnd[lane] = item.end_time;
    item.lane = lane;
  }
  for (const item of sorted) item.lanes = Math.max(1, lanesEnd.length);
  return sorted;
}

let drag = null;

function block(item, range) {
  const isEvent = item.kind === 'event';
  const top = (toMinutes(item.start_time) - range.start) * PX_PER_MINUTE;
  const height = Math.max(22, (toMinutes(item.end_time) - toMinutes(item.start_time)) * PX_PER_MINUTE - 2);
  const key = isEvent ? null : view.colour === 'batch' ? item.batch_name : item.faculty_code;
  const [fill, edge] = isEvent ? EVENT_COLOURS : colourFor(key);
  const width = 100 / item.lanes;
  const hasWarning = item.warnings.length > 0;

  const lines = isEvent
    ? [h('b', null, item.title), h('span', null, item.faculty_ids.map((id) => store.state.faculties.find((f) => f.id === id)?.code).filter(Boolean).join('/'))]
    : [
        h('b', null, item.faculty_code ?? 'No faculty'),
        h('span', null, item.session_id ? `${item.topic_code || item.subject} ${item.topic}` : 'No session'),
        h('span', { class: 'block-batch' }, item.batch_name),
      ];
  const label = isEvent
    ? `${item.title}, ${formatTime(item.start_time)} to ${formatTime(item.end_time)}`
    : `${item.batch_name}, ${formatTime(item.start_time)} to ${formatTime(item.end_time)}, ${item.faculty_code ?? 'no faculty'}, ${item.topic ?? 'no session'}`;

  return h(
    'button',
    {
      type: 'button',
      class: `grid-block${hasWarning ? ' has-warning' : ''}${item.status === 'cancelled' ? ' cancelled' : ''}${item.status === 'done' ? ' done' : ''}${isEvent ? ' event' : ''}`,
      style: `top:${top}px;height:${height}px;left:calc(${item.lane * width}% + 2px);width:calc(${width}% - 4px);background:${fill};border-left-color:${edge}`,
      title: [label, ...item.warnings.map((w) => `⚠ ${w}`), ...(item.flags ?? [])].join('\n'),
      'aria-label': `${label}${hasWarning ? `. ${plural(item.warnings.length, 'problem')}` : ''}. Open to edit.`,
      draggable: item.status !== 'done',
      onclick: () => (isEvent ? eventDialog(item) : classDialog(item)),
      ondragstart: (e) => {
        drag = { item, grabOffset: e.clientY - e.currentTarget.getBoundingClientRect().top };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
      },
      ondragend: () => { drag = null; },
    },
    hasWarning ? h('span', { class: 'block-alert', 'aria-hidden': 'true' }, '⚠') : null,
    item.status === 'done' ? h('span', { class: 'block-done', 'aria-hidden': 'true' }, '✓') : null,
    lines,
  );
}

async function moveTo(item, column, startMinutes) {
  const duration = toMinutes(item.end_time) - toMinutes(item.start_time);
  const body = {
    start_time: toTime(startMinutes),
    end_time: toTime(startMinutes + duration),
    online: column.online,
    room_id: column.room_id,
  };
  if (item.kind === 'event') await api('PUT', `/schedule/events/${item.id}`, body);
  else await api('PUT', `/schedule/classes/${item.id}`, body);
  store.render();
}

function dayGrid(classes, events) {
  const items = [
    ...classes.filter((c) => c.date === view.day).map((c) => ({ ...c, kind: 'class' })),
    ...events.filter((e) => e.date === view.day).map((e) => ({ ...e, kind: 'event' })),
  ];
  const starts = items.map((i) => toMinutes(i.start_time));
  const ends = items.map((i) => toMinutes(i.end_time));
  const range = {
    start: Math.min(7 * 60, ...starts.map((m) => Math.floor(m / 60) * 60)),
    end: Math.max(21 * 60, ...ends.map((m) => Math.ceil(m / 60) * 60)),
  };
  const height = (range.end - range.start) * PX_PER_MINUTE;
  const columns = columnsFor(classes.filter((c) => c.date === view.day), events.filter((e) => e.date === view.day));

  const timeLabels = [];
  for (let m = range.start; m < range.end; m += 30) {
    timeLabels.push(h('div', { class: 'grid-time', style: `top:${(m - range.start) * PX_PER_MINUTE}px` }, formatTime(toTime(m))));
  }

  const bodies = columns.map((column) => {
    const inColumn = layoutLanes(items.filter((i) => columnKeyOf(i) === column.key));
    const body = h(
      'div',
      {
        class: `grid-col-body${column.special ? ` ${column.special}` : ''}`,
        style: `height:${height}px`,
        ondragover: (e) => {
          if (!drag) return;
          e.preventDefault();
          body.classList.add('drop-hover');
        },
        ondragleave: () => body.classList.remove('drop-hover'),
        ondrop: (e) => {
          e.preventDefault();
          body.classList.remove('drop-hover');
          if (!drag) return;
          const { item, grabOffset } = drag;
          drag = null;
          const y = e.clientY - body.getBoundingClientRect().top - grabOffset;
          const duration = toMinutes(item.end_time) - toMinutes(item.start_time);
          const raw = range.start + Math.round(y / PX_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
          const start = Math.min(Math.max(raw, range.start), range.end - duration);
          if (start === toMinutes(item.start_time) && columnKeyOf(item) === column.key) return;
          moveTo(item, column, start).catch(fail);
        },
        ondblclick: (e) => {
          if (e.target !== body) return;
          const y = e.clientY - body.getBoundingClientRect().top;
          const start = range.start + Math.floor(y / PX_PER_MINUTE / 30) * 30;
          eventDialog(null, { date: view.day, start_time: toTime(start), end_time: toTime(start + 60) });
        },
      },
      inColumn.map((i) => block(i, range)),
    );
    return body;
  });

  const weekday = weekdayOf(view.day);
  const off = store.state.faculties.filter((f) => f.week_offs.includes(weekday)).map((f) => f.code);

  return h(
    'div',
    { class: 'grid-scroll', role: 'region', 'aria-label': `Schedule for ${weekday} ${formatDate(view.day)}`, tabindex: 0 },
    h(
      'div',
      { class: 'day-grid', style: `grid-template-columns:72px repeat(${columns.length}, minmax(150px, 1fr))` },
      h('div', { class: 'grid-corner' }, weekday),
      columns.map((c) => h('div', { class: `grid-head${c.special ? ` ${c.special}` : ''}` }, c.label)),
      h('div', { class: 'grid-offs', style: `grid-column: 1 / span ${columns.length + 1}` },
        off.length ? `Week-off today: ${off.join(', ')}` : 'Nobody has a week-off today'),
      h('div', { class: 'grid-times', style: `height:${height}px` }, timeLabels),
      bodies,
    ),
  );
}

function dayTabs(classes, events) {
  return h(
    'div',
    { class: 'tabs day-tabs no-print', role: 'group', 'aria-label': 'Day' },
    WEEK.map((wd, i) => {
      const date = addDays(view.week, i);
      const count = classes.filter((c) => c.date === date && c.status !== 'cancelled').length + events.filter((e) => e.date === date).length;
      const problems = [...classes, ...events].filter((x) => x.date === date && x.warnings.length && x.status !== 'cancelled').length;
      return h('button', {
        class: 'tab',
        type: 'button',
        'aria-pressed': String(view.day === date),
        onclick: () => { view.day = date; store.render(); },
      }, `${wd} ${Number(date.slice(8))}`, h('span', { class: 'count' }, count), problems ? h('span', { class: 'tab-alert', title: `${problems} with problems` }, '⚠') : null);
    }),
  );
}

function dayProblems(classes, events) {
  const items = [...classes, ...events].filter((x) => x.date === view.day && x.warnings.length && x.status !== 'cancelled');
  if (!items.length) return null;
  return h(
    'details',
    { class: 'panel attention no-print', open: true },
    h('summary', null, `${plural(items.length, 'block')} on this day ${items.length === 1 ? 'needs' : 'need'} attention`),
    h('ul', { class: 'attention-list', style: 'margin-top:8px' }, items.map((x) => h('li', null,
      h('button', { class: 'batch-open', type: 'button', onclick: () => (x.title ? eventDialog(x) : classDialog(x)) }, `${formatTime(x.start_time)} ${x.batch_name ?? x.title}`),
      `: ${x.warnings.join(' ')}`))),
  );
}

/* ---------- list views ---------- */

function classRow(cls, { showDate }) {
  return h(
    'tr',
    { class: `class-row ${cls.status}` },
    showDate ? h('td', { class: 'nowrap' }, `${weekdayOf(cls.date)} ${formatDate(cls.date)}`) : null,
    h('td', { class: 'nowrap' }, `${formatTime(cls.start_time)} – ${formatTime(cls.end_time)}`),
    h('td', { class: 'nowrap' }, h('b', null, cls.batch_name)),
    h('td', { class: 'session-cell' },
      cls.session_id ? [h('b', null, `${cls.no}. ${cls.topic_code || ''}`), ' ', cls.topic, ' ', h('span', { class: 'chip' }, cls.subject)] : h('span', { class: 'chip warn' }, 'No session'),
      cls.homework && /^https?:\/\//i.test(cls.homework) ? h('div', null, h('a', { class: 'small-text', href: cls.homework, target: '_blank', rel: 'noopener noreferrer' }, 'Homework')) : null),
    h('td', null, cls.faculty_code ? `${cls.faculty_code} · ${cls.faculty_name}` : h('span', { class: 'chip warn' }, 'No faculty'), notes(cls)),
    h('td', { class: 'nowrap' }, cls.online ? 'Online' : cls.room_name ?? h('span', { class: 'chip warn' }, 'No room')),
    h('td', { class: 'nowrap' }, h('span', { class: `chip status-chip ${cls.status}` }, cls.status[0].toUpperCase() + cls.status.slice(1))),
    h('td', { class: 'no-print' }, button('Edit', () => classDialog(cls), 'small quiet')),
  );
}

function classTable(classes, options) {
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', { class: 'schedule-table' },
      h('thead', null, h('tr', null,
        options.showDate ? h('th', null, 'Date') : null,
        ['Time', 'Batch', 'Session', 'Faculty', 'Room', 'Status'].map((t) => h('th', null, t)),
        h('th', { class: 'no-print' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', null, classes.map((c) => classRow(c, options)))),
  );
}

function byDay(classes) {
  const sections = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(view.week, i);
    const today = classes.filter((c) => c.date === date);
    if (!today.length) continue;
    sections.push(h('h2', { class: 'section' }, `${weekdayOf(date)}, ${formatDate(date)}`));
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
  const keys = [...groups.keys()].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : groups.get(a)[0].faculty_code.localeCompare(groups.get(b)[0].faculty_code)));
  return keys.flatMap((key) => {
    const list = groups.get(key);
    const title = key === 0 ? 'No faculty yet' : `${list[0].faculty_code} · ${list[0].faculty_name}`;
    return [
      h('h2', { class: 'section' }, title, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${plural(list.filter((c) => c.status !== 'cancelled').length, 'class', 'classes')}`)),
      classTable(list, { showDate: true }),
    ];
  });
}

/* ---------- the page ---------- */

export function scheduleView(query) {
  if (query.has('week')) view.week = weekStartOf(query.get('week'));
  if (query.has('batch')) view.batch = query.get('batch');
  view.week ??= weekStartOf(todayIso());
  if (!view.day || weekStartOf(view.day) !== view.week) {
    view.day = weekStartOf(todayIso()) === view.week ? todayIso() : view.week;
  }

  const { batches } = store.state;
  const go = (week) => {
    location.hash = `#/schedule?week=${week}${view.batch ? `&batch=${view.batch}` : ''}`;
  };

  const schedulable = batches.filter((b) => b.timings.length);
  const batchSelect = h(
    'select',
    { 'aria-label': 'Batch', value: view.batch, onchange: (e) => { view.batch = e.target.value; go(view.week); } },
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
        message: `This replaces ${plural(planned.length, 'planned class', 'planned classes')} for ${target}${edited ? `, including ${edited} you changed by hand` : ''}. Classes marked done or cancelled, and blocks you added, stay as they are.`,
        confirmLabel: 'Generate again',
        danger: Boolean(edited),
      });
      if (!sure) return;
    }
    try {
      const result = await api('POST', '/schedule/generate', { week: view.week, batch_id: view.batch ? Number(view.batch) : undefined });
      const extra = [result.flagged ? `${result.flagged} need attention` : null, result.no_room ? `${result.no_room} without a room` : null, result.closed ? `${plural(result.closed, 'class', 'classes')} left out for holidays and breaks` : null].filter(Boolean).join(', ');
      toast(`Planned ${plural(result.created, 'class', 'classes')} for ${plural(result.batches, 'batch', 'batches')}${extra ? `. ${extra}.` : '.'}`);
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
    .then(({ classes, events }) => {
      loaded = classes;
      const live = classes.filter((c) => c.status !== 'cancelled');
      const problems = [...live, ...events].filter((x) => x.warnings.length).length;
      const summary = h('p', { class: 'muted no-print', style: 'margin:0 0 8px' },
        `${plural(live.length, 'class', 'classes')} this week · ${classes.filter((c) => c.status === 'done').length} done`,
        problems ? h('span', { class: 'chip warn', style: 'margin-left:8px' }, `${problems} with problems`) : null);

      if (!classes.length && !events.length && view.mode !== 'grid') {
        const reason = chosenMissing
          ? `${chosen.name} needs ${chosenMissing.join(' and ')} before it can be scheduled.`
          : schedulable.length ? 'Nothing is planned for this week yet. Generate it to fill each class with the next sessions from its master flow.' : 'No batch has class times yet. Add them on the Batches page first.';
        listSlot.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'No classes this week'), h('p', null, reason)));
        return;
      }
      if (view.mode === 'grid') {
        const empty = !classes.length && !events.length
          ? h('p', { class: 'hint no-print' }, schedulable.length ? 'Nothing is planned this week yet. Click Generate week to fill it.' : 'No batch has class times yet. Add them on the Batches page first.')
          : null;
        listSlot.replaceChildren(summary, empty ?? '', dayTabs(classes, events), dayProblems(classes, events) ?? '', dayGrid(classes, events),
          h('p', { class: 'hint no-print', style: 'margin-top:8px' }, 'Drag a block to move it to another room or time. Click it to change the faculty, session or status. Double-click an empty space to add a meeting or other block.'));
      } else {
        listSlot.replaceChildren(summary, ...(view.mode === 'faculty' ? byFaculty(classes) : byDay(classes)));
      }
    })
    .catch((err) => listSlot.replaceChildren(h('p', { class: 'form-error', style: 'margin:0' }, err.message)));

  const modeTabs = h('div', { class: 'view-bar no-print' },
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'View' },
      [['grid', 'Day grid'], ['list', 'List'], ['faculty', 'By faculty']].map(([mode, label]) => h('button', {
        class: 'tab', type: 'button', 'aria-pressed': String(view.mode === mode),
        onclick: () => { view.mode = mode; store.render(); },
      }, label))),
    view.mode === 'grid'
      ? h('label', { class: 'colour-by' }, 'Colour by ',
          h('select', { 'aria-label': 'Colour blocks by', value: view.colour, onchange: (e) => { view.colour = e.target.value; store.render(); } },
            h('option', { value: 'faculty' }, 'faculty'), h('option', { value: 'batch' }, 'batch')))
      : null);

  return h(
    'div',
    null,
    pageHead('Weekly schedule', 'Generate the week, then check and change it on the day grid. Each class gets the next session of its batch’s master flow, the faculty in that subject’s slot, and the smallest free room that seats the batch.',
      button('Download spreadsheet', () => { window.location.href = `/api/schedule/export?week=${view.week}&colour=${view.colour}`; }),
      button('Print', () => window.print()),
      button('Add block', () => eventDialog(null)),
      button('Mark week done', markDone),
      button('Generate week', generate, 'primary')),
    h('div', { class: 'week-bar no-print' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous week', onclick: () => go(addDays(view.week, -7)) }, '←'),
      h('b', { class: 'week-label' }, weekLabel(view.week)),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Next week', onclick: () => go(addDays(view.week, 7)) }, '→'),
      button('This week', () => { view.day = todayIso(); go(weekStartOf(todayIso())); }, 'quiet'),
      jump,
      batchSelect),
    h('h1', { class: 'print-only print-title' }, view.mode === 'grid'
      ? `${weekdayOf(view.day)}, ${formatDate(view.day)}`
      : `Schedule · ${weekLabel(view.week)}${chosen ? ` · ${chosen.name}` : ''}`),
    notReady.length
      ? h('details', { class: 'panel attention no-print' },
          h('summary', null, `${plural(notReady.length, 'running batch', 'running batches')} can’t be scheduled yet`),
          h('ul', { class: 'attention-list', style: 'margin-top:8px' }, notReady.map((b) => h('li', null, h('b', null, b.name), ` needs ${missingFor(b).join(' and ')}`))))
      : null,
    modeTabs,
    listSlot,
  );
}
