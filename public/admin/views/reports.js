/*
 * Reports: faculty workload for a week or month, and each batch's forecast finish in its
 * master flow against its end date.
 */

import { h, store, api, pageHead, button, plural } from '../lib.js';
import { WEEK, addDays, formatDate, todayIso, weekdayOf } from '../calendar.js';

const view = { tab: 'workload', span: 'week', anchor: null };

const weekStartOf = (iso) => addDays(iso, -WEEK.indexOf(weekdayOf(iso)));
const monthStartOf = (iso) => `${iso.slice(0, 8)}01`;
function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function range() {
  if (view.span === 'month') {
    const from = monthStartOf(view.anchor);
    return { from, to: monthEnd(from), label: `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}` };
  }
  const from = weekStartOf(view.anchor);
  return { from, to: addDays(from, 6), label: `${formatDate(from)} – ${formatDate(addDays(from, 6))}` };
}

function step(direction) {
  if (view.span === 'week') view.anchor = addDays(weekStartOf(view.anchor), 7 * direction);
  else {
    const [y, m] = view.anchor.split('-').map(Number);
    const month = m + direction;
    const year = y + Math.floor((month - 1) / 12);
    view.anchor = `${year}-${String(((month - 1) % 12 + 12) % 12 + 1).padStart(2, '0')}-01`;
  }
  store.render();
}

const hoursText = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} h`;
const tabs = (items, current, onPick, label) => h('div', { class: 'tabs no-print', role: 'group', 'aria-label': label },
  items.map(([value, text]) => h('button', { class: 'tab', type: 'button', 'aria-pressed': String(current === value), onclick: () => onPick(value) }, text)));

/* ---------- faculty workload ---------- */

function workloadPanel() {
  const { from, to, label } = range();
  const slot = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  const controls = h('div', { class: 'week-bar no-print' },
    tabs([['week', 'Week'], ['month', 'Month']], view.span, (v) => { view.span = v; store.render(); }, 'Period'),
    h('button', { class: 'btn', type: 'button', 'aria-label': `Previous ${view.span}`, onclick: () => step(-1) }, '←'),
    h('b', { class: 'week-label' }, label),
    h('button', { class: 'btn', type: 'button', 'aria-label': `Next ${view.span}`, onclick: () => step(1) }, '→'),
    button(view.span === 'week' ? 'This week' : 'This month', () => { view.anchor = todayIso(); store.render(); }, 'quiet'),
    button('Download spreadsheet', () => { window.location.href = `/api/reports/workload.xlsx?from=${from}&to=${to}`; }));

  api('GET', `/reports/workload?from=${from}&to=${to}`).then((report) => {
    const teaching = report.faculties.filter((f) => f.hours || f.block_hours);
    const idle = report.faculties.filter((f) => !f.hours && !f.block_hours);
    const most = Math.max(1, ...teaching.map((f) => f.hours));
    const row = (f) => h('tr', null,
      h('td', null, h('b', null, f.code), h('div', { class: 'muted small-text' }, f.name)),
      h('td', { class: 'num' }, f.classes),
      h('td', { class: 'num' }, f.days),
      h('td', { class: 'load-cell' },
        h('div', { class: 'load-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${(f.hours / most) * 100}%` })),
        h('span', { class: 'num-text' }, hoursText(f.hours))),
      h('td', { class: 'num' }, f.done_hours ? hoursText(f.done_hours) : '–'),
      h('td', { class: 'num' }, f.planned_hours ? hoursText(f.planned_hours) : '–'),
      h('td', { class: 'num' }, f.block_hours ? hoursText(f.block_hours) : '–'),
      h('td', null, f.courses.map((c) => h('div', null, `${c.name} ${hoursText(c.hours)}`))),
      h('td', null, h('div', { class: 'chips' }, f.batches.map((b) => h('span', { class: 'chip' }, `${b.name} ${hoursText(b.hours)}`)))));

    slot.replaceChildren(
      h('p', { class: 'muted' },
        `${hoursText(report.total_hours)} of teaching by ${plural(teaching.filter((f) => f.hours).length, 'faculty', 'faculty')}. `,
        'Counts classes on the weekly schedule, so generate the weeks first; cancelled classes are left out.'),
      report.unassigned.classes
        ? h('p', { class: 'panel attention' }, `${plural(report.unassigned.classes, 'class', 'classes')} (${hoursText(report.unassigned.hours)}) have no faculty yet and aren’t counted for anyone.`)
        : '',
      teaching.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null,
              ['Faculty', 'Classes', 'Days', 'Teaching', 'Done', 'Still planned', 'Meetings', 'By course', 'By batch'].map((t, i) => h('th', { class: i > 0 && i < 7 && i !== 3 ? 'num' : null }, t)))),
            h('tbody', null, teaching.map(row))))
        : h('p', { class: 'empty' }, 'No classes on the schedule in this period.'),
      idle.length ? h('p', { class: 'muted', style: 'margin-top:12px' }, `No classes in this period: ${idle.map((f) => f.code).join(', ')}`) : '',
    );
  }).catch((err) => slot.replaceChildren(h('p', { class: 'form-error' }, err.message)));

  return [controls, slot];
}

/* ---------- batch forecast ---------- */

function statusOf(b) {
  switch (b.status) {
    case 'late': return { cls: 'warn-strong', text: `${plural(b.late_weeks, 'week')} late`, detail: `${plural(b.short_by, 'session')} won’t fit before the end date` };
    case 'on_track': return { cls: 'ok', text: 'On track', detail: b.spare ? `${plural(b.spare, 'class', 'classes')} to spare` : 'No classes to spare' };
    case 'no_end': return { cls: '', text: 'No end date', detail: 'Add an end date to compare' };
    case 'no_times': return { cls: 'warn', text: 'No class times', detail: 'Add class times to forecast' };
    case 'beyond': return { cls: 'warn-strong', text: 'Over 3 years away', detail: 'Check the class times' };
    case 'ended': return { cls: 'warn', text: 'Ended unfinished', detail: `${plural(b.remaining, 'session')} not marked finished` };
    default: return { cls: 'ok', text: 'Finished', detail: 'Every session is marked finished' };
  }
}

function forecastPanel() {
  const slot = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  api('GET', '/reports/forecast').then((report) => {
    const counts = new Map();
    for (const b of report.batches) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
    const chip = (status, cls, text) => (counts.get(status) ? h('span', { class: `chip ${cls}` }, `${counts.get(status)} ${text}`) : '');

    const row = (b) => {
      const s = statusOf(b);
      const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
      const pace = b.timetabled_last_4_weeks
        ? `${b.done_last_4_weeks} of ${b.timetabled_last_4_weeks} classes done`
        : '–';
      return h('tr', null,
        h('td', null, h('b', null, b.name), h('div', { class: 'muted small-text' }, `${b.course} · ${b.flow}`)),
        h('td', { class: 'progress-cell' },
          h('div', { class: 'load-bar', role: 'img', 'aria-label': `${pct}% finished` }, h('span', { style: `width:${pct}%` })),
          h('div', null, `${b.done} of ${b.total} sessions (${pct}%)`),
          b.next ? h('div', { class: 'muted small-text' }, `Next: ${b.next.no}. ${b.next.topic_code ? `${b.next.topic_code} · ` : ''}${b.next.topic}`) : null,
          h('div', { class: 'muted small-text' }, b.subjects.map((x) => `${x.subject} ${x.done}/${x.total}`).join(' · '))),
        h('td', { class: 'num' }, b.per_week ?? '–'),
        h('td', { class: 'num' }, pace),
        h('td', null, b.end_date ? formatDate(b.end_date) : '–'),
        h('td', null, b.finish_date ? formatDate(b.finish_date) : '–'),
        h('td', null, h('span', { class: `chip ${s.cls}` }, s.text), h('div', { class: 'muted small-text' }, s.detail)));
    };

    slot.replaceChildren(
      h('p', { class: 'muted' }, 'Each class teaches one session, as the generator plans them. The forecast counts this batch’s timetabled classes from today until every unfinished session has one. Holidays and cancellations will push it later.'),
      h('div', { class: 'chips', style: 'margin-bottom:12px' },
        chip('late', 'warn-strong', 'late'), chip('beyond', 'warn-strong', 'far off'), chip('no_times', 'warn', 'without class times'),
        chip('no_end', '', 'without an end date'), chip('on_track', 'ok', 'on track'), chip('ended', 'warn', 'ended unfinished'), chip('finished', 'ok', 'finished')),
      report.missing_flow.length
        ? h('p', { class: 'panel attention' }, `No master flow, so no forecast: ${report.missing_flow.join(', ')}`)
        : '',
      report.batches.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null,
              ['Batch', 'Progress', 'Classes a week', 'Marked done, last 4 weeks', 'End date', 'Forecast finish', 'Status'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : null }, t)))),
            h('tbody', null, report.batches.map(row))))
        : h('p', { class: 'empty' }, 'No batch follows a master flow yet.'),
    );
  }).catch((err) => slot.replaceChildren(h('p', { class: 'form-error' }, err.message)));
  return [slot];
}

export function reportsView(query) {
  if (query.has('tab')) view.tab = query.get('tab') === 'forecast' ? 'forecast' : 'workload';
  view.anchor ??= todayIso();
  return h('div', null,
    pageHead('Reports', 'How much each faculty teaches, and whether each batch will finish its master flow by its end date.'),
    tabs([['workload', 'Faculty workload'], ['forecast', 'Batch forecast']], view.tab, (v) => { view.tab = v; store.render(); }, 'Report'),
    ...(view.tab === 'workload' ? workloadPanel() : forecastPanel()));
}
