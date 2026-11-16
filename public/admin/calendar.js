/*
 * Calendar rules, used by both the server and the browser. Dates are plain 'YYYY-MM-DD'
 * text and times are 24-hour 'HH:MM', so a class on the 5th never drifts to the 4th
 * because of a timezone.
 */

export const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BY_JS_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const asUtc = (iso) => new Date(`${iso}T00:00:00Z`);

export function isIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text))) return false;
  const date = asUtc(text);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export const isTime = (text) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(text));
export const weekdayOf = (iso) => BY_JS_DAY[asUtc(iso).getUTCDay()];

export function addDays(iso, days) {
  const date = asUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 5 Nov 2026 */
export function formatDate(iso) {
  const date = asUtc(iso);
  const month = MONTHS[date.getUTCMonth()];
  return `${date.getUTCDate()} ${month[0].toUpperCase()}${month.slice(1)} ${date.getUTCFullYear()}`;
}

/** 6:00 pm */
export function formatTime(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

/** Puts days with the same hours together: "Mon, Wed 6:00 pm – 8:00 pm". */
export function groupTimings(timings) {
  const groups = new Map();
  for (const t of timings) {
    const key = `${t.start_time}|${t.end_time}`;
    if (!groups.has(key)) groups.set(key, { start_time: t.start_time, end_time: t.end_time, days: [] });
    groups.get(key).days.push(t.weekday);
  }
  const firstDay = (g) => Math.min(...g.days.map((d) => WEEK.indexOf(d)));
  return [...groups.values()]
    .map((g) => ({ ...g, days: [...new Set(g.days)].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b)) }))
    .sort((a, b) => firstDay(a) - firstDay(b) || a.start_time.localeCompare(b.start_time));
}

export const describeTiming = (group) => `${group.days.join(', ')} ${formatTime(group.start_time)} – ${formatTime(group.end_time)}`;

/** The first pair of classes on the same day whose hours overlap, or null. */
export function findOverlap(timings) {
  for (let i = 0; i < timings.length; i++) {
    for (let j = i + 1; j < timings.length; j++) {
      const [a, b] = [timings[i], timings[j]];
      if (a.weekday === b.weekday && a.start_time < b.end_time && b.start_time < a.end_time) return [a, b];
    }
  }
  return null;
}

/** Every class within a date range, respecting the batch's own start and end dates. */
export function classesBetween(timings, { from, to, startDate, endDate }) {
  const classes = [];
  const first = startDate && startDate > from ? startDate : from;
  const last = endDate && endDate < to ? endDate : to;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    const today = timings.filter((t) => t.weekday === weekday).sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (const t of today) classes.push({ date, weekday, start_time: t.start_time, end_time: t.end_time });
  }
  return classes;
}

/* ---------- reading what people type ---------- */

function dayFrom(word) {
  const key = word.trim().toLowerCase().slice(0, 3);
  return WEEK.find((d) => d.toLowerCase() === key) ?? null;
}

/**
 * "Mon, Wed & Fri", "Sat-Sun", "Monday to Friday", "None".
 * Returns { days, bad }, where bad holds any part it could not read.
 */
export function parseDays(text) {
  const cleaned = String(text ?? '').trim();
  if (!cleaned || /^(none|nil|na|n\/a|-)$/i.test(cleaned)) return { days: [], bad: [] };
  const days = new Set();
  const bad = [];
  for (const part of cleaned.split(/\s*(?:,|;|\/|&|\||\+|\band\b)\s*/i).filter(Boolean)) {
    const range = part.split(/\s*(?:-|–|\bto\b)\s*/i).filter(Boolean);
    if (range.length === 2 && dayFrom(range[0]) && dayFrom(range[1])) {
      let at = WEEK.indexOf(dayFrom(range[0]));
      const end = WEEK.indexOf(dayFrom(range[1]));
      days.add(WEEK[at]);
      while (at !== end) {
        at = (at + 1) % 7;
        days.add(WEEK[at]);
      }
    } else if (range.length === 1 && dayFrom(range[0])) {
      days.add(dayFrom(range[0]));
    } else {
      bad.push(part);
    }
  }
  return { days: WEEK.filter((d) => days.has(d)), bad };
}

/**
 * "9:30 AM", "5 pm", "17:30", "9.30". Returns { time } or { error }. No class runs before
 * 7 in the morning, so "5:00" with no AM or PM is sent back rather than read as 5 am.
 */
export function parseTime(text, { meridiem: inherited } = {}) {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/i.exec(String(text ?? '').trim());
  if (!match) return { error: `"${text}" is not a time` };
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = (match[3] ?? inherited ?? '').toLowerCase();
  if (minutes > 59 || hours > 23 || (meridiem && (hours < 1 || hours > 12))) return { error: `"${text}" is not a time` };
  if (meridiem === 'p' && hours < 12) hours += 12;
  if (meridiem === 'a' && hours === 12) hours = 0;
  if (!meridiem && hours < 7) return { error: `"${text}" needs AM or PM` };
  return { time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
}

/** "9:00 AM - 12:00 PM", "6-8 pm", "10 - 1 PM". Returns { start, end } or { error }. */
export function parseTimeRange(text) {
  const parts = String(text ?? '').trim().split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
  if (parts.length !== 2) return { error: `"${text}" should look like 6:00 PM - 8:00 PM` };
  const end = parseTime(parts[1]);
  if (end.error) return end;
  let start = parseTime(parts[0]);
  if (start.error) {
    // "6-8 pm": the start takes the end's AM or PM, unless that puts it after the end.
    const endMeridiem = /([ap])\.?m?\.?\s*$/i.exec(parts[1])?.[1];
    if (!endMeridiem) return start;
    start = parseTime(parts[0], { meridiem: endMeridiem });
    if (start.error) return start;
  } else if (!/[ap]\.?m?\.?\s*$/i.test(parts[0]) && /[ap]\.?m?\.?\s*$/i.test(parts[1])) {
    const endMeridiem = /([ap])\.?m?\.?\s*$/i.exec(parts[1])[1];
    const same = parseTime(parts[0], { meridiem: endMeridiem });
    if (same.time && same.time < end.time) start = same;
  }
  return { start: start.time, end: end.time };
}

/**
 * "1/7/2026" and "1-7-2026" are day first, as in India. "7/26/2026" can only be month
 * first. Also "1 Jul 2026", "1-Jul-26", "Jul 1, 2026" and "2026-07-01". Returns ISO or null.
 */
export function parseDateText(text) {
  const value = String(text ?? '').trim();
  if (isIsoDate(value)) return value;
  const build = (y, m, d) => {
    const year = y < 100 ? 2000 + y : y;
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  };
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(value);
  if (numeric) {
    const [a, b, y] = [+numeric[1], +numeric[2], +numeric[3]];
    return b > 12 ? build(y, a, b) : build(y, b, a);
  }
  const monthOf = (word) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?[-\s/]+([a-z]+)[-\s/,]+(\d{2}|\d{4})$/i.exec(value);
  if (dayFirst && monthOf(dayFirst[2])) return build(+dayFirst[3], monthOf(dayFirst[2]), +dayFirst[1]);
  const monthFirst = /^([a-z]+)[-\s/]+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{2}|\d{4})$/i.exec(value);
  if (monthFirst && monthOf(monthFirst[1])) return build(+monthFirst[3], monthOf(monthFirst[1]), +monthFirst[2]);
  return null;
}
