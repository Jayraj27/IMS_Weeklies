/*
 * Faculty input: each month's answers from the scheduling input Google Form, who hasn't
 * replied yet, and approving what reaches the schedule.
 */

import { h, store, api, pageHead, button, plural, field, formDialog, toast, confirmDialog } from '../lib.js';
import { formatDate, formatTime, todayIso } from '../calendar.js';
import { INPUT_KINDS, kindInfo, monthLabel, monthOf, shiftMonth, spanText } from '../input-kinds.js';

const view = { month: null, filter: 'pending' };

function dateRange(e) {
  if (!e.from_date) return '–';
  if (!e.to_date || e.to_date === e.from_date) return formatDate(e.from_date);
  return `${formatDate(e.from_date)} – ${formatDate(e.to_date)}`;
}
const timeRange = (e) => {
  if (!e.from_time || !e.to_time) return '';
  const text = spanText(e.from_time, e.to_time);
  return text[0].toUpperCase() + text.slice(1);
};
const sentAt = (stamp) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp) ? `Sent ${formatDate(stamp.slice(0, 10)).replace(/ \d{4}$/, '')}, ${formatTime(stamp.slice(11, 16))}` : `Sent ${stamp}`);

function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  if (minutes < 60 * 24) return `${plural(Math.round(minutes / 60), 'hour')} ago`;
  return formatDate(iso.slice(0, 10));
}

async function act(fn, message) {
  try {
    const result = await fn();
    if (message) toast(typeof message === 'function' ? message(result) : message);
    store.render();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- connection ---------- */

function connectionPanel(sync) {
  if (!sync.configured) {
    return h('div', { class: 'panel attention' },
      h('h2', { class: 'section' }, 'Connect the form'),
      h('p', null, 'Faculty fill a Google Form each month; this page reads its response sheet. To set it up, follow "Connect the faculty input form" in README.md: run tools/scheduling-input-form.gs once in Google Apps Script, share the response sheet as Viewer with the same Google identity the student sheet uses, and put its link in .env as INPUT_SHEET_ID.'),
      sync.config_error ? h('p', { class: 'form-error' }, sync.config_error) : null,
      h('p', { class: 'muted' }, 'You can still add entries by hand below.'),
      button('Copy faculty codes for the form script', () => copy(codesForScript(), 'Faculty codes copied: paste them into FACULTY_CODES')));
  }
  const last = sync.last_run;
  return h('div', { class: 'panel input-sync' },
    h('div', null,
      h('b', null, 'Google Form responses'),
      h('div', { class: 'muted small-text' },
        last ? (last.ok ? `Read ${ago(last.finished_at)}: ${plural(last.row_count, 'item')}.` : `Last read failed ${ago(last.finished_at)}.`) : 'Not read yet.',
        sync.last_success && !last?.ok ? ` Last good read ${ago(sync.last_success.finished_at)}.` : ''),
      last && !last.ok ? h('p', { class: 'form-error' }, last.error) : null),
    h('div', { class: 'row-actions' },
      button('Copy codes for the form', () => copy(codesForScript(), 'Faculty codes copied: paste them into FACULTY_CODES and run refreshChoices'), 'quiet'),
      sync.form_url ? button('Copy form link', () => copy(sync.form_url, 'Form link copied')) : null,
      button(sync.running ? 'Reading…' : 'Read responses now', (e) => {
        e.target.disabled = true;
        act(() => api('POST', '/inputs/sync'), (r) => (r.run.ok ? `Read ${plural(r.run.row_count, 'item')}` : 'Reading failed'));
      })));
}

/** The faculty list as lines to paste into FACULTY_CODES in the form script. */
const scriptText = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const codesForScript = () => store.state.faculties
  .map((f) => `  '${scriptText(`${f.code} - ${f.name}`)}',`)
  .join('\n');

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    formDialog({ title: 'Copy this', body: h('textarea', { rows: 8, readonly: true, value: text, onfocus: (e) => e.target.select() }), submitLabel: 'Done', onSubmit: async () => {} });
  }
}

/* ---------- who has replied ---------- */

function repliesPanel(data) {
  const expected = data.faculties.filter((f) => f.teaching);
  const others = data.faculties.filter((f) => !f.teaching);
  const waiting = expected.filter((f) => !f.replies);
  const deadline = h('input', { type: 'datetime-local', value: data.deadline ?? '', 'aria-label': 'Deadline' });
  const late = data.deadline && new Date(data.deadline) < new Date();

  const reminder = () => [
    `Reminder: please fill the Scheduling Input form for ${monthLabel(data.month)}${data.deadline ? ` by ${formatDate(data.deadline.slice(0, 10))}, ${formatTime(data.deadline.slice(11, 16))}` : ''}.`,
    'Send one response for each leave, part day, workshop or batch break, or one "Nothing to report this month".',
    data.sync.form_url ? `Form: ${data.sync.form_url}` : null,
    `Not received yet from: ${waiting.map((f) => f.code).join(', ')}`,
  ].filter(Boolean).join('\n');

  const chip = (f) => h('span', { class: `chip${f.replies ? ' ok' : ''}`, title: f.name }, f.replies ? `${f.code} ✓` : f.code);
  return h('section', { class: 'panel' },
    h('h2', { class: 'section' }, `Replies for ${monthLabel(data.month)}`),
    h('div', { class: 'input-deadline' },
      field('Deadline', deadline),
      button('Save deadline', () => act(() => api('PUT', `/inputs/months/${data.month}`, { deadline: deadline.value || null }), 'Deadline saved')),
      data.deadline ? h('span', { class: `chip ${late ? 'warn-strong' : 'accent'}` }, late ? 'Deadline passed' : `Due ${formatDate(data.deadline.slice(0, 10))}`) : null),
    h('p', null,
      h('b', null, `${expected.length - waiting.length} of ${expected.length}`),
      ' faculty with batches have replied.',
      waiting.length ? ' ' : '',
      waiting.length ? button('Copy reminder', () => copy(reminder(), 'Reminder copied: paste it into the email thread or WhatsApp group')) : null),
    expected.length ? h('div', { class: 'chips' }, [...waiting, ...expected.filter((f) => f.replies)].map(chip)) : h('p', { class: 'muted' }, 'No faculty is assigned to a batch yet.'),
    others.length ? h('p', { class: 'muted small-text', style: 'margin-top:8px' }, `Not on any batch: ${others.map((f) => (f.replies ? `${f.code} ✓` : f.code)).join(', ')}`) : null);
}

/* ---------- entries ---------- */

function statusChip(e) {
  if (e.status === 'approved') return h('span', { class: 'chip ok' }, 'Approved');
  if (e.status === 'rejected') return h('span', { class: 'chip' }, 'Rejected');
  return h('span', { class: `chip ${e.problems.length ? 'warn-strong' : 'warn'}` }, e.problems.length ? 'Needs fixing' : 'Waiting');
}

function entryRow(e) {
  const review = (status, label) => button(label, () => act(() => api('POST', `/inputs/entries/${e.id}/review`, { status }), status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Back to waiting'), status === 'approved' ? 'primary' : '');
  const actions = [];
  if (e.status === 'pending') {
    if (!e.problems.length) actions.push(review('approved', 'Approve'));
    if (e.source === 'form') actions.push(review('rejected', 'Reject'));
  } else if (e.source === 'form') actions.push(review('pending', 'Undo'));
  if (e.source === 'admin') {
    actions.push(button('Delete', async () => {
      const sure = await confirmDialog({ title: 'Delete this entry?', message: e.kind === 'event' ? 'Its blocks on the schedule are removed too.' : 'It stops affecting the schedule.', confirmLabel: 'Delete' });
      if (sure) act(() => api('DELETE', `/inputs/entries/${e.id}`), 'Entry deleted');
    }, 'quiet'));
  }
  if (e.problems.length && e.source === 'form') actions.push(button('Fix as new entry', () => entryDialog(e), 'quiet'));

  return h('tr', { class: e.status === 'rejected' ? 'muted-row' : null },
    h('td', null,
      h('b', null, e.faculty_code || (e.source === 'admin' ? 'Admin' : '–')),
      e.faculty_name ? h('div', { class: 'muted small-text' }, e.faculty_name) : null,
      e.source === 'form' && e.submitted_at ? h('div', { class: 'muted small-text' }, sentAt(e.submitted_at)) : null),
    h('td', null, e.label),
    h('td', null, dateRange(e), timeRange(e) ? h('div', { class: 'muted small-text' }, timeRange(e)) : null),
    h('td', null,
      e.batch_codes ? h('div', null, e.batch_codes) : null,
      e.others ? h('div', { class: 'muted small-text' }, `With ${e.others}`) : null,
      e.room_name ? h('div', null, e.room_name) : null),
    h('td', { class: 'input-details' }, e.details || h('span', { class: 'muted' }, '–')),
    h('td', null,
      e.problems.length ? h('ul', { class: 'attention-list problems' }, e.problems.map((p) => h('li', null, p))) : h('span', { class: 'small-text' }, e.effect)),
    h('td', null, statusChip(e), h('div', { class: 'row-actions input-actions' }, actions)));
}

function entriesPanel(data) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const e of data.entries) counts[e.status] += 1;
  const shown = data.entries.filter((e) => view.filter === 'all' || e.status === view.filter);
  const ready = data.entries.filter((e) => e.status === 'pending' && !e.problems.length).length;
  const tab = (value, text) => h('button', { class: 'tab', type: 'button', 'aria-pressed': String(view.filter === value), onclick: () => { view.filter = value; store.render(); } }, text);

  return h('section', null,
    h('div', { class: 'view-bar' },
      h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' },
        tab('pending', `Waiting (${counts.pending})`), tab('approved', `Approved (${counts.approved})`), tab('rejected', `Rejected (${counts.rejected})`), tab('all', `All (${data.entries.length})`)),
      h('div', { class: 'row-actions' },
        ready ? button(`Approve ${plural(ready, 'entry', 'entries')} without problems`, () => act(() => api('POST', '/inputs/approve', { month: data.month }), (r) => `Approved ${plural(r.approved, 'entry', 'entries')}`), 'primary') : null,
        button('Add entry', () => entryDialog()))),
    shown.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'input-table' },
          h('thead', null, h('tr', null, ['Faculty', 'What', 'Dates', 'Batches', 'Details', 'What it does', 'Status'].map((t) => h('th', null, t)))),
          h('tbody', null, shown.map(entryRow))))
      : h('p', { class: 'empty' }, view.filter === 'pending' ? 'Nothing waiting for review.' : 'No entries here.'));
}

/* ---------- adding by hand ---------- */

function entryDialog(from = null) {
  const kind = h('select', { required: true },
    h('option', { value: '' }, 'Choose…'),
    INPUT_KINDS.map((k) => h('option', { value: k.kind, selected: from?.kind === k.kind }, k.label)));
  const faculty = h('select', null,
    h('option', { value: '' }, 'None (centre or batch)'),
    store.state.faculties.map((f) => h('option', { value: f.id, selected: from?.faculty_id === f.id }, `${f.code} – ${f.name}`)));
  const input = (type, value) => h('input', { type, value: value && value !== 'bad' ? value : '' });
  const fromDate = input('date', from?.from_date);
  const toDate = input('date', from?.to_date);
  const fromTime = input('time', from?.from_time);
  const toTime = input('time', from?.to_time);
  const batches = h('input', { value: from?.batch_codes ?? '', placeholder: 'e.g. 27CA01, 27CA02' });
  const others = h('input', { value: from?.others ?? '', placeholder: 'Faculty codes, e.g. DP, AK' });
  const room = h('select', null, h('option', { value: '' }, 'Choose…'), store.state.rooms.map((r) => h('option', { value: r.id }, r.name)));
  const details = h('textarea', { rows: 3, value: from?.details ?? '' });
  const roomField = field('Room', room);
  const hint = h('p', { class: 'hint' });
  const update = () => {
    const info = kindInfo(kind.value);
    roomField.hidden = kind.value !== 'room';
    hint.textContent = info ? `Needs: ${['dates', 'times', 'batches', 'room'].filter((n) => info.needs.includes(n)).join(', ') || 'nothing more'}. Times left empty mean the whole day.` : '';
  };
  kind.addEventListener('change', update);
  update();

  formDialog({
    title: from ? 'Fix as a new entry' : 'Add an entry',
    wide: true,
    body: [
      from ? h('p', { class: 'hint' }, 'This adds a corrected copy as your own entry, approved straight away. Reject the form answer afterwards so it isn’t counted twice.') : h('p', { class: 'hint' }, 'For things not sent through the form, such as a centre holiday or a room under maintenance. Your entries are approved straight away.'),
      h('div', { class: 'field-row' }, field('What it is', kind), field('Faculty', faculty)),
      hint,
      h('div', { class: 'field-row' }, field('From date', fromDate), field('To date', toDate, 'Empty for one day')),
      h('div', { class: 'field-row' }, field('From time', fromTime), field('To time', toTime)),
      h('div', { class: 'field-row' }, field('Batch codes', batches), field('Other faculty', others)),
      roomField,
      field('Details', details),
    ],
    submitLabel: 'Add entry',
    onSubmit: async () => {
      await api('POST', '/inputs/entries', {
        month: view.month, kind: kind.value, faculty_id: faculty.value || null,
        from_date: fromDate.value, to_date: toDate.value, from_time: fromTime.value, to_time: toTime.value,
        batch_codes: batches.value, others: others.value, room_id: room.value || null, details: details.value,
      });
      toast('Entry added');
      store.render();
    },
  });
}

/* ---------- page ---------- */

export function facultyInputView(query) {
  if (query.has('month') && /^\d{4}-\d{2}$/.test(query.get('month'))) view.month = query.get('month');
  // Input is collected ahead, so the page opens on next month.
  view.month ??= shiftMonth(monthOf(todayIso()), 1);
  const go = (by) => { view.month = shiftMonth(view.month, by); store.render(); };

  const slot = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  api('GET', `/inputs?month=${view.month}`).then((data) => {
    slot.replaceChildren(connectionPanel(data.sync), repliesPanel(data), entriesPanel(data));
  }).catch((err) => slot.replaceChildren(h('p', { class: 'form-error' }, err.message)));

  return h('div', null,
    pageHead('Faculty input', 'Leave, workshops and batch breaks that faculty send through the monthly Google Form. Approved entries shape the weekly schedule.'),
    h('div', { class: 'week-bar' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous month', onclick: () => go(-1) }, '←'),
      h('b', { class: 'week-label' }, monthLabel(view.month)),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Next month', onclick: () => go(1) }, '→'),
      button('This month', () => { view.month = monthOf(todayIso()); store.render(); }, 'quiet'),
      button('Next month', () => { view.month = shiftMonth(monthOf(todayIso()), 1); store.render(); }, 'quiet')),
    slot);
}
