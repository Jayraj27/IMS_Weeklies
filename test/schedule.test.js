import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn } from './sign-in.js';
import {
  addDays, classesBetween, describeTiming, findOverlap, formatDate, formatTime, groupTimings, isIsoDate,
  parseDateText, parseDays, parseTime, parseTimeRange, weekdayOf,
} from '../public/admin/calendar.js';
import { parseAssignmentUpload, parseFacultyUpload, parseTimetableUpload, splitTopics } from '../public/admin/imports.js';

describe('calendar', () => {
  test('dates know their weekday, across months, years and leap days', () => {
    assert.equal(weekdayOf('2026-11-05'), 'Thu');
    assert.equal(weekdayOf('2026-11-08'), 'Sun');
    assert.equal(weekdayOf('2028-02-29'), 'Tue');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
    assert.equal(formatDate('2026-11-05'), '5 Nov 2026');
  });

  test('impossible dates are refused', () => {
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('2027-02-29'), false);
    assert.equal(isIsoDate('2028-02-29'), true);
  });

  test('classes fall on the right dates, within the batch dates, in time order', () => {
    const timings = [
      { weekday: 'Sat', start_time: '14:00', end_time: '16:00' },
      { weekday: 'Sat', start_time: '09:00', end_time: '12:00' },
      { weekday: 'Mon', start_time: '18:00', end_time: '20:00' },
    ];
    // Thu 5 Nov to Mon 16 Nov 2026
    const classes = classesBetween(timings, { from: '2026-11-05', to: '2026-11-16' });
    assert.deepEqual(classes.map((c) => `${c.date} ${c.weekday} ${c.start_time}`), [
      '2026-11-07 Sat 09:00', '2026-11-07 Sat 14:00', '2026-11-09 Mon 18:00',
      '2026-11-14 Sat 09:00', '2026-11-14 Sat 14:00', '2026-11-16 Mon 18:00',
    ]);
    const limited = classesBetween(timings, { from: '2026-11-05', to: '2026-11-30', startDate: '2026-11-09', endDate: '2026-11-14' });
    assert.deepEqual(limited.map((c) => c.date), ['2026-11-09', '2026-11-14', '2026-11-14']);
    assert.deepEqual(classesBetween(timings, { from: '2026-11-05', to: '2026-11-30', endDate: '2026-11-01' }), []);
  });

  test('overlapping classes are found; back-to-back and other days are fine', () => {
    const t = (weekday, start_time, end_time) => ({ weekday, start_time, end_time });
    assert.ok(findOverlap([t('Sat', '09:00', '12:00'), t('Sat', '11:00', '13:00')]));
    assert.equal(findOverlap([t('Sat', '09:00', '12:00'), t('Sat', '12:00', '14:00')]), null);
    assert.equal(findOverlap([t('Sat', '09:00', '12:00'), t('Sun', '09:00', '12:00')]), null);
  });

  test('days with the same hours are shown together', () => {
    const groups = groupTimings([
      { weekday: 'Wed', start_time: '18:00', end_time: '20:00' },
      { weekday: 'Sat', start_time: '09:00', end_time: '12:00' },
      { weekday: 'Mon', start_time: '18:00', end_time: '20:00' },
    ]);
    assert.deepEqual(groups.map(describeTiming), ['Mon, Wed 6:00 pm – 8:00 pm', 'Sat 9:00 am – 12:00 pm']);
    assert.equal(formatTime('00:30'), '12:30 am');
    assert.equal(formatTime('12:00'), '12:00 pm');
  });
});

describe('reading what people type', () => {
  test('weekdays', () => {
    assert.deepEqual(parseDays('Mon, Wed & Fri').days, ['Mon', 'Wed', 'Fri']);
    assert.deepEqual(parseDays('Monday and thursday').days, ['Mon', 'Thu']);
    assert.deepEqual(parseDays('Mon-Fri').days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    assert.deepEqual(parseDays('Monday to Wednesday').days, ['Mon', 'Tue', 'Wed']);
    assert.deepEqual(parseDays('Sat-Mon').days, ['Mon', 'Sat', 'Sun']);
    assert.deepEqual(parseDays('None').days, []);
    assert.deepEqual(parseDays('').days, []);
    assert.deepEqual(parseDays('Sun, Funday').bad, ['Funday']);
  });

  test('times', () => {
    assert.equal(parseTime('9:30 AM').time, '09:30');
    assert.equal(parseTime('5 pm').time, '17:00');
    assert.equal(parseTime('12:00 PM').time, '12:00');
    assert.equal(parseTime('12:00 AM').time, '00:00');
    assert.equal(parseTime('17:30').time, '17:30');
    assert.equal(parseTime('9.30').time, '09:30');
    assert.equal(parseTime('6:00:00 PM').time, '18:00');
    assert.equal(parseTime('12:30').time, '12:30');
  });

  test('a time that would silently become early morning is refused', () => {
    assert.match(parseTime('5:00').error, /AM or PM/);
    assert.match(parseTime('13 pm').error, /not a time/);
    assert.match(parseTime('soon').error, /not a time/);
    assert.match(parseTime('25:00').error, /not a time/);
  });

  test('time ranges', () => {
    assert.deepEqual(parseTimeRange('9:00 AM - 12:00 PM'), { start: '09:00', end: '12:00' });
    assert.deepEqual(parseTimeRange('6-8 pm'), { start: '18:00', end: '20:00' });
    assert.deepEqual(parseTimeRange('10 - 1 PM'), { start: '10:00', end: '13:00' });
    assert.deepEqual(parseTimeRange('18:00 to 20:00'), { start: '18:00', end: '20:00' });
    assert.match(parseTimeRange('morning').error, /should look like/);
    assert.match(parseTimeRange('2:00 - 5:00').error, /AM or PM/);
  });

  test('dates, day first as in India', () => {
    assert.equal(parseDateText('1/7/2026'), '2026-07-01');
    assert.equal(parseDateText('15-02-2027'), '2027-02-15');
    assert.equal(parseDateText('7/26/2026'), '2026-07-26');
    assert.equal(parseDateText('1 Jul 2026'), '2026-07-01');
    assert.equal(parseDateText('1-Jul-26'), '2026-07-01');
    assert.equal(parseDateText('July 1, 2026'), '2026-07-01');
    assert.equal(parseDateText('2026-07-01'), '2026-07-01');
    assert.equal(parseDateText('31/02/2026'), null);
    assert.equal(parseDateText('soon'), null);
  });

  test('topics split on semicolons first, so names with commas survive', () => {
    assert.deepEqual(splitTopics('Ratio,Proportion and Variation; SI-CI'), ['Ratio,Proportion and Variation', 'SI-CI']);
    assert.deepEqual(splitTopics('QA 1.5A, QA 1.6A'), ['QA 1.5A', 'QA 1.6A']);
  });
});

describe('upload files', () => {
  test('faculty: columns by heading, rows with the same code combine, left-out columns stay out', () => {
    const { rows, problems } = parseFacultyUpload([
      'Name\tFaculty Code\tCourse\tSubject\tTopics\tWeek Off\tExtra',
      'Riya Shah\tRS01\tCAT\tQA\tArithmetic; QA 1.5A\tSunday\tignored',
      '\trs01\tCMAT\tQA, DILR\t\tWed\t',
    ].join('\n'));
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, [{
      code: 'RS01', name: 'Riya Shah', courses: ['CAT', 'CMAT'], subjects: ['QA', 'DILR'],
      topics: ['Arithmetic', 'QA 1.5A'], week_offs: ['Sun', 'Wed'],
    }]);
    const partial = parseFacultyUpload('Faculty Code\tWeek-offs\nRS01\tMon').rows[0];
    assert.deepEqual(Object.keys(partial).sort(), ['code', 'name', 'week_offs']);
  });

  test('faculty: problems are reported by line', () => {
    const { problems } = parseFacultyUpload('Faculty Code\tName\tWeek-offs\nRS01\tRiya\tFunday\n\tNo code\tSun\nRS01\tSomeone Else\tSun');
    assert.equal(problems.length, 3);
    assert.match(problems.join(' '), /Line 4: RS01 is also named "Riya"/);
    assert.match(problems.join(' '), /Line 2: "Funday"/);
    assert.match(problems.join(' '), /Line 3: Faculty Code is missing/);
    assert.match(parseFacultyUpload('Name\nRiya').problems[0], /heading row/);
  });

  test('assignments: several Substitute columns add up', () => {
    const { rows } = parseAssignmentUpload('Batch\tSlot\tFaculty Code\tSubstitute 1\tSubstitute 2\n26CA02\tQA1\tRS01\tAM02\tPD04\n26CA02\tVRC1\t\t\t');
    assert.deepEqual(rows[0], { batch: '26CA02', slot: 'QA1', subject: '', faculty: 'RS01', substitutes: ['AM02', 'PD04'] });
    assert.deepEqual(rows[1].substitutes, []);
    assert.equal(rows[1].faculty, '');
  });

  test('timetable: separate time columns or one Timing column, with dates', () => {
    const { rows, problems } = parseTimetableUpload('Batch\tWeekdays\tStart Time\tEnd Time\tStart Date\n26CA02\tMon, Wed\t6:00 PM\t8:00 PM\t1/7/2026\n26CA02\tSat\t9:00 AM\t12:00 PM\t');
    assert.deepEqual(problems, []);
    assert.deepEqual(rows[0], { batch: '26CA02', days: ['Mon', 'Wed'], start: '18:00', end: '20:00', start_date: '2026-07-01' });
    assert.deepEqual(parseTimetableUpload('Batch Code\tDays\tTiming\n26CA02\tSat-Sun\t9-12 pm').rows[0].days, ['Sat', 'Sun']);
  });

  test('timetable: unreadable values are refused by line, not guessed', () => {
    const { problems } = parseTimetableUpload([
      'Batch\tWeekdays\tStart Time\tEnd Time\tStart Date',
      '26CA02\tFunday\t6:00 PM\t8:00 PM\t',
      '26CA03\tMon\t2:00\t5:00\t',
      '26CA04\tMon\t8:00 PM\t6:00 PM\t',
      '26CA05\tMon\t6:00 PM\t8:00 PM\t31/02/2026',
      '26CA06\tMon\t\t\t',
    ].join('\n'));
    assert.equal(problems.filter((p) => p.startsWith('Line 2')).length, 1);
    assert.match(problems.join(' '), /Line 3: "2:00" needs AM or PM/);
    assert.match(problems.join(' '), /Line 4: the class must end after/);
    assert.match(problems.join(' '), /Line 5: "31\/02\/2026"/);
    assert.match(problems.join(' '), /Line 6: needs a start and end time/);
  });
});

describe('through the server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-schedule-'));
  const PORT = 3979;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  let server;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const state = async () => (await call('GET', '/state')).body;
  const faculty = async (code) => (await state()).faculties.find((f) => f.code === code);
  const batch = async (name) => (await state()).batches.find((b) => b.name === name);

  before(async () => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: { ...process.env, PORT, DB_PATH: path.join(dir, 'schedule.db'), GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '' },
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
    const cat = (await state()).courses.find((c) => c.name === 'CAT');
    await call('POST', '/batches', { course_id: cat.id, code: '26CA02' });
    await call('POST', '/batches', { course_id: cat.id, code: 'eCAT26 : 101' });
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('faculty upload adds new codes, updates known ones and leaves left-out details alone', async () => {
    const first = await call('POST', '/faculties/import', { rows: [
      { code: 'RS01', name: 'Riya Shah', courses: ['cat', 'CMAT'], subjects: ['QA'], topics: ['Arithmetic', 'QA 1.5A'], week_offs: ['Sun'] },
      { code: 'AM02', name: 'Arjun Mehta', courses: ['CAT'], subjects: ['QA', 'VA'], topics: [], week_offs: ['Mon'] },
      { code: 'PD04', name: 'Priya Desai', courses: ['CAT'], subjects: ['QA'], topics: [], week_offs: [] },
    ] });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { added: 3, updated: 0 });

    const second = await call('POST', '/faculties/import', { rows: [{ code: 'rs01', name: '', week_offs: ['Sat'] }] });
    assert.deepEqual(second.body, { added: 0, updated: 1 });
    const riya = await faculty('RS01');
    assert.equal(riya.name, 'Riya Shah', 'a blank name keeps the old one, and the code keeps its spelling');
    assert.deepEqual(riya.week_offs, ['Sat']);
    assert.deepEqual(riya.topics, ['Arithmetic', 'QA 1.5A']);
    assert.equal(riya.course_ids.length, 2);
    assert.equal((await state()).faculties.length, 3);
  });

  test('a faulty faculty upload changes nothing and says why', async () => {
    const res = await call('POST', '/faculties/import', { rows: [
      { code: 'GOOD1', name: 'Fine Person', courses: ['CAT'] },
      { code: 'BAD1', name: 'Bad Course', courses: ['Astrology'] },
      { code: 'BAD2' },
    ] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Nothing was changed/);
    assert.match(res.body.error, /Astrology/);
    assert.match(res.body.error, /BAD2: a new faculty needs a name/);
    assert.equal(await faculty('GOOD1'), undefined);
  });

  test('topics also save through the single faculty form', async () => {
    const made = await call('POST', '/faculties', { code: 'TP9', name: 'Topic Person', topics: ['Numbers', 'numbers', 'Algebra'] });
    assert.deepEqual((await faculty('TP9')).topics, ['Algebra', 'numbers']);
    assert.equal((await call('DELETE', `/faculties/${made.body.id}`)).status, 204);
  });

  test('batch form saves primary, substitutes, timetable and dates together', async () => {
    const [b, riya, arjun, priya] = [await batch('26CA02'), await faculty('RS01'), await faculty('AM02'), await faculty('PD04')];
    const assignments = b.assignments.map((a) => (a.role === 'QA1' ? { ...a, faculty_id: riya.id, substitute_ids: [priya.id, arjun.id] } : a));
    const res = await call('PUT', `/batches/${b.id}`, {
      name: b.name, year: b.year, assignments,
      start_date: '2026-07-01', end_date: '2027-03-31',
      timings: [
        { weekday: 'Mon', start_time: '18:00', end_time: '20:00' },
        { weekday: 'Sat', start_time: '09:00', end_time: '12:00' },
      ],
    });
    assert.equal(res.status, 200, res.body?.error);
    const after = await batch('26CA02');
    const qa1 = after.assignments.find((a) => a.role === 'QA1');
    assert.equal(qa1.faculty_id, riya.id);
    assert.deepEqual(qa1.substitute_ids, [priya.id, arjun.id], 'order of preference is kept');
    assert.equal(after.timings.length, 2);
    assert.equal(after.start_date, '2026-07-01');
    assert.equal(after.end_date, '2027-03-31');
  });

  test('batch form refuses impossible input and keeps what is there', async () => {
    const b = await batch('26CA02');
    const base = { name: b.name, year: b.year, assignments: b.assignments };
    const riya = await faculty('RS01');
    const t = (weekday, start_time, end_time) => ({ weekday, start_time, end_time });
    const attempts = [
      [{ ...base, assignments: b.assignments.map((a) => (a.role === 'QA1' ? { ...a, substitute_ids: [riya.id] } : a)) }, /primary faculty/],
      [{ ...base, timings: [t('Sat', '09:00', '12:00'), t('Sat', '11:00', '13:00')] }, /overlap/],
      [{ ...base, timings: [t('Sat', '12:00', '09:00')] }, /must end after/],
      [{ ...base, timings: [t('Funday', '09:00', '12:00')] }, /not a day/],
      [{ ...base, timings: [t('Sat', '9 am', '12:00')] }, /start and end time/],
      [{ ...base, start_date: '2026-02-30' }, /not a real date/],
      [{ ...base, start_date: '2027-01-01', end_date: '2026-01-01' }, /before the start/],
    ];
    for (const [body, pattern] of attempts) {
      const res = await call('PUT', `/batches/${b.id}`, body);
      assert.equal(res.status, 400);
      assert.match(res.body.error, pattern);
    }
    const after = await batch('26CA02');
    assert.equal(after.timings.length, 2);
    assert.equal(after.start_date, '2026-07-01');
  });

  test('saving a batch without timetable fields leaves its timetable alone', async () => {
    const b = await batch('26CA02');
    await call('PUT', `/batches/${b.id}`, { name: b.name, year: b.year, assignments: b.assignments });
    const after = await batch('26CA02');
    assert.equal(after.timings.length, 2);
    assert.equal(after.end_date, '2027-03-31');
  });

  test('assignment upload changes only listed slots, adds new ones and notes other-course faculty', async () => {
    await call('POST', '/faculties/import', { rows: [{ code: 'NK03', name: 'Neha Kapoor', courses: ['CLAT'] }] });
    const res = await call('POST', '/batches/assignments/import', { rows: [
      { batch: '26 ca02', slot: 'qa2', subject: '', faculty: 'AM02', substitutes: ['RS01'] },
      { batch: 'eCAT26:101', slot: 'Mentor', subject: '', faculty: 'PD04', substitutes: [] },
      { batch: '26CA02', slot: 'Doubt Desk', subject: 'QA', faculty: 'NK03', substitutes: [] },
    ] });
    assert.equal(res.status, 200, res.body?.error);
    assert.deepEqual([res.body.updated, res.body.slots_added, res.body.batches], [3, 1, 2]);
    assert.deepEqual(res.body.outside_course, ['NK03 in 26CA02']);

    const after = await batch('26CA02');
    const [riya, arjun] = [await faculty('RS01'), await faculty('AM02')];
    const roles = after.assignments.map((a) => a.role);
    assert.deepEqual(roles.slice(0, 3), ['Mentor', 'QA1', 'QA2'], 'order stays put and the slot keeps its spelling');
    assert.equal(after.assignments.find((a) => a.role === 'QA2').faculty_id, arjun.id);
    assert.deepEqual(after.assignments.find((a) => a.role === 'QA2').substitute_ids, [riya.id]);
    assert.equal(after.assignments.find((a) => a.role === 'QA1').faculty_id, riya.id, 'unlisted slot untouched');
    assert.equal(after.assignments.at(-1).role, 'Doubt Desk');
    assert.equal(after.assignments.at(-1).subject, 'QA');
  });

  test('a faulty assignment upload changes nothing', async () => {
    const before = await batch('26CA02');
    const res = await call('POST', '/batches/assignments/import', { rows: [
      { batch: '26CA02', slot: 'QA1', faculty: 'PD04', substitutes: [] },
      { batch: 'NOPE99', slot: 'QA1', faculty: 'PD04', substitutes: [] },
      { batch: '26CA02', slot: 'QA2', faculty: 'ZZ99', substitutes: [] },
      { batch: '26CA02', slot: 'QA3', faculty: 'RS01', substitutes: ['RS01'] },
      { batch: '26CA02', slot: 'qa1', faculty: 'RS01', substitutes: [] },
    ] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /NOPE99/);
    assert.match(res.body.error, /ZZ99/);
    assert.match(res.body.error, /both primary and substitute/);
    assert.match(res.body.error, /more than once/);
    assert.deepEqual((await batch('26CA02')).assignments, before.assignments);
  });

  test('timetable upload replaces hours for listed batches only, and keeps dates not given', async () => {
    const res = await call('POST', '/batches/timetable/import', { rows: [
      { batch: 'ecat26 : 101', days: ['Tue', 'Thu'], start: '19:00', end: '21:00', start_date: '2026-08-01' },
      { batch: 'eCAT26 : 101', days: ['Sun'], start: '10:00', end: '13:00' },
    ] });
    assert.equal(res.status, 200, res.body?.error);
    assert.deepEqual(res.body, { batches: 1, class_times: 3 });
    const live = await batch('eCAT26 : 101');
    assert.equal(live.timings.length, 3);
    assert.equal(live.start_date, '2026-08-01');
    assert.equal((await batch('26CA02')).timings.length, 2, 'a batch not listed is untouched');

    await call('POST', '/batches/timetable/import', { rows: [{ batch: 'eCAT26 : 101', days: ['Sun'], start: '10:00', end: '13:00' }] });
    const again = await batch('eCAT26 : 101');
    assert.equal(again.timings.length, 1);
    assert.equal(again.start_date, '2026-08-01');
  });

  test('a faulty timetable upload changes nothing', async () => {
    const res = await call('POST', '/batches/timetable/import', { rows: [
      { batch: '26CA02', days: ['Tue'], start: '09:00', end: '10:00' },
      { batch: 'eCAT26 : 101', days: ['Sun'], start: '10:00', end: '13:00' },
      { batch: 'eCAT26 : 101', days: ['Sun'], start: '12:00', end: '14:00' },
      { batch: 'NOPE99', days: ['Sun'], start: '10:00', end: '13:00' },
    ] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /overlap/);
    assert.match(res.body.error, /NOPE99/);
    assert.equal((await batch('26CA02')).timings.length, 2);
    assert.equal((await batch('eCAT26 : 101')).timings.length, 1);
  });

  test('deleting a faculty removes them as substitute and empties slots they held', async () => {
    const priya = await faculty('PD04');
    assert.equal((await call('DELETE', `/faculties/${priya.id}`)).status, 204);
    const [main, live] = [await batch('26CA02'), await batch('eCAT26 : 101')];
    assert.equal(main.assignments.find((a) => a.role === 'QA1').substitute_ids.includes(priya.id), false);
    assert.equal(main.assignments.find((a) => a.role === 'QA1').substitute_ids.length, 1);
    assert.equal(live.assignments.find((a) => a.role === 'Mentor').faculty_id, null);
  });
});
