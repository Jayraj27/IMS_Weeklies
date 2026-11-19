/*
 * The kinds of scheduling input a faculty can send for a month, shared by the page and the
 * server. "form" is the choice's wording in the Google Form (tools/scheduling-input-form.gs
 * uses the same words); a kind without one can only be added by the admin.
 */

import { formatTime } from './calendar.js';

export const INPUT_KINDS = [
  { kind: 'leave', form: 'Leave (whole day)', label: 'Leave', needs: ['dates'] },
  { kind: 'partial', form: 'Not available for part of the day', label: 'Away part of the day', needs: ['dates', 'times'] },
  { kind: 'extra', form: 'Available on my usual day off', label: 'Extra day', needs: ['dates'] },
  { kind: 'event', form: 'Workshop, meeting or other commitment', label: 'Workshop or meeting', needs: [] },
  { kind: 'batch_break', form: 'Batch break: no classes for a batch', label: 'Batch break', needs: ['dates', 'batches'] },
  { kind: 'request', form: 'Extra session, test or other request for a batch', label: 'Batch request', needs: ['batches'] },
  { kind: 'closure', form: 'Centre holiday or closure', label: 'Centre closed', needs: ['dates'] },
  { kind: 'room', form: null, label: 'Room closed', needs: ['dates', 'room'] },
  { kind: 'none', form: 'Nothing to report this month', label: 'Nothing to report', needs: [] },
];

export const kindInfo = (kind) => INPUT_KINDS.find((k) => k.kind === kind) ?? null;

/** The kind for a form answer, or for a kind's own name or label. */
export function kindFromText(text) {
  const key = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  return INPUT_KINDS.find((k) => [k.form, k.label, k.kind].some((t) => t && t.toLowerCase() === key))?.kind ?? null;
}

/** "until 12:00 pm" for a span from midnight, "from 2:00 pm" for one to the end of the day. */
export function spanText(from, to) {
  if (from === '00:00') return `until ${formatTime(to)}`;
  if (to === '24:00' || to === '23:59') return `from ${formatTime(from)}`;
  return `from ${formatTime(from)} to ${formatTime(to)}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11" as "November 2026". */
export const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** "November 2026", "Nov 2026", "2026-11" or "11/2026" as "2026-11"; null otherwise. */
export function parseMonth(text) {
  const value = String(text ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(value);
  if (m) return build(+m[1], +m[2]);
  m = /^(\d{1,2})[/-](\d{4})$/.exec(value);
  if (m) return build(+m[2], +m[1]);
  m = /^([a-z]+)[\s,-]+(\d{4})$/i.exec(value);
  if (m) {
    const index = MONTH_NAMES.findIndex((n) => n.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (index >= 0) return build(+m[2], index + 1);
  }
  return null;
}

function build(year, month) {
  return month >= 1 && month <= 12 && year >= 2000 && year < 2100 ? `${year}-${String(month).padStart(2, '0')}` : null;
}

export const monthOf = (iso) => iso.slice(0, 7);

export function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
