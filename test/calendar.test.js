import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn } from './sign-in.js';
import { generateServiceKey, startFakeGoogle } from './fake-google.js';
import { addDays, todayIso } from '../public/admin/calendar.js';
import { weekStartOf } from '../src/schedule/generate.js';

// All faculty, emails and batches below are invented.
async function waitForServer(url) {
  for (let i = 0; i < 300; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start');
}

describe('faculty Google calendars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-calendar-'));
  const PORT = 3987;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  const WEEK = weekStartOf(addDays(todayIso(), 7)); // next week: inside the window that is kept in step
  let google;
  let server;
  let ids;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const syncNow = async () => (await call('POST', '/calendars/sync')).body.result;
  const week = async () => (await call('GET', `/schedule?week=${WEEK}`)).body.classes;
  const calendarOf = (code) => [...google.state.calendars.values()].find((c) => c.summary === `IMS schedule – ${code}`);
  const eventsOf = (code) => [...(calendarOf(code)?.events.values() ?? [])].sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
  const faculty = async (code) => (await call('GET', '/state')).body.faculties.find((f) => f.code === code);

  before(async () => {
    google = await startFakeGoogle();
    const key = generateServiceKey(`${google.base}/token`);
    google.state.publicKey = key.publicKey;
    fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(key.json));
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: {
        ...process.env, PORT, DB_PATH: path.join(dir, 'calendar.db'), GOOGLE_SHEET_ID: '', INPUT_SHEET_ID: '',
        GOOGLE_SERVICE_ACCOUNT_KEY: path.join(dir, 'key.json'), GOOGLE_SHEETS_API_BASE: google.base,
        GOOGLE_CALENDAR_API_BASE: `${google.base}/calendar/v3`, CALENDAR_SYNC: 'on', CALENDAR_ADMIN_EMAIL: 'centre@example.com',
        CALENDAR_DEBOUNCE_MS: '300',
      },
      stdio: 'ignore',
    });
    await waitForServer(`${BASE}/state`);
    await signIn(BASE);

    const course = (await call('POST', '/courses', { name: 'Cal CAT', roles: [{ name: 'QA', subject: 'QA' }, { name: 'VARC', subject: 'VARC' }] })).body.id;
    const imported = await call('POST', '/faculties/import', { rows: [
      { code: 'TU', name: 'Test Quant', email: 'TU.Test@Example.com', courses: ['Cal CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'SV', name: 'Test Verbal', email: 'sv@example.com', courses: ['Cal CAT'], subjects: ['VARC'], week_offs: [] },
      { code: 'NB', name: 'No Email', courses: ['Cal CAT'], subjects: ['QA'], week_offs: [] },
    ] });
    assert.equal(imported.status, 200, imported.body?.error);
    const sessions = ['QA', 'VARC', 'QA', 'VARC', 'QA', 'VARC'].map((subject, i) => ({ topic_code: `S${i + 1}`, topic: `Topic ${i + 1}`, subject }));
    await call('POST', '/flows', { course_id: course, name: 'Cal flow', scope: 'course', sessions });
    await call('POST', '/batches', { course_id: course, code: '27CL01' });
    await call('POST', '/rooms', { name: 'Room A', capacity: 50 });
    const s = (await call('GET', '/state')).body;
    const fac = (code) => s.faculties.find((f) => f.code === code).id;
    ids = { TU: fac('TU'), SV: fac('SV'), NB: fac('NB') };
    const b = s.batches[0];
    await call('PUT', `/batches/${b.id}`, {
      name: b.name, year: b.year,
      assignments: b.assignments.map((a) => ({ ...a, faculty_id: a.subject === 'QA' ? ids.TU : ids.SV })),
      timings: [{ weekday: 'Mon', start_time: '18:00', end_time: '20:00' }, { weekday: 'Wed', start_time: '18:00', end_time: '20:00' }, { weekday: 'Fri', start_time: '18:00', end_time: '20:00' }],
    });
    assert.equal((await call('POST', '/schedule/generate', { week: WEEK })).status, 200);
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    await google.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('emails are checked and kept in lower case; a faculty saved without the field keeps theirs', async () => {
    assert.equal((await faculty('TU')).email, 'tu.test@example.com');
    const bad = await call('POST', '/faculties/import', { rows: [{ code: 'TU', email: 'not an email' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /TU: "not an email" is not an email address/);
    const tu = await faculty('TU');
    await call('PUT', `/faculties/${tu.id}`, { code: 'TU', name: 'Test Quant', course_ids: tu.course_ids, subjects: tu.subjects, topics: [], week_offs: [] });
    assert.equal((await faculty('TU')).email, 'tu.test@example.com');
  });

  test('each faculty with an email gets a calendar shared with them and the centre, holding their classes', async () => {
    const result = await syncNow();
    assert.equal(result.ok, true, result.problems?.join(' '));
    assert.equal(google.state.calendars.size, 2, 'NB has no email, so no calendar');
    const tu = calendarOf('TU');
    assert.deepEqual([...tu.acl], [['user:tu.test@example.com', 'reader'], ['user:centre@example.com', 'reader']]);
    assert.equal(tu.timeZone, 'Asia/Kolkata');

    const classes = await week();
    const tuEvents = eventsOf('TU');
    assert.equal(tuEvents.length, classes.filter((c) => c.faculty_code === 'TU').length);
    assert.equal(eventsOf('SV').length, classes.filter((c) => c.faculty_code === 'SV').length);
    const first = classes.find((c) => c.faculty_code === 'TU');
    assert.equal(tuEvents[0].summary, `27CL01 · ${first.topic_code} ${first.topic}`);
    assert.equal(tuEvents[0].location, 'Room A');
    assert.deepEqual(tuEvents[0].start, { dateTime: `${first.date}T18:00:00`, timeZone: 'Asia/Kolkata' });
    assert.match(tuEvents[0].description, /Subject: QA/);

    const status = (await call('GET', '/calendars')).body;
    assert.equal(status.enabled, true);
    assert.equal(status.with_email, 2);
    assert.deepEqual(status.without_email, ['NB']);
  });

  test('nothing is sent again when nothing changed', async () => {
    const before = google.state.calendarCalls.length;
    const result = await syncNow();
    assert.deepEqual([result.created, result.updated, result.deleted], [0, 0, 0]);
    assert.equal(google.state.calendarCalls.length, before);
  });

  test('changes reach the calendars on their own: a moved class is updated, a reassigned one moves calendar', async () => {
    const tuClass = (await week()).find((c) => c.faculty_code === 'TU');
    await call('PUT', `/schedule/classes/${tuClass.id}`, { start_time: '17:00', end_time: '19:00' });
    for (let i = 0; i < 50 && !eventsOf('TU').some((e) => e.start.dateTime.endsWith('T17:00:00')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(eventsOf('TU').some((e) => e.start.dateTime === `${tuClass.date}T17:00:00`), 'updated without pressing anything');

    const tuCount = eventsOf('TU').length;
    const svCount = eventsOf('SV').length;
    await call('PUT', `/schedule/classes/${tuClass.id}`, { faculty_id: ids.SV });
    await syncNow();
    assert.equal(eventsOf('TU').length, tuCount - 1);
    assert.equal(eventsOf('SV').length, svCount + 1);

    await call('PUT', `/schedule/classes/${tuClass.id}`, { status: 'cancelled' });
    await syncNow();
    assert.equal(eventsOf('SV').length, svCount, 'a cancelled class leaves the calendar');
  });

  test('a block with faculty goes in each of their calendars', async () => {
    const block = await call('POST', '/schedule/events', { title: 'Faculty meeting', date: WEEK, start_time: '11:00', end_time: '12:00', faculty_ids: [ids.TU, ids.SV, ids.NB] });
    await syncNow();
    for (const code of ['TU', 'SV']) {
      const meeting = eventsOf(code).find((e) => e.summary === 'Faculty meeting');
      assert.ok(meeting, code);
      assert.match(meeting.description, /With: TU, SV, NB/);
    }
    await call('DELETE', `/schedule/events/${block.body.id}`);
    await syncNow();
    assert.ok(!eventsOf('TU').some((e) => e.summary === 'Faculty meeting'));
  });

  test('an event deleted by hand in Google comes back the next time its class changes', async () => {
    const cal = calendarOf('TU');
    const [goneId, gone] = [...cal.events].find(([, e]) => e.extendedProperties.private.weeklies.startsWith('class|'));
    cal.events.delete(goneId);
    const count = cal.events.size;
    const date = gone.start.dateTime.slice(0, 10);
    const c = (await week()).find((x) => x.faculty_code === 'TU' && x.date === date);
    await call('PUT', `/schedule/classes/${c.id}`, { note: 'Bring calculators' });
    await syncNow();
    assert.equal(cal.events.size, count + 1);
    assert.ok([...cal.events.values()].some((e) => e.start.dateTime.startsWith(date) && /Note: Bring calculators/.test(e.description)));
  });

  test('a changed email moves the sharing; a cleared one stops it; a deleted faculty’s calendar is deleted', async () => {
    const tu = await faculty('TU');
    await call('PUT', `/faculties/${tu.id}`, { code: 'TU', name: tu.name, email: 'tu.new@example.com', course_ids: tu.course_ids, subjects: tu.subjects, topics: [], week_offs: [] });
    await syncNow();
    assert.deepEqual([...calendarOf('TU').acl.keys()], ['user:centre@example.com', 'user:tu.new@example.com']);

    await call('PUT', `/faculties/${tu.id}`, { code: 'TU', name: tu.name, email: '', course_ids: tu.course_ids, subjects: tu.subjects, topics: [], week_offs: [] });
    await syncNow();
    assert.deepEqual([...calendarOf('TU').acl.keys()], ['user:centre@example.com']);

    await call('DELETE', `/faculties/${ids.SV}`);
    await syncNow();
    assert.equal(calendarOf('SV'), undefined);
  });

  test('a Calendar API that is turned off is reported in plain words', async () => {
    const nb = await faculty('NB');
    await call('PUT', `/faculties/${nb.id}`, { code: 'NB', name: nb.name, email: 'nb@example.com', course_ids: nb.course_ids, subjects: nb.subjects, topics: [], week_offs: [] });
    google.state.calendarApiOff = true;
    const result = await syncNow();
    google.state.calendarApiOff = false;
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /Google Calendar API is turned off/);
    assert.match((await call('GET', '/calendars')).body.last_run.error, /turned off/);
    assert.equal((await syncNow()).ok, true, 'and it carries on once it is back');
    assert.ok(calendarOf('NB'));
  });
});
