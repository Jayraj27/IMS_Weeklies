/*
 * What approved scheduling input means for the schedule between two dates:
 *   away       faculty on leave or away part of a day: not given classes then
 *   extraDays  "faculty|date" where a faculty can teach on their usual day off
 *   closures   no classes then: the whole centre (batch_ids null) or some batches
 *   roomsShut  rooms not to be used then
 * Workshops and meetings with times aren't here: approving one puts blocks on the
 * schedule, which count like any other block.
 */

import { db } from '../db.js';
import { spanText } from '../../public/admin/input-kinds.js';
import { batchIdsOf, datesOf } from './parse.js';

const WHOLE_DAY = { start_time: '00:00', end_time: '24:00' };

export function batchLookup() {
  return new Map(db.prepare('SELECT id, name FROM batches').all().map((b) => [b.name.toLowerCase().replace(/\s+/g, ''), b]));
}

export function approvedEntries(from, to) {
  return db.prepare(`
    SELECT e.*, r.name AS room_name FROM input_entries e
    JOIN input_reviews v ON v.entry_key = e.entry_key AND v.status = 'approved'
    LEFT JOIN rooms r ON r.id = e.room_id
    WHERE e.from_date IS NOT NULL AND e.from_date <= ? AND COALESCE(e.to_date, e.from_date) >= ?`).all(to, from);
}

export function inputEffects(from, to) {
  const batches = batchLookup();
  const effects = { away: [], extraDays: new Set(), closures: [], roomsShut: [] };
  for (const e of approvedEntries(from, to)) {
    const span = e.from_time && e.to_time ? { start_time: e.from_time, end_time: e.to_time } : WHOLE_DAY;
    const hours = span === WHOLE_DAY ? '' : ` ${spanText(span.start_time, span.end_time)}`;
    const why = e.details ? `: ${e.details.split('\n')[0].slice(0, 60)}` : '';
    for (const date of datesOf(e).filter((d) => d >= from && d <= to)) {
      if ((e.kind === 'leave' || e.kind === 'partial') && e.faculty_id) {
        effects.away.push({ faculty_id: e.faculty_id, date, ...span, reason: e.kind === 'leave' && span === WHOLE_DAY ? 'on leave' : `away${hours}` });
      } else if (e.kind === 'extra' && e.faculty_id) {
        effects.extraDays.add(`${e.faculty_id}|${date}`);
      } else if (e.kind === 'closure') {
        effects.closures.push({ date, ...span, batch_ids: null, reason: `Centre closed${hours}${why}` });
      } else if (e.kind === 'batch_break') {
        effects.closures.push({ date, ...span, batch_ids: batchIdsOf(e, batches), reason: `Batch break${hours}${why}` });
      } else if (e.kind === 'room' && e.room_id) {
        effects.roomsShut.push({ room_id: e.room_id, room_name: e.room_name, date, ...span });
      }
    }
  }
  return effects;
}
