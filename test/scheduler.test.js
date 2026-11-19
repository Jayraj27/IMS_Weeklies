import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFetch, signIn } from './sign-in.js';
import { unzip } from '../src/unzip.js';
import { chooseFaculty, chooseRoom, generateWeek, subjectMatches, weekStartOf } from '../src/schedule/generate.js';

/* ---------- the rules ---------- */

describe('scheduling rules', () => {
  test('weeks start on Monday', () => {
    assert.equal(weekStartOf('2026-11-16'), '2026-11-16'); // Mon
    assert.equal(weekStartOf('2026-11-22'), '2026-11-16'); // Sun
    assert.equal(weekStartOf('2027-01-01'), '2026-12-28'); // Fri, across a year
  });

  test('subjects match exactly, or by a word of the session subject; nothing looser', () => {
    assert.equal(subjectMatches('QA', 'qa'), true);
    assert.equal(subjectMatches('TEST QA', 'QA'), true);
    assert.equal(subjectMatches('VA', 'VARC'), false);
    assert.equal(subjectMatches('DILR', 'LRDI'), false);
    assert.equal(subjectMatches('QA', ''), false);
  });

  const faculties = new Map([
    [1, { id: 1, code: 'RS', week_offs: ['Sun'] }],
    [2, { id: 2, code: 'PD', week_offs: [] }],
    [3, { id: 3, code: 'AM', week_offs: [] }],
  ]);
  const slots = [
    { role: 'QA1', subject: 'QA', faculty_id: 1, substitute_ids: [2, 3] },
    { role: 'VA1', subject: 'VA', faculty_id: null, substitute_ids: [] },
  ];
  const at = (date) => ({ date, start_time: '10:00', end_time: '12:00', slots, faculties, bookings: [] });

  test('the primary teaches when free', () => {
    assert.deepEqual(chooseFaculty({ ...at('2026-11-21'), subject: 'QA' }), { faculty_id: 1, flags: [] });
  });

  test('a week-off hands the class to the first free substitute, and says why', () => {
    const pick = chooseFaculty({ ...at('2026-11-22'), subject: 'QA' });
    assert.equal(pick.faculty_id, 2);
    assert.match(pick.flags[0], /Covered by PD: RS has Sun off/);
  });

  test('a clash with another batch skips to the next substitute', () => {
    const bookings = [{ faculty_id: 2, date: '2026-11-22', start_time: '11:00', end_time: '13:00', batch_name: '26CA02' }];
    const pick = chooseFaculty({ ...at('2026-11-22'), subject: 'QA', bookings });
    assert.equal(pick.faculty_id, 3);
    assert.match(pick.flags[0], /RS has Sun off; PD is teaching 26CA02 then/);
  });

  test('when nobody can, the class is flagged instead of guessed', () => {
    const bookings = [2, 3].map((id) => ({ faculty_id: id, date: '2026-11-22', start_time: '10:00', end_time: '12:00', batch_name: 'X' }));
    assert.match(chooseFaculty({ ...at('2026-11-22'), subject: 'QA', bookings }).flags[0], /Nobody free/);
    assert.match(chooseFaculty({ ...at('2026-11-21'), subject: 'VA' }).flags[0], /VA1 has no faculty assigned/);
    const missing = chooseFaculty({ ...at('2026-11-21'), subject: 'DILR' });
    assert.equal(missing.faculty_id, null);
    assert.match(missing.flags[0], /no DILR slot.*Its slots are for: QA, VA/);
  });

  const batch = (overrides) => ({
    id: 1, name: '27CA01', start_date: null, end_date: null, slots, occupied: [], unavailable: new Set(),
    timings: [{ weekday: 'Sun', start_time: '13:00', end_time: '15:00' }, { weekday: 'Sun', start_time: '15:00', end_time: '17:00' }, { weekday: 'Wed', start_time: '18:00', end_time: '20:00' }],
    sessions: [{ id: 10, subject: 'MISC' }, { id: 11, subject: 'QA' }, { id: 12, subject: 'QA' }, { id: 13, subject: 'QA' }, { id: 14, subject: 'QA' }],
    ...overrides,
  });

  test('sessions go out in flow order, two a day where a batch meets twice, skipping finished ones', () => {
    const plan = generateWeek({ weekStart: '2026-11-16', batches: [batch({ unavailable: new Set([10]) })], faculties: [...faculties.values()], bookings: [] });
    assert.deepEqual(plan.map((c) => `${c.date} ${c.start_time} ${c.session_id}`), ['2026-11-18 18:00 11', '2026-11-22 13:00 12', '2026-11-22 15:00 13']);
  });

  test('two batches can’t both have the same faculty at the same time', () => {
    const second = batch({ id: 2, name: '27CA02', unavailable: new Set([10]) });
    const plan = generateWeek({ weekStart: '2026-11-16', batches: [batch({ unavailable: new Set([10]) }), second], faculties: [...faculties.values()], bookings: [] });
    const sundayOne = plan.filter((c) => c.date === '2026-11-22' && c.start_time === '13:00');
    assert.equal(sundayOne.length, 2);
    assert.notEqual(sundayOne[0].faculty_id, sundayOne[1].faculty_id);
  });

  describe('when a subject’s faculty can’t come', () => {
    const team = [...faculties.values(), { id: 4, code: 'VK', week_offs: ['Mon'] }];
    const teamSlots = [
      { role: 'QA', subject: 'QA', faculty_id: 1, substitute_ids: [2, 3] },
      { role: 'VA', subject: 'VA', faculty_id: 4, substitute_ids: [] },
      { role: 'MISC', subject: 'MISC', faculty_id: null, substitute_ids: [] },
    ];
    const mondayAndSunday = [{ weekday: 'Mon', start_time: '18:00', end_time: '20:00' }, { weekday: 'Sun', start_time: '13:00', end_time: '15:00' }];
    const plan = (sessions, bookings = []) => generateWeek({
      weekStart: '2026-11-16',
      batches: [batch({ slots: teamSlots, timings: mondayAndSunday, sessions })],
      faculties: team,
      bookings,
    });

    test('the class switches subject, and the skipped session waits for the next class its faculty can take', () => {
      const [monday, sunday] = plan([{ id: 20, subject: 'VA' }, { id: 21, subject: 'VA' }, { id: 22, subject: 'QA' }, { id: 23, subject: 'QA' }]);
      assert.equal(monday.session_id, 22);
      assert.equal(monday.faculty_id, 1);
      assert.match(monday.flags[0], /Switched from VA to QA\. Nobody free: VK has Mon off\./);
      assert.equal(sunday.session_id, 20, 'VA picks up where it left off');
      assert.equal(sunday.faculty_id, 4);
      assert.deepEqual(sunday.flags, []);
    });

    test('every faculty of the subject is tried before switching', () => {
      const busy = [1, 2].map((id) => ({ faculty_id: id, date: '2026-11-16', start_time: '18:00', end_time: '20:00', batch_name: 'X' }));
      const [monday] = plan([{ id: 22, subject: 'QA' }, { id: 20, subject: 'VA' }], busy);
      assert.equal(monday.session_id, 22);
      assert.equal(monday.faculty_id, 3, 'the second substitute takes it');
      assert.match(monday.flags[0], /Covered by AM/);
    });

    test('a substitute in the subject switched to is still reported', () => {
      const busy = [{ faculty_id: 1, date: '2026-11-16', start_time: '18:00', end_time: '20:00', batch_name: 'X' }];
      const [monday] = plan([{ id: 20, subject: 'VA' }, { id: 22, subject: 'QA' }], busy);
      assert.equal(monday.faculty_id, 2);
      assert.match(monday.flags[0], /Switched from VA to QA/);
      assert.match(monday.flags[1], /Covered by PD: RS is teaching X then/);
    });

    test('with nobody free in any subject, the session due next stays, flagged', () => {
      const busy = [1, 2, 3].map((id) => ({ faculty_id: id, date: '2026-11-16', start_time: '18:00', end_time: '20:00', batch_name: 'X' }));
      const [monday] = plan([{ id: 20, subject: 'VA' }, { id: 22, subject: 'QA' }], busy);
      assert.equal(monday.session_id, 20);
      assert.equal(monday.faculty_id, null);
      assert.match(monday.flags[0], /Nobody free: VK has Mon off/);
    });

    test('a subject nobody is assigned to is flagged, not skipped for ever', () => {
      const [monday] = plan([{ id: 30, subject: 'MISC' }, { id: 22, subject: 'QA' }]);
      assert.equal(monday.session_id, 30);
      assert.match(monday.flags[0], /MISC has no faculty assigned/);
    });
  });

  const rooms = [
    { id: 1, name: 'Achievers', capacity: 42 },
    { id: 2, name: 'Believers', capacity: 40 },
    { id: 3, name: 'Creators', capacity: 33 },
    { id: 4, name: 'Store room', capacity: null },
  ];
  const sunday = { date: '2026-11-22', start_time: '13:00', end_time: '15:00' };

  test('the smallest free room that seats the batch is chosen', () => {
    assert.equal(chooseRoom({ ...sunday, size: 30, rooms, bookings: [] }), 3);
    assert.equal(chooseRoom({ ...sunday, size: 35, rooms, bookings: [] }), 2);
    assert.equal(chooseRoom({ ...sunday, size: 41, rooms, bookings: [] }), 1);
  });

  test('a taken room is skipped; the usual room wins when it is free and fits', () => {
    const taken = [{ room_id: 3, ...sunday, start_time: '14:00' }];
    assert.equal(chooseRoom({ ...sunday, size: 30, rooms, bookings: taken }), 2);
    assert.equal(chooseRoom({ ...sunday, size: 30, rooms, bookings: [], preferred: 1 }), 1);
    assert.equal(chooseRoom({ ...sunday, size: 41, rooms, bookings: [], preferred: 2 }), 1, 'a usual room that is too small is passed over');
  });

  test('rooms without a seat count are a last resort, and nothing fitting means no room', () => {
    assert.equal(chooseRoom({ ...sunday, size: 50, rooms, bookings: [] }), 4);
    assert.equal(chooseRoom({ ...sunday, size: 50, rooms: rooms.slice(0, 3), bookings: [] }), null);
  });

  test('generated classes get rooms, keep their room through the week, and online batches get none', () => {
    const plan = generateWeek({
      weekStart: '2026-11-16',
      batches: [batch({ size: 30 }), batch({ id: 2, name: '27CA02', size: 30, online: true })],
      faculties: [...faculties.values()],
      bookings: [],
      rooms,
      roomBookings: [],
    });
    const classroom = plan.filter((c) => c.batch_id === 1);
    assert.ok(classroom.every((c) => c.room_id === 3 && c.online === 0));
    assert.ok(plan.filter((c) => c.batch_id === 2).every((c) => c.room_id === null && c.online === 1));
  });

  test('two batches at the same time get different rooms', () => {
    const plan = generateWeek({
      weekStart: '2026-11-16',
      batches: [batch({ size: 30 }), batch({ id: 2, name: '27CA02', size: 30 })],
      faculties: [...faculties.values()],
      bookings: [],
      rooms,
      roomBookings: [],
    });
    const atOne = plan.filter((c) => c.date === '2026-11-22' && c.start_time === '13:00');
    assert.deepEqual(atOne.map((c) => c.room_id).sort(), [2, 3]);
  });

  test('batch dates, kept classes and an exhausted flow are respected', () => {
    const plan = generateWeek({
      weekStart: '2026-11-16',
      batches: [batch({ start_date: '2026-11-20', occupied: [{ date: '2026-11-22', start_time: '13:00' }], sessions: [{ id: 11, subject: 'QA' }] })],
      faculties: [...faculties.values()],
      bookings: [],
    });
    assert.deepEqual(plan.map((c) => [c.date, c.start_time, c.session_id]), [['2026-11-22', '15:00', 11]]);
    const empty = generateWeek({ weekStart: '2026-11-16', batches: [batch({ sessions: [] })], faculties: [...faculties.values()], bookings: [] });
    assert.ok(empty.every((c) => c.session_id === null && /No sessions left/.test(c.flags[0])));
  });
});

/* ---------- through the server ---------- */

describe('schedule API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-scheduler-'));
  const PORT = 3983;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  const WEEK = '2026-11-16';
  let server;
  let ids;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const state = async () => (await call('GET', '/state')).body;
  const week = async (query = '') => (await call('GET', `/schedule?week=${WEEK}${query}`)).body.classes;

  before(async () => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: { ...process.env, PORT, DB_PATH: path.join(dir, 'scheduler.db'), GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 300; i++) {
      try {
        await fetch(`${BASE}/state`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await signIn(BASE);

    const course = (await call('POST', '/courses', { name: 'Sched CAT', roles: [{ name: 'QA1', subject: 'QA' }, { name: 'VARC1', subject: 'VARC' }] })).body.id;
    await call('POST', '/faculties/import', { rows: [
      { code: 'TU', name: 'Primary Quant', courses: ['Sched CAT'], subjects: ['QA'], week_offs: ['Sun'] },
      { code: 'PS', name: 'Sub Quant', courses: ['Sched CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'SV', name: 'Verbal', courses: ['Sched CAT'], subjects: ['VARC'], week_offs: [] },
    ] });
    const sessions = [
      { topic_code: 'DWC', topic: 'A Date with CAT', subject: 'MISC' },
      { topic_code: 'QA 0.1', topic: 'Fun with QA', subject: 'QA' },
      { topic_code: 'VA', topic: 'Orientation to Reading', subject: 'VA' },
      { topic_code: 'QA 1.5A', topic: 'Percentages (A)', subject: 'QA' },
      { topic_code: 'Test', topic: 'Test QA 1.5', subject: 'TEST QA' },
      { topic_code: 'QA 1.5B', topic: 'Percentages (B)', subject: 'QA' },
    ];
    await call('POST', '/flows', { course_id: course, name: 'CAT 2027', scope: 'course', sessions });
    for (const code of ['27CA01', '27CA02', '27CA07']) await call('POST', '/batches', { course_id: course, code });
    await call('POST', '/rooms', { name: 'Big Room', capacity: 60 });
    await call('POST', '/rooms', { name: 'Small Room', capacity: 1 });

    const s = await state();
    const batch = (name) => s.batches.find((b) => b.name === name);
    const fac = (code) => s.faculties.find((f) => f.code === code).id;
    ids = { course, b1: batch('27CA01'), b2: batch('27CA02'), b7: batch('27CA07'), TU: fac('TU'), PS: fac('PS'), SV: fac('SV'), flow: s.flows[0] };

    for (const b of [ids.b1, ids.b2]) {
      await call('PUT', `/batches/${b.id}`, {
        name: b.name, year: b.year,
        assignments: b.assignments.map((a) => (a.role === 'QA1' ? { ...a, faculty_id: ids.TU, substitute_ids: [ids.PS] } : { ...a, faculty_id: ids.SV })),
        timings: [{ weekday: 'Sun', start_time: '13:00', end_time: '15:00' }, { weekday: 'Sun', start_time: '15:00', end_time: '17:00' }],
      });
    }
    // 27CA01 has already finished the first session.
    await call('PUT', `/batches/${ids.b1.id}/progress`, { finished: [ids.flow.sessions[0].id] });
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a week can only be read or generated when signed in, and needs a real date', async () => {
    const anon = await realFetch(`${BASE}/schedule?week=${WEEK}`);
    assert.equal(anon.status, 401);
    assert.equal((await call('GET', '/schedule?week=2026-02-30')).status, 400);
    assert.equal((await call('POST', '/schedule/generate', { week: 'soon' })).status, 400);
  });

  test('generating plans every batch with class times, and says which it skipped', async () => {
    const res = await call('POST', '/schedule/generate', { week: '2026-11-19' });
    assert.equal(res.status, 200, res.body?.error);
    assert.equal(res.body.week, WEEK, 'any date picks its Monday');
    assert.equal(res.body.batches, 2);
    assert.equal(res.body.created, 4);

    const single = await call('POST', '/schedule/generate', { week: WEEK, batch_id: ids.b7.id });
    assert.equal(single.body.created, 0);
    assert.match(single.body.skipped[0].reason, /no class times/);
  });

  test('the plan follows each batch’s position, covers week-offs, and flags subject-name mismatches', async () => {
    const classes = await week();
    const of = (name) => classes.filter((c) => c.batch_name === name);
    // 27CA01 finished session 1, so it starts at 2; 27CA02 starts at 1.
    assert.deepEqual(of('27CA01').map((c) => c.topic_code), ['QA 0.1', 'VA']);
    assert.deepEqual(of('27CA02').map((c) => c.topic_code), ['DWC', 'QA 0.1']);

    const quant = classes.filter((c) => c.subject === 'QA');
    // TU has Sundays off, so PS covers; both batches want PS, but at different times.
    assert.ok(quant.every((c) => c.faculty_code === 'PS'), JSON.stringify(quant.map((c) => c.faculty_code)));
    assert.ok(quant.every((c) => /Covered by PS: TU has Sun off/.test(c.flags[0])));
    assert.notEqual(quant[0].start_time, quant[1].start_time);

    const verbal = of('27CA01').find((c) => c.subject === 'VA');
    assert.equal(verbal.faculty_id, null);
    assert.match(verbal.flags[0], /no VA slot.*QA, VARC/);
    const misc = of('27CA02').find((c) => c.subject === 'MISC');
    assert.match(misc.flags[0], /no MISC slot/);
  });

  test('changing a class by hand is kept, checked, and warned about', async () => {
    const [first] = await week(`&batch=${ids.b1.id}`);
    const res = await call('PUT', `/schedule/classes/${first.id}`, { faculty_id: ids.TU });
    assert.equal(res.status, 200);
    const after = (await week(`&batch=${ids.b1.id}`))[0];
    assert.equal(after.faculty_code, 'TU');
    assert.equal(after.edited, true);
    assert.deepEqual(after.flags, [], 'the generator’s note no longer applies once someone chooses');
    assert.ok(after.warnings.includes('TU has Sun off.'), JSON.stringify(after.warnings));

    const otherFlow = await call('PUT', `/schedule/classes/${first.id}`, { session_id: 999999 });
    assert.equal(otherFlow.status, 400);
    assert.equal((await call('PUT', `/schedule/classes/${first.id}`, { status: 'maybe' })).status, 400);
    assert.equal((await call('PUT', '/schedule/classes/999999', { status: 'done' })).status, 404);
  });

  test('marking a class done records its session; undoing removes it again', async () => {
    const [first] = await week(`&batch=${ids.b1.id}`);
    await call('PUT', `/schedule/classes/${first.id}`, { status: 'done' });
    let progress = (await state()).batches.find((b) => b.id === ids.b1.id).progress;
    assert.equal(progress.done, 2);
    assert.equal(progress.next.topic_code, 'VA');

    await call('PUT', `/schedule/classes/${first.id}`, { status: 'planned' });
    progress = (await state()).batches.find((b) => b.id === ids.b1.id).progress;
    assert.equal(progress.done, 1);
    await call('PUT', `/schedule/classes/${first.id}`, { status: 'done' });
  });

  test('regenerating keeps done and cancelled classes, replaces the rest, and continues the flow', async () => {
    const before = await week(`&batch=${ids.b1.id}`);
    await call('PUT', `/schedule/classes/${before[1].id}`, { status: 'cancelled' });
    const res = await call('POST', '/schedule/generate', { week: WEEK, batch_id: ids.b1.id });
    assert.equal(res.body.created, 0, 'both class times are kept, so nothing new is needed');

    const next = await call('POST', '/schedule/generate', { week: '2026-11-23', batch_id: ids.b1.id });
    assert.equal(next.body.created, 2);
    const following = (await call('GET', `/schedule?week=2026-11-23&batch=${ids.b1.id}`)).body.classes;
    // Session 2 is done; session 3 was cancelled last week, so it comes up again.
    assert.deepEqual(following.map((c) => c.topic_code), ['VA', 'QA 1.5A']);
  });

  test('mark week done confirms every planned class with a session', async () => {
    const res = await call('POST', '/schedule/done', { week: WEEK, batch_id: ids.b2.id });
    assert.equal(res.body.done, 2);
    const progress = (await state()).batches.find((b) => b.id === ids.b2.id).progress;
    assert.equal(progress.done, 2);
    assert.ok((await week(`&batch=${ids.b2.id}`)).every((c) => c.status === 'done'));
  });

  test('moving a class to another room or time shows clashes as soon as the week is read', async () => {
    const rooms = (await state()).rooms;
    const small = rooms.find((r) => r.name === 'Small Room').id;
    const big = rooms.find((r) => r.name === 'Big Room').id;
    const [a, b] = (await call('GET', `/schedule?week=2026-11-23`)).body.classes.filter((c) => c.date === '2026-11-29' && c.status !== 'cancelled');
    assert.ok(a && b, 'two classes to work with');

    // Same room, same time: both are flagged. Too small a room is flagged too.
    await call('PUT', `/schedule/classes/${a.id}`, { room_id: small, start_time: '13:00', end_time: '15:00' });
    await call('PUT', `/schedule/classes/${b.id}`, { room_id: small, start_time: '14:00', end_time: '16:00' });
    let week = (await call('GET', '/schedule?week=2026-11-23')).body.classes;
    const warn = (id) => week.find((c) => c.id === id).warnings.join(' ');
    assert.match(warn(a.id), /Small Room is also booked for/);
    assert.match(warn(b.id), /Small Room is also booked for/);

    // Moving one away clears the clash; online needs no room.
    await call('PUT', `/schedule/classes/${b.id}`, { online: true });
    week = (await call('GET', '/schedule?week=2026-11-23')).body.classes;
    assert.doesNotMatch(warn(a.id), /also booked/);
    assert.equal(week.find((c) => c.id === b.id).room_id, null);
    assert.equal(week.find((c) => c.id === b.id).online, true);
    assert.equal(week.find((c) => c.id === b.id).edited, true);

    await call('PUT', `/schedule/classes/${a.id}`, { room_id: big });
    assert.equal((await call('PUT', `/schedule/classes/${a.id}`, { start_time: '15:00', end_time: '14:00' })).status, 400);
    assert.equal((await call('PUT', `/schedule/classes/${a.id}`, { date: '2026-02-30' })).status, 400);
    assert.equal((await call('PUT', `/schedule/classes/${a.id}`, { room_id: 999999 })).status, 404);
  });

  test('a meeting block takes its room and faculty out of the generator’s hands, and shows clashes', async () => {
    const rooms = (await state()).rooms;
    const big = rooms.find((r) => r.name === 'Big Room').id;
    const made = await call('POST', '/schedule/events', {
      title: 'IPMAT 2027 planning', date: '2026-12-06', start_time: '13:00', end_time: '17:00', room_id: big, faculty_ids: [ids.PS, ids.SV],
    });
    assert.equal(made.status, 201, made.body?.error);
    const gen = await call('POST', '/schedule/generate', { week: '2026-11-30', batch_id: ids.b2.id });
    assert.equal(gen.status, 200);
    const plan = (await call('GET', '/schedule?week=2026-11-30')).body;
    const sunday = plan.classes.filter((c) => c.date === '2026-12-06');
    assert.ok(sunday.length);
    assert.ok(sunday.every((c) => c.room_id !== big), 'the meeting’s room is not given to a class');
    assert.ok(sunday.every((c) => c.faculty_code !== 'PS' && c.faculty_code !== 'SV'), JSON.stringify(sunday.map((c) => c.faculty_code)));
    assert.equal(plan.events.length, 1);
    assert.deepEqual(plan.events[0].faculty_ids.sort(), [ids.PS, ids.SV].sort());

    // Putting a class in the meeting's room flags both.
    await call('PUT', `/schedule/classes/${sunday[0].id}`, { room_id: big });
    const after = (await call('GET', '/schedule?week=2026-11-30')).body;
    assert.match(after.events[0].warnings.join(' '), /Big Room is also booked/);
    assert.equal((await call('GET', `/schedule?week=2026-11-30&batch=${ids.b2.id}`)).body.events.length, 0, 'blocks show only on the all-batches view');

    assert.equal((await call('PUT', `/schedule/events/${made.body.id}`, { title: '' })).status, 400);
    assert.equal((await call('PUT', `/schedule/events/${made.body.id}`, { start_time: '14:00' })).status, 200);
    assert.equal((await call('POST', '/schedule/events', { title: 'x', date: '2026-12-06', start_time: '13:00', end_time: '12:00' })).status, 400);
    assert.equal((await call('DELETE', `/schedule/events/${made.body.id}`)).status, 204);
    assert.equal((await call('DELETE', `/schedule/events/${made.body.id}`)).status, 404);
  });

  test('marking a batch online moves its next generated classes to the Online column', async () => {
    const b = (await state()).batches.find((x) => x.id === ids.b2.id);
    assert.equal((await call('PUT', `/batches/${b.id}`, { name: b.name, year: b.year, assignments: b.assignments, mode: 'online' })).status, 200);
    assert.equal((await call('PUT', `/batches/${b.id}`, { name: b.name, year: b.year, assignments: b.assignments, mode: 'hybrid' })).status, 400);
    await call('POST', '/schedule/generate', { week: '2026-12-07', batch_id: b.id });
    const classes = (await call('GET', `/schedule?week=2026-12-07&batch=${b.id}`)).body.classes;
    assert.ok(classes.length && classes.every((c) => c.online && c.room_id === null));
  });

  test('a done class needs a session', async () => {
    const [cls] = (await call('GET', `/schedule?week=2026-11-23&batch=${ids.b1.id}`)).body.classes;
    await call('PUT', `/schedule/classes/${cls.id}`, { session_id: null });
    const res = await call('PUT', `/schedule/classes/${cls.id}`, { status: 'done' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Choose the session/);
  });

  test('the week downloads as one spreadsheet: the week in one tab, plus every class', async () => {
    assert.equal((await realFetch(`${BASE}/schedule/export?week=${WEEK}`)).status, 401);
    assert.equal((await fetch(`${BASE}/schedule/export?week=someday`)).status, 400);

    const res = await fetch(`${BASE}/schedule/export?week=${WEEK}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="schedule-week-of-2026-11-16\.xlsx"/);
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ['Week of 16 Nov', 'All classes']);

    const classes = await week();
    const grid = files['xl/worksheets/sheet1.xml'];
    assert.match(grid, /Big Room – 60/);
    assert.match(grid, /Sunday, 22 Nov/);
    for (const c of classes.filter((x) => x.status !== 'cancelled')) assert.ok(grid.includes(c.batch_name), c.batch_name);
    const list = files['xl/worksheets/sheet2.xml'];
    assert.equal((list.match(/<row /g) ?? []).length, classes.length + 1, 'a heading row and one row per class');
  });
});
