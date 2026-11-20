/*
 * Each faculty with an email gets a Google calendar, "IMS schedule – CODE", made by the
 * app's service account and shared with them to view. Their classes and blocks from a week
 * before today to eight weeks ahead are kept in it: after any change to the schedule the
 * app works out what each calendar should hold, and sends only the differences. Events
 * further back are left as they were.
 *
 * Turned on with CALENDAR_SYNC=on, once the Google Calendar API is enabled for the
 * service account's Cloud project.
 */

import crypto from 'node:crypto';
import { db, tx } from '../db.js';
import { addDays, todayIso } from '../../public/admin/calendar.js';
import { CALENDAR_SCOPE, SheetAccessError, accessToken, readServiceAccount } from '../students/google.js';

const DAYS_BACK = 7;
const DAYS_AHEAD = 56;
const EVERY_MINUTES = 15;
const TIMEOUT_MS = 60_000;
const MAX_RUNS_KEPT = 100;

const apiBase = () => process.env.GOOGLE_CALENDAR_API_BASE || 'https://www.googleapis.com/calendar/v3';
const timeZone = () => process.env.CALENDAR_TIME_ZONE || 'Asia/Kolkata';
const debounceMs = () => Number(process.env.CALENDAR_DEBOUNCE_MS) || 4000;
const adminEmail = () => process.env.CALENDAR_ADMIN_EMAIL?.trim().toLowerCase() || null;

export function calendarEnabled() {
  if (process.env.CALENDAR_SYNC?.trim().toLowerCase() !== 'on') return false;
  try {
    return Boolean(readServiceAccount());
  } catch {
    return false;
  }
}

/* ---------- talking to Google ---------- */

class GoogleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function google(method, path, body) {
  const key = readServiceAccount();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(key, CALENDAR_SCOPE)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  const detail = await res.json().catch(() => null);
  const reason = detail?.error?.errors?.[0]?.reason ?? '';
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(`${reason} ${detail?.error?.message ?? ''}`)) {
    throw new GoogleError(403, 'The Google Calendar API is turned off for the service account’s Cloud project. Turn it on under APIs & Services > Library > Google Calendar API.');
  }
  if (res.status === 403 || res.status === 429) {
    throw new GoogleError(res.status, 'Google is limiting calendar changes right now. The next update will carry on.');
  }
  throw new GoogleError(res.status, `Google Calendar returned an error (${res.status}${detail?.error?.message ? `: ${detail.error.message}` : ''}).`);
}

const enc = encodeURIComponent;
const gone = (err) => err instanceof GoogleError && (err.status === 404 || err.status === 410);

/* ---------- what each calendar should hold ---------- */

const when = (date, time) => ({ dateTime: `${date}T${time}:00`, timeZone: timeZone() });
const NOTE = 'From the IMS weekly schedule. Changes made here are replaced by the schedule.';

function wantedItems(from, to) {
  const items = [];
  const classes = db.prepare(`
    SELECT c.*, b.name AS batch_name, s.subject, s.topic_code, s.topic, s.area, s.homework, r.name AS room_name
    FROM schedule_classes c
    JOIN batches b ON b.id = c.batch_id
    LEFT JOIN flow_sessions s ON s.id = c.session_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE c.status <> 'cancelled' AND c.faculty_id IS NOT NULL AND c.date BETWEEN ? AND ?`).all(from, to);
  for (const c of classes) {
    const what = [c.topic_code, c.topic].filter(Boolean).join(' ') || c.subject || 'Class';
    items.push({
      key: `class|${c.batch_id}|${c.date}|${c.start_time}|${c.faculty_id}`,
      faculty_id: c.faculty_id,
      date: c.date,
      event: {
        summary: `${c.status === 'done' ? '✓ ' : ''}${c.batch_name} · ${what}`,
        location: c.online ? 'Online' : c.room_name ?? '',
        description: [
          c.subject && `Subject: ${c.subject}`,
          c.area && `Area: ${c.area}`,
          c.homework && `Homework: ${c.homework}`,
          c.note && `Note: ${c.note}`,
          c.status === 'done' && 'Marked done.',
          '',
          NOTE,
        ].filter((line) => line !== false && line != null).join('\n'),
        start: when(c.date, c.start_time),
        end: when(c.date, c.end_time),
      },
    });
  }

  const codes = new Map(db.prepare('SELECT id, code FROM faculties').all().map((f) => [f.id, f.code]));
  const events = db.prepare(`
    SELECT e.*, r.name AS room_name FROM schedule_events e LEFT JOIN rooms r ON r.id = e.room_id
    WHERE e.date BETWEEN ? AND ?`).all(from, to);
  const people = db.prepare('SELECT faculty_id FROM schedule_event_faculty WHERE event_id = ?');
  for (const e of events) {
    const ids = people.all(e.id).map((r) => r.faculty_id);
    for (const facultyId of ids) {
      items.push({
        key: `event|${e.id}|${facultyId}`,
        faculty_id: facultyId,
        date: e.date,
        event: {
          summary: e.title,
          location: e.online ? 'Online' : e.room_name ?? '',
          description: [ids.length > 1 ? `With: ${ids.map((id) => codes.get(id)).filter(Boolean).join(', ')}` : null, '', NOTE].filter((l) => l != null).join('\n'),
          start: when(e.date, e.start_time),
          end: when(e.date, e.end_time),
        },
      });
    }
  }
  return items;
}

const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/* ---------- calendars ---------- */

async function setUpCalendars(counts, problems) {
  const faculties = db.prepare('SELECT id, code, name, email FROM faculties').all();
  const known = new Set(faculties.map((f) => f.id));
  const saved = new Map(db.prepare('SELECT * FROM faculty_calendars').all().map((c) => [c.faculty_id, c]));
  const admin = adminEmail();

  // A deleted faculty's calendar goes too.
  for (const cal of saved.values()) {
    if (known.has(cal.faculty_id)) continue;
    try {
      await google('DELETE', `/calendars/${enc(cal.calendar_id)}`);
    } catch (err) {
      if (!gone(err)) { problems.push(`Removing a deleted faculty’s calendar: ${err.message}`); continue; }
    }
    tx(() => {
      db.prepare('DELETE FROM faculty_calendars WHERE faculty_id = ?').run(cal.faculty_id);
      db.prepare('DELETE FROM calendar_events WHERE faculty_id = ?').run(cal.faculty_id);
    });
  }

  const ready = new Map();
  for (const f of faculties) {
    let cal = saved.get(f.id);
    try {
      if (!f.email) {
        if (cal?.shared_with) {
          await google('DELETE', `/calendars/${enc(cal.calendar_id)}/acl/${enc(`user:${cal.shared_with}`)}`).catch((err) => { if (!gone(err)) throw err; });
          db.prepare('UPDATE faculty_calendars SET shared_with = NULL WHERE faculty_id = ?').run(f.id);
        }
        continue;
      }
      if (!cal) {
        const made = await google('POST', '/calendars', { summary: `IMS schedule – ${f.code}`, description: `Classes and meetings for ${f.name}. ${NOTE}`, timeZone: timeZone() });
        db.prepare('INSERT INTO faculty_calendars (faculty_id, calendar_id) VALUES (?, ?)').run(f.id, made.id);
        cal = { faculty_id: f.id, calendar_id: made.id, shared_with: null, admin_shared: null };
        counts.calendars += 1;
      }
      const share = async (email, role) => google('POST', `/calendars/${enc(cal.calendar_id)}/acl?sendNotifications=true`, { role, scope: { type: 'user', value: email } });
      const unshare = async (email) => google('DELETE', `/calendars/${enc(cal.calendar_id)}/acl/${enc(`user:${email}`)}`).catch((err) => { if (!gone(err)) throw err; });
      if (cal.shared_with !== f.email) {
        if (cal.shared_with) await unshare(cal.shared_with);
        await share(f.email, 'reader');
        db.prepare('UPDATE faculty_calendars SET shared_with = ? WHERE faculty_id = ?').run(f.email, f.id);
      }
      if ((cal.admin_shared ?? null) !== admin) {
        if (cal.admin_shared && cal.admin_shared !== f.email) await unshare(cal.admin_shared);
        if (admin && admin !== f.email) await share(admin, 'reader');
        db.prepare('UPDATE faculty_calendars SET admin_shared = ? WHERE faculty_id = ?').run(admin, f.id);
      }
      ready.set(f.id, { ...cal, code: f.code });
    } catch (err) {
      if (gone(err) && cal) {
        // The calendar was deleted in Google: start it again next time.
        tx(() => {
          db.prepare('DELETE FROM faculty_calendars WHERE faculty_id = ?').run(f.id);
          db.prepare('DELETE FROM calendar_events WHERE faculty_id = ?').run(f.id);
        });
        problems.push(`${f.code}: the calendar was missing in Google, so it will be made again on the next update.`);
      } else {
        problems.push(`${f.code}: ${err.message}`);
        if (err instanceof GoogleError && err.status === 403) throw err; // the API is off, or Google is limiting: stop here
      }
    }
  }
  return ready;
}

/* ---------- one run ---------- */

async function run() {
  const started = new Date().toISOString();
  const counts = { created: 0, updated: 0, deleted: 0, calendars: 0 };
  const problems = [];
  let faculty = 0;
  try {
    const ready = await setUpCalendars(counts, problems);
    faculty = ready.size;
    const today = todayIso();
    const [from, to] = [addDays(today, -DAYS_BACK), addDays(today, DAYS_AHEAD)];
    const wanted = wantedItems(from, to).filter((i) => ready.has(i.faculty_id));
    const wantedKeys = new Set(wanted.map((i) => i.key));
    const sent = new Map(db.prepare('SELECT * FROM calendar_events WHERE date BETWEEN ? AND ?').all(from, to).map((r) => [r.item_key, r]));

    const save = db.prepare('INSERT INTO calendar_events (item_key, faculty_id, calendar_id, date, google_id, hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_key) DO UPDATE SET calendar_id = excluded.calendar_id, date = excluded.date, google_id = excluded.google_id, hash = excluded.hash');
    const forget = db.prepare('DELETE FROM calendar_events WHERE item_key = ?');

    // Removed first, so a class moved to another faculty leaves one calendar before joining the next.
    for (const [key, row] of sent) {
      // A calendar that couldn't be set up this time, or is no longer shared, is left alone.
      if (!ready.has(row.faculty_id)) continue;
      if (wantedKeys.has(key) && ready.get(row.faculty_id).calendar_id === row.calendar_id) continue;
      try {
        await google('DELETE', `/calendars/${enc(row.calendar_id)}/events/${enc(row.google_id)}`);
        counts.deleted += 1;
      } catch (err) {
        if (!gone(err)) { problems.push(`${err.message}`); continue; }
      }
      forget.run(key);
      sent.delete(key);
    }

    for (const item of wanted) {
      const cal = ready.get(item.faculty_id);
      const body = { ...item.event, extendedProperties: { private: { weeklies: item.key } } };
      const hash = hashOf([cal.calendar_id, body]);
      const before = sent.get(item.key);
      if (before?.hash === hash) continue;
      try {
        let googleId = before?.google_id;
        if (googleId) {
          try {
            await google('PUT', `/calendars/${enc(cal.calendar_id)}/events/${enc(googleId)}`, body);
            counts.updated += 1;
          } catch (err) {
            if (!gone(err)) throw err;
            googleId = null; // deleted by hand in Google: add it again
          }
        }
        if (!googleId) {
          googleId = (await google('POST', `/calendars/${enc(cal.calendar_id)}/events`, body)).id;
          counts.created += 1;
        }
        save.run(item.key, item.faculty_id, cal.calendar_id, item.date, googleId, hash);
      } catch (err) {
        problems.push(`${cal.code} ${item.date}: ${err.message}`);
        if (err instanceof GoogleError && err.status === 403) break;
      }
    }
  } catch (err) {
    if (err instanceof GoogleError || err instanceof SheetAccessError) problems.push(err.message);
    else if (err.name === 'TimeoutError' || err.name === 'TypeError') problems.push("Couldn't reach Google. Check the internet connection. The next update will try again.");
    else {
      problems.push('The calendar update failed unexpectedly. See the server log.');
      console.error('Calendar sync error:', err);
    }
  }
  const unique = [...new Set(problems)];
  db.prepare('INSERT INTO calendar_sync_runs (started_at, finished_at, ok, error, created, updated, deleted, faculty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(started, new Date().toISOString(), unique.length ? 0 : 1, unique.length ? unique.slice(0, 5).join(' ') : null, counts.created, counts.updated, counts.deleted, faculty);
  db.prepare('DELETE FROM calendar_sync_runs WHERE id NOT IN (SELECT id FROM calendar_sync_runs ORDER BY id DESC LIMIT ?)').run(MAX_RUNS_KEPT);
  if (unique.length) console.error(`Calendar update: ${unique.join(' ')}`);
  return { ok: !unique.length, ...counts, faculty, problems: unique };
}

/* ---------- when to run ---------- */

let running = null;
let timer = null;

/** Runs an update. If one is already going, waits for it and runs again, so the result covers every change made so far. */
export function runCalendarSync() {
  if (running) return running.then(() => runCalendarSync());
  running = run().finally(() => { running = null; });
  return running;
}

/** After a change: waits a few seconds so a burst of changes goes as one update. */
export function requestCalendarSync() {
  if (!calendarEnabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { runCalendarSync(); }, debounceMs());
  timer.unref?.();
}

export function startCalendarSchedule() {
  if (!calendarEnabled()) return;
  const tick = async () => {
    await runCalendarSync();
    setTimeout(tick, EVERY_MINUTES * 60_000).unref();
  };
  tick();
}

export function calendarStatus() {
  const parse = (r) => r && { ...r, ok: Boolean(r.ok) };
  const faculties = db.prepare('SELECT f.id, f.code, f.email, c.shared_with FROM faculties f LEFT JOIN faculty_calendars c ON c.faculty_id = f.id').all();
  return {
    enabled: calendarEnabled(),
    running: Boolean(running),
    with_email: faculties.filter((f) => f.email).length,
    shared: faculties.filter((f) => f.email && f.shared_with === f.email).length,
    without_email: faculties.filter((f) => !f.email).map((f) => f.code),
    last_run: parse(db.prepare('SELECT * FROM calendar_sync_runs ORDER BY id DESC LIMIT 1').get()) ?? null,
    last_success: parse(db.prepare('SELECT * FROM calendar_sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get()) ?? null,
  };
}
