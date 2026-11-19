import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFetch, signIn } from './sign-in.js';
import { generateServiceKey, startFakeGoogle, toGridRows } from './fake-google.js';
import { checkEntry, datesOf, readResponses } from '../src/inputs/parse.js';
import { INPUT_KINDS, kindFromText, parseMonth, shiftMonth } from '../public/admin/input-kinds.js';
import { generateWeek } from '../src/schedule/generate.js';

// All faculty codes, names and batches below are invented.
const HEADERS = ['Timestamp', 'Faculty Code', 'Month', 'What is it?', 'From date', 'To date', 'From time', 'To time', 'Batch codes', 'Other faculty involved', 'Details'];
const serial = (iso) => (Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(1899, 11, 30)) / 86400000;
const date = (iso) => ({ text: iso.split('-').reverse().join('/'), number: serial(iso) });
const time = (hhmm) => ({ text: hhmm, number: (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) / 1440 });
const stamp = (n) => ({ text: `10/10/2026 10:0${n}:00`, number: serial('2026-10-10') + (600 + n) / 1440 });
const grid = (rows, headers = HEADERS) => toGridRows(rows, headers).map((r) => (r.values ?? []).map((c) => ({ text: c.formattedValue ?? '', number: c.effectiveValue?.numberValue })));

describe('reading the form', () => {
  test('the form script offers exactly the choices the program reads', () => {
    const script = fs.readFileSync(new URL('../tools/scheduling-input-form.gs', import.meta.url), 'utf8');
    const block = /var KINDS = \[([\s\S]*?)\];/.exec(script)[1];
    const inScript = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(inScript, INPUT_KINDS.filter((k) => k.form).map((k) => k.form));
  });

  test('answers are read from date and time serials, so 5/11 is never misread', () => {
    const { entries } = readResponses(grid([
      { Timestamp: stamp(1), 'Faculty Code': 'AB - Test Faculty', Month: 'November 2026', 'What is it?': 'Not available for part of the day', 'From date': date('2026-11-05'), 'To date': date('2026-11-06'), 'From time': time('00:00'), 'To time': time('12:00') },
      { Timestamp: stamp(2), 'Faculty Code': 'CD', 'What is it?': 'Leave (whole day)', 'From date': '12/11/2026' },
    ]));
    assert.equal(entries[0].faculty_code, 'AB');
    assert.deepEqual([entries[0].month, entries[0].from_date, entries[0].to_date, entries[0].from_time, entries[0].to_time], ['2026-11', '2026-11-05', '2026-11-06', '00:00', '12:00']);
    assert.equal(entries[0].submitted_at, '2026-10-10T10:01');
    assert.equal(entries[1].from_date, '2026-11-12', 'typed dates are read day first');
    assert.equal(entries[1].month, '2026-11', 'no month answer: taken from the date');
    assert.match(entries[0].entry_key, /^form:/);
    assert.notEqual(entries[0].entry_key, entries[1].entry_key);
  });

  test('one response can hold several items; empty items are skipped', () => {
    const items = ['What is it?', 'From date', 'To date', 'From time', 'To time', 'Batch codes', 'Other faculty involved', 'Details'];
    const headers = ['Timestamp', 'Faculty Code', 'Month', ...[1, 2, 3].flatMap((n) => [...items.map((q) => `Item ${n}: ${q}`), ...(n < 3 ? [`Item ${n}: Add another item?`] : [])])];
    const { entries } = readResponses(grid([
      {
        Timestamp: stamp(1), 'Faculty Code': 'AB', Month: 'November 2026',
        'Item 1: What is it?': 'Leave (whole day)', 'Item 1: From date': date('2026-11-12'), 'Item 1: To date': date('2026-11-13'), 'Item 1: Add another item?': 'Yes',
        'Item 2: What is it?': 'Not available for part of the day', 'Item 2: From date': date('2026-11-14'), 'Item 2: From time': time('00:00'), 'Item 2: To time': time('12:00'), 'Item 2: Add another item?': 'No, send it',
      },
    ], headers));
    assert.deepEqual(entries.map((e) => [e.item, e.faculty_code, e.month, e.kind, e.from_date, e.to_date, e.to_time]), [
      [1, 'AB', '2026-11', 'leave', '2026-11-12', '2026-11-13', null],
      [2, 'AB', '2026-11', 'partial', '2026-11-14', null, '12:00'],
    ]);
    assert.notEqual(entries[0].entry_key, entries[1].entry_key);
  });

  test('changing an answer changes its key, so it is reviewed again', () => {
    const row = { Timestamp: stamp(1), 'Faculty Code': 'AB', Month: 'November 2026', 'What is it?': 'Leave (whole day)', 'From date': date('2026-11-05') };
    const a = readResponses(grid([row])).entries[0].entry_key;
    const b = readResponses(grid([{ ...row, 'From date': date('2026-11-06') }])).entries[0].entry_key;
    assert.notEqual(a, b);
  });

  test('months and kinds are read leniently, and nothing else', () => {
    assert.equal(parseMonth('Nov 2026'), '2026-11');
    assert.equal(parseMonth('2026-1'), '2026-01');
    assert.equal(parseMonth('11/2026'), '2026-11');
    assert.equal(parseMonth('Novembr'), null);
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.equal(kindFromText('  leave (WHOLE day) '), 'leave');
    assert.equal(kindFromText('Holiday'), null);
  });

  const lookups = {
    faculties: new Map([['ab', { id: 1, code: 'AB' }], ['cd', { id: 2, code: 'CD' }]]),
    batches: new Map([['27ca01', { id: 7, name: '27CA01' }]]),
    rooms: new Map(),
  };
  const entry = (over) => ({ source: 'form', faculty_code: 'AB', month: '2026-11', kind: 'leave', from_date: '2026-11-05', to_date: null, from_time: null, to_time: null, batch_codes: '', others: '', details: '', ...over });

  test('an answer that can’t be used says why', () => {
    assert.deepEqual(checkEntry(entry({}), lookups), { faculty_id: 1, problems: [] });
    const problems = (over) => checkEntry(entry(over), lookups).problems.join(' ');
    assert.match(problems({ faculty_code: 'ZZ' }), /No faculty has the code "ZZ"/);
    assert.match(problems({ to_date: '2026-11-01' }), /To date is before/);
    assert.match(problems({ kind: 'partial' }), /both a From time and a To time/);
    assert.match(problems({ from_time: '12:00', to_time: '09:00' }), /To time must be after/);
    assert.match(problems({ kind: 'batch_break' }), /Name the batch codes/);
    assert.match(problems({ kind: 'batch_break', batch_codes: '27CA01, 27CA99' }), /No batch has the code "27CA99"/);
    assert.match(problems({ kind: 'event', from_date: null, others: 'CD + XY' }), /"XY" \(other faculty\)/);
    assert.match(problems({ kind: 'unknown:Holiday' }), /"Holiday" is not one of the form’s choices/);
    assert.equal(problems({ kind: 'none', from_date: null }), '');
    assert.deepEqual(datesOf(entry({ to_date: '2026-11-07' })), ['2026-11-05', '2026-11-06', '2026-11-07']);
  });
});

describe('the generator with approved input', () => {
  const faculties = [{ id: 1, code: 'AB', week_offs: ['Mon'] }, { id: 2, code: 'CD', week_offs: [] }];
  const slots = [{ role: 'QA', subject: 'QA', faculty_id: 1, substitute_ids: [] }, { role: 'VA', subject: 'VA', faculty_id: 2, substitute_ids: [] }];
  const batch = { id: 1, name: '27CA01', start_date: null, end_date: null, slots, occupied: [], unavailable: new Set(),
    timings: [{ weekday: 'Mon', start_time: '18:00', end_time: '20:00' }, { weekday: 'Tue', start_time: '18:00', end_time: '20:00' }, { weekday: 'Wed', start_time: '18:00', end_time: '20:00' }],
    sessions: [{ id: 1, subject: 'QA' }, { id: 2, subject: 'QA' }, { id: 3, subject: 'VA' }, { id: 4, subject: 'VA' }] };
  const plan = (input) => {
    const closed = [];
    return { classes: generateWeek({ weekStart: '2026-11-16', batches: [batch], faculties, bookings: [], ...input, closed }), closed };
  };

  test('an extra day lets a faculty teach on their week-off', () => {
    assert.equal(plan({}).classes[0].faculty_id, 2, 'Monday off: switched to VA');
    assert.equal(plan({ extraDays: new Set(['1|2026-11-16']) }).classes[0].faculty_id, 1);
  });

  test('leave makes the class switch subject, and says why', () => {
    const { classes } = plan({ away: [{ faculty_id: 1, date: '2026-11-17', start_time: '00:00', end_time: '24:00', reason: 'on leave' }] });
    const tuesday = classes.find((c) => c.date === '2026-11-17');
    assert.equal(tuesday.faculty_id, 2);
    assert.match(tuesday.flags[0], /Switched from QA to VA\. Nobody free: AB is on leave/);
  });

  test('a part-day absence only matters when it overlaps the class', () => {
    const { classes } = plan({ away: [{ faculty_id: 1, date: '2026-11-17', start_time: '00:00', end_time: '12:00', reason: 'away' }] });
    assert.equal(classes.find((c) => c.date === '2026-11-17').session_id, 1);
  });

  test('closures leave classes out and list them', () => {
    const { classes, closed } = plan({ closures: [{ date: '2026-11-18', start_time: '00:00', end_time: '24:00', batch_ids: null, reason: 'Centre closed: Diwali' }] });
    assert.deepEqual(classes.map((c) => c.date), ['2026-11-16', '2026-11-17']);
    assert.deepEqual(closed.map((c) => [c.date, c.reason]), [['2026-11-18', 'Centre closed: Diwali']]);
    const other = plan({ closures: [{ date: '2026-11-18', start_time: '00:00', end_time: '24:00', batch_ids: [99], reason: 'Batch break' }] });
    assert.equal(other.classes.length, 3, 'a break for another batch changes nothing');
  });
});

/* ---------- through the server ---------- */

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

describe('faculty input API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-inputs-'));
  const PORT = 3986;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  const WEEK = '2026-11-16';
  let google;
  let server;
  let ids;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const month = async () => (await call('GET', '/inputs?month=2026-11')).body;
  const sync = async () => (await call('POST', '/inputs/sync')).body.run;
  const week = async () => (await call('GET', `/schedule?week=${WEEK}`)).body;

  // The form's layout: shared questions, then "Item n:" questions for up to 6 items.
  const ITEM_QUESTIONS = ['What is it?', 'From date', 'To date', 'From time', 'To time', 'Batch codes', 'Other faculty involved', 'Details'];
  const FORM_HEADERS = ['Timestamp', 'Faculty Code', 'Month', ...[1, 2, 3, 4, 5, 6].flatMap((n) => [...ITEM_QUESTIONS.map((q) => `Item ${n}: ${q}`), ...(n < 6 ? [`Item ${n}: Add another item?`] : [])])];
  const asItem = (n, answers) => Object.fromEntries(Object.entries(answers).map(([k, v]) => [['Timestamp', 'Faculty Code', 'Month'].includes(k) ? k : `Item ${n}: ${k}`, v]));
  const formRows = (r) => [
    asItem(1, r.leave), asItem(1, r.extra),
    { ...asItem(1, r.breakB2), 'Item 1: Add another item?': 'Yes', ...asItem(2, r.workshop), 'Item 2: Add another item?': 'No, send it' },
    asItem(1, r.unknown), asItem(1, r.december),
  ];
  const responses = {
    leave: { Timestamp: stamp(1), 'Faculty Code': 'TU - Test Quant', Month: 'November 2026', 'What is it?': 'Leave (whole day)', 'From date': date('2026-11-22') },
    extra: { Timestamp: stamp(2), 'Faculty Code': 'SV', Month: 'November 2026', 'What is it?': 'Available on my usual day off', 'From date': date('2026-11-16') },
    breakB2: { Timestamp: stamp(3), 'Faculty Code': 'PS', Month: 'November 2026', 'What is it?': 'Batch break: no classes for a batch', 'From date': date('2026-11-22'), 'From time': time('15:00'), 'To time': time('17:00'), 'Batch codes': '27CA02', Details: 'Module 1 test at college' },
    workshop: { Timestamp: stamp(4), 'Faculty Code': 'PS', Month: 'November 2026', 'What is it?': 'Workshop, meeting or other commitment', 'From date': date('2026-11-20'), 'From time': time('10:00'), 'To time': time('12:00'), 'Other faculty involved': 'TU', Details: 'Club 100 workshop' },
    unknown: { Timestamp: stamp(5), 'Faculty Code': 'ZZ', Month: 'November 2026', 'What is it?': 'Leave (whole day)', 'From date': date('2026-11-18') },
    december: { Timestamp: stamp(6), 'Faculty Code': 'SV', Month: 'December 2026', 'What is it?': 'Nothing to report this month' },
  };

  before(async () => {
    google = await startFakeGoogle();
    const key = generateServiceKey(`${google.base}/token`);
    google.state.publicKey = key.publicKey;
    fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(key.json));
    google.state.tabs = { 'Form Responses 1': toGridRows(formRows(responses), FORM_HEADERS) };

    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: {
        ...process.env, PORT, DB_PATH: path.join(dir, 'inputs.db'), GOOGLE_SHEET_ID: '', GOOGLE_SHEET_TAB: '',
        GOOGLE_SERVICE_ACCOUNT_KEY: path.join(dir, 'key.json'), GOOGLE_SHEETS_API_BASE: google.base,
        INPUT_SHEET_ID: 'https://docs.google.com/spreadsheets/d/fake-input-sheet/edit', INPUT_FORM_URL: 'https://forms.example/test',
        SHEET_SYNC_MINUTES: '1440',
      },
      stdio: 'ignore',
    });
    await waitForServer(`${BASE}/state`);
    await signIn(BASE);

    const course = (await call('POST', '/courses', { name: 'Input CAT', roles: [{ name: 'QA1', subject: 'QA' }, { name: 'VARC1', subject: 'VARC' }] })).body.id;
    await call('POST', '/faculties/import', { rows: [
      { code: 'TU', name: 'Test Quant', courses: ['Input CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'PS', name: 'Test Sub', courses: ['Input CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'SV', name: 'Test Verbal', courses: ['Input CAT'], subjects: ['VARC'], week_offs: ['Mon'] },
      { code: 'NB', name: 'No Batch', courses: ['Input CAT'], subjects: ['QA'], week_offs: [] },
    ] });
    const sessions = ['VARC', 'QA', 'VARC', 'QA', 'QA', 'VARC', 'QA', 'VARC'].map((subject, i) => ({ topic_code: `S${i + 1}`, topic: `Topic ${i + 1}`, subject }));
    await call('POST', '/flows', { course_id: course, name: 'CAT 2027', scope: 'course', sessions });
    for (const code of ['27CA01', '27CA02']) await call('POST', '/batches', { course_id: course, code });
    await call('POST', '/rooms', { name: 'Big Room', capacity: 60 });
    await call('POST', '/rooms', { name: 'Other Room', capacity: 60 });
    const s = (await call('GET', '/state')).body;
    const fac = (code) => s.faculties.find((f) => f.code === code).id;
    ids = { TU: fac('TU'), PS: fac('PS'), SV: fac('SV'), bigRoom: s.rooms.find((r) => r.name === 'Big Room').id };
    for (const b of s.batches) {
      await call('PUT', `/batches/${b.id}`, {
        name: b.name, year: b.year,
        assignments: b.assignments.map((a) => (a.role === 'QA1' ? { ...a, faculty_id: ids.TU, substitute_ids: [ids.PS] } : { ...a, faculty_id: ids.SV })),
        timings: [{ weekday: 'Mon', start_time: '18:00', end_time: '20:00' }, { weekday: 'Sun', start_time: '13:00', end_time: '15:00' }, { weekday: 'Sun', start_time: '15:00', end_time: '17:00' }],
      });
    }
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    await google.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('only signed-in admins can see or change faculty input', async () => {
    assert.equal((await realFetch(`${BASE}/inputs?month=2026-11`)).status, 401);
    assert.equal((await call('GET', '/inputs?month=soon')).status, 400);
  });

  test('reads the response sheet: each month shows its answers and who has replied', async () => {
    const run = await sync();
    assert.equal(run.ok, true, run.error);
    assert.equal(run.tab, 'Form Responses 1');
    assert.equal(run.row_count, 6);

    const data = await month();
    assert.equal(data.entries.length, 5, 'December’s answer is under December');
    assert.ok(data.entries.every((e) => e.status === 'pending'));
    const replied = Object.fromEntries(data.faculties.map((f) => [f.code, [f.replies, f.teaching]]));
    assert.deepEqual(replied, { NB: [0, false], PS: [2, true], SV: [1, true], TU: [1, true] });
    assert.equal(data.sync.form_url, 'https://forms.example/test');
    const zz = data.entries.find((e) => e.faculty_code === 'ZZ');
    assert.match(zz.problems[0], /No faculty has the code "ZZ"/);
    const dec = (await call('GET', '/inputs?month=2026-12')).body;
    assert.equal(dec.entries[0].kind, 'none');
  });

  test('an answer with problems can’t be approved; the rest can, in one go', async () => {
    const data = await month();
    const zz = data.entries.find((e) => e.faculty_code === 'ZZ');
    const refused = await call('POST', `/inputs/entries/${zz.id}/review`, { status: 'approved' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /can’t be approved yet/);

    const all = await call('POST', '/inputs/approve', { month: '2026-11' });
    assert.deepEqual(all.body, { approved: 4, left: 1 });
    await call('POST', `/inputs/entries/${zz.id}/review`, { status: 'rejected' });
    const after = await month();
    assert.equal(after.entries.find((e) => e.faculty_code === 'ZZ').status, 'rejected');
  });

  test('an approved workshop with times goes on the schedule with every faculty in it', async () => {
    const { events } = await week();
    const workshop = events.find((e) => e.title === 'Club 100 workshop');
    assert.ok(workshop);
    assert.deepEqual([workshop.date, workshop.start_time, workshop.end_time], ['2026-11-20', '10:00', '12:00']);
    assert.deepEqual(workshop.faculty_ids.sort(), [ids.TU, ids.PS].sort());
  });

  test('the generator follows approved leave, extra days and batch breaks', async () => {
    const res = await call('POST', '/schedule/generate', { week: WEEK });
    assert.equal(res.status, 200, res.body?.error);
    assert.equal(res.body.closed, 1, '27CA02 at 3 pm on Sunday is on a break');
    const { classes } = await week();
    assert.equal(classes.length, 5);
    assert.ok(!classes.some((c) => c.batch_name === '27CA02' && c.date === '2026-11-22' && c.start_time === '15:00'));

    const monday = classes.filter((c) => c.date === '2026-11-16');
    assert.ok(monday.some((c) => c.faculty_code === 'SV'), 'SV teaches on a Monday off: extra day approved');
    const sunday = classes.filter((c) => c.date === '2026-11-22');
    assert.ok(!sunday.some((c) => c.faculty_code === 'TU'), 'TU is on leave on Sunday');
    assert.ok(sunday.flatMap((c) => c.flags).some((f) => /TU is on leave/.test(f)));
  });

  test('a response edited in the form comes back for review, and its effect stops', async () => {
    google.state.tabs['Form Responses 1'] = toGridRows(formRows({ ...responses, workshop: { ...responses.workshop, 'To time': time('13:00') } }), FORM_HEADERS);
    assert.equal((await sync()).ok, true);
    const data = await month();
    const workshop = data.entries.find((e) => e.kind === 'event');
    assert.equal(workshop.status, 'pending');
    assert.ok(!(await week()).events.some((e) => e.title === 'Club 100 workshop'), 'its old block is gone');
    assert.equal(data.entries.find((e) => e.kind === 'leave' && e.faculty_code === 'TU').status, 'approved', 'untouched answers keep their review');
  });

  test('taking back an approval removes its effect', async () => {
    const data = await month();
    const workshop = data.entries.find((e) => e.kind === 'event');
    await call('POST', `/inputs/entries/${workshop.id}/review`, { status: 'approved' });
    assert.ok((await week()).events.some((e) => e.end_time === '13:00'));
    await call('POST', `/inputs/entries/${workshop.id}/review`, { status: 'pending' });
    assert.ok(!(await week()).events.some((e) => e.title === 'Club 100 workshop'));
  });

  test('the admin can add a room closure, which counts straight away', async () => {
    const bad = await call('POST', '/inputs/entries', { month: '2026-11', kind: 'room', from_date: '2026-11-22' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Choose the room/);
    const added = await call('POST', '/inputs/entries', { month: '2026-11', kind: 'room', from_date: '2026-11-22', room_id: ids.bigRoom, details: 'Termite treatment' });
    assert.equal(added.status, 201, added.body?.error);
    await call('POST', '/schedule/generate', { week: WEEK });
    const { classes } = await week();
    assert.ok(!classes.some((c) => c.date === '2026-11-22' && c.room_name === 'Big Room'));
    assert.ok(classes.some((c) => c.date === '2026-11-16' && c.room_name === 'Big Room'), 'other days still use it');

    const entry = (await month()).entries.find((e) => e.id === added.body.id);
    assert.equal(entry.status, 'approved');
    assert.equal((await call('DELETE', `/inputs/entries/${entry.id}`)).status, 204);
    const formEntry = (await month()).entries.find((e) => e.source === 'form');
    assert.equal((await call('DELETE', `/inputs/entries/${formEntry.id}`)).status, 400, 'form answers are rejected, not deleted');
  });

  test('a deadline can be set per month', async () => {
    assert.equal((await call('PUT', '/inputs/months/2026-11', { deadline: '2026-10-18T21:00' })).status, 200);
    assert.equal((await month()).deadline, '2026-10-18T21:00');
    assert.equal((await call('PUT', '/inputs/months/2026-11', { deadline: 'tomorrow' })).status, 400);
  });

  test('a sheet without the form’s headings is reported, and the last answers kept', async () => {
    google.state.tabs['Form Responses 1'] = [{ values: [{ formattedValue: 'Something else' }] }];
    const run = await sync();
    assert.equal(run.ok, false);
    assert.match(run.error, /No tab has "Faculty Code" and "What is it\?" headings/);
    assert.equal((await month()).entries.length, 5);
  });
});
