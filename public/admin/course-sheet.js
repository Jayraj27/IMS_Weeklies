/*
 * Rules for the course faculty sheet, shared by the page and the server: which master
 * flow subjects become columns, the Days choices, and reading a time.
 */

import { WEEK, parseDays, parseTime } from './calendar.js';

export const DAY_CHOICES = { MWF: ['Mon', 'Wed', 'Fri'], TTS: ['Tue', 'Thu', 'Sat'], Sunday: ['Sun'] };

const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The subjects in a course's master flows, most sessions first. A subject such as
 * "TEST QA" is covered by "QA" (the scheduler matches it to the QA slot), so it starts
 * unticked: it needs no columns of its own.
 */
export function courseSubjects(flows) {
  const counts = new Map();
  for (const s of flows.flatMap((f) => f.sessions)) {
    const subject = String(s.subject ?? '').trim();
    if (!subject) continue;
    const key = subject.toLowerCase();
    const entry = counts.get(key) ?? { subject, sessions: 0 };
    entry.sessions += 1;
    counts.set(key, entry);
  }
  const all = [...counts.values()];
  return all
    .map((e) => ({
      ...e,
      covered_by: all.find((o) => o !== e && words(e.subject).includes(o.subject.toLowerCase()))?.subject ?? null,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.subject.localeCompare(b.subject));
}

/** MWF, TTS or Sunday from the dropdown; anything parseDays reads ("Mon, Thu") also works. */
export function parseDayChoice(text) {
  const cleaned = String(text ?? '').trim();
  const choice = Object.keys(DAY_CHOICES).find((k) => k.toLowerCase() === cleaned.toLowerCase());
  if (choice) return { days: DAY_CHOICES[choice] };
  const { days, bad } = parseDays(cleaned);
  if (bad.length || !days.length) return { error: `"${cleaned}" is not MWF, TTS, Sunday or a list of days` };
  return { days };
}

/** How a set of days is written in the sheet. */
export function dayChoiceOf(days) {
  const sorted = WEEK.filter((d) => days.includes(d));
  const choice = Object.entries(DAY_CHOICES).find(([, list]) => list.join() === sorted.join());
  return choice ? choice[0] : sorted.join(', ');
}

/**
 * The sheet asks for 24-hour HH:MM, so "06:30" is half past six in the morning. A time
 * with AM or PM is read too, and so is a time Excel stored as a fraction of a day.
 */
export function parseClock(value) {
  const text = String(value ?? '').trim();
  if (/^\d*\.\d+$|^0$/.test(text) && Number(text) < 1) {
    const minutes = Math.round(Number(text) * 24 * 60);
    return { time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
  }
  const exact = /^(\d{2}):(\d{2})(?::00)?$/.exec(text);
  if (exact) {
    const [hours, minutes] = [Number(exact[1]), Number(exact[2])];
    if (hours > 23 || minutes > 59) return { error: `"${text}" is not a time` };
    return { time: `${exact[1]}:${exact[2]}` };
  }
  return parseTime(text);
}

/** "QA1" is the QA primary, "QA2" its substitute; "Mentor" alone is the Mentor primary. */
export function readHeading(text) {
  const heading = String(text ?? '').trim().replace(/\s+/g, ' ');
  const key = heading.toLowerCase().replace(/[^a-z]/g, '');
  if (['batch', 'batchcode', 'batchname'].includes(key)) return { field: 'batch' };
  if (['days', 'day', 'weekdays'].includes(key)) return { field: 'days' };
  if (key.startsWith('starttime') || key === 'start') return { field: 'start' };
  if (key.startsWith('endtime') || key === 'end') return { field: 'end' };
  if (!heading) return null;
  const match = /^(.*?)\s*([12])$/.exec(heading);
  return match && match[1] ? { subject: match[1], rank: Number(match[2]) } : { subject: heading, rank: 1 };
}
