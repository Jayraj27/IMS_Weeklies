/*
 * Plans a week of classes. No database here, so the rules can be tested directly.
 *
 * Each batch's classes that week get the next unfinished sessions of its master flow,
 * in flow order. Each session goes to the faculty in the batch slot for its subject,
 * then that slot's substitutes in order, skipping anyone on their week-off or already
 * teaching another batch at that time. Anything it can't settle is flagged, not guessed.
 */

import { WEEK, addDays, classesBetween, weekdayOf } from '../../public/admin/calendar.js';

/** The Monday of the week a date falls in. */
export function weekStartOf(iso) {
  return addDays(iso, -WEEK.indexOf(weekdayOf(iso)));
}

const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * QA matches QA, and a "TEST QA" session also matches a QA slot. Nothing looser: VA does
 * not match VARC, so a naming difference is reported rather than silently papered over.
 */
export function subjectMatches(sessionSubject, slotSubject) {
  const session = String(sessionSubject ?? '').trim().toLowerCase();
  const slot = String(slotSubject ?? '').trim().toLowerCase();
  if (!session || !slot) return false;
  return session === slot || words(session).includes(slot);
}

export const overlaps = (a, b) => a.date === b.date && a.start_time < b.end_time && b.start_time < a.end_time;

/**
 * Picks the faculty for one class. Returns { faculty_id, flags }.
 * slots: [{ role, subject, faculty_id, substitute_ids }] in the batch's order.
 * faculties: Map of id to { id, code, week_offs }.
 * bookings: [{ faculty_id, date, start_time, end_time, batch_name }] already taken.
 */
export function chooseFaculty({ subject, slots, date, start_time, end_time, faculties, bookings }) {
  const weekday = weekdayOf(date);
  const matching = slots.filter((s) => subjectMatches(subject, s.subject));
  if (!matching.length) {
    const have = [...new Set(slots.map((s) => s.subject).filter(Boolean))];
    const hint = have.length ? ` Its slots are for: ${have.join(', ')}.` : ' It has no slots with a subject.';
    return { faculty_id: null, flags: [`This batch has no ${subject} slot.${hint}`] };
  }

  const candidates = [...new Set(matching.flatMap((s) => [s.faculty_id, ...s.substitute_ids]).filter(Boolean))];
  if (!candidates.length) {
    const roles = matching.map((s) => s.role).join(', ');
    return { faculty_id: null, flags: [`${roles} ${matching.length === 1 ? 'has' : 'have'} no faculty assigned.`] };
  }

  const reasons = [];
  for (const id of candidates) {
    const f = faculties.get(id);
    if (!f) continue;
    if (f.week_offs.includes(weekday)) {
      reasons.push(`${f.code} has ${weekday} off`);
      continue;
    }
    const clash = bookings.find((b) => b.faculty_id === id && overlaps(b, { date, start_time, end_time }));
    if (clash) {
      reasons.push(`${f.code} is teaching ${clash.batch_name} then`);
      continue;
    }
    return { faculty_id: id, flags: reasons.length ? [`Covered by ${f.code}: ${reasons.join('; ')}.`] : [] };
  }
  return { faculty_id: null, flags: [`Nobody free: ${reasons.join('; ')}.`] };
}

/**
 * Picks a room for a class of `size` students: the batch's usual room if it's free and big
 * enough, otherwise the smallest free room that seats them. Rooms with no seat count are a
 * last resort. Returns a room id, or null if nothing free fits.
 */
export function chooseRoom({ size, rooms, bookings, date, start_time, end_time, preferred }) {
  const slot = { date, start_time, end_time };
  const free = rooms.filter((r) => !bookings.some((b) => b.room_id === r.id && overlaps(b, slot)));
  const fits = (r) => r.capacity == null || r.capacity >= size;
  const usual = free.find((r) => r.id === preferred && fits(r));
  if (usual) return usual.id;
  const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
  const sized = free.filter((r) => r.capacity != null && r.capacity >= size).sort((a, b) => a.capacity - b.capacity || byName(a, b));
  if (sized.length) return sized[0].id;
  return free.filter((r) => r.capacity == null).sort(byName)[0]?.id ?? null;
}

/**
 * batches: [{ id, name, timings, start_date, end_date, slots, sessions, unavailable, occupied,
 *   size, online, preferred_room_id }]
 *   sessions: the flow's sessions in order; unavailable: a Set of session ids already
 *   finished or planned elsewhere; occupied: class times this week that are kept as they are.
 * bookings: other faculty commitments this week; roomBookings: rooms already taken this week.
 * Both are added to as classes are planned.
 */
export function generateWeek({ weekStart, batches, faculties, bookings, rooms = [], roomBookings = [] }) {
  const weekEnd = addDays(weekStart, 6);
  const facultyById = new Map(faculties.map((f) => [f.id, f]));
  const booked = [...bookings];
  const roomsTaken = [...roomBookings];
  const usualRoom = new Map(batches.map((b) => [b.id, b.preferred_room_id ?? null]));
  const queues = new Map();
  const classes = [];

  for (const batch of batches) {
    queues.set(batch.id, batch.sessions.filter((s) => !batch.unavailable.has(s.id)));
    const range = { from: weekStart, to: weekEnd, startDate: batch.start_date, endDate: batch.end_date };
    for (const c of classesBetween(batch.timings, range)) {
      const kept = (batch.occupied ?? []).some((o) => o.date === c.date && o.start_time === c.start_time);
      if (!kept) classes.push({ ...c, batch });
    }
  }
  // In time order across all batches, so whoever is planned first gets first claim on a faculty.
  classes.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time) || a.batch.name.localeCompare(b.batch.name));

  return classes.map((c) => {
    const { batch } = c;
    const session = queues.get(batch.id).shift() ?? null;
    const planned = { batch_id: batch.id, date: c.date, start_time: c.start_time, end_time: c.end_time, session_id: session?.id ?? null, faculty_id: null, room_id: null, online: batch.online ? 1 : 0, flags: [] };
    if (!batch.online) {
      planned.room_id = chooseRoom({ size: batch.size ?? 0, rooms, bookings: roomsTaken, date: c.date, start_time: c.start_time, end_time: c.end_time, preferred: usualRoom.get(batch.id) });
      if (planned.room_id) {
        roomsTaken.push({ room_id: planned.room_id, date: c.date, start_time: c.start_time, end_time: c.end_time });
        usualRoom.set(batch.id, planned.room_id);
      }
    }
    if (!session) {
      planned.flags.push('No sessions left in this batch’s master flow.');
      return planned;
    }
    const pick = chooseFaculty({ subject: session.subject, slots: batch.slots, date: c.date, start_time: c.start_time, end_time: c.end_time, faculties: facultyById, bookings: booked });
    planned.faculty_id = pick.faculty_id;
    planned.flags = pick.flags;
    if (pick.faculty_id) booked.push({ faculty_id: pick.faculty_id, date: c.date, start_time: c.start_time, end_time: c.end_time, batch_name: batch.name });
    return planned;
  });
}
