import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFetch, signIn } from './sign-in.js';
import { forecastBatch } from '../src/reports/routes.js';
import { readXlsx } from '../src/xlsx-read.js';

const sundays = [{ weekday: 'Sun', start_time: '13:00', end_time: '15:00' }, { weekday: 'Sun', start_time: '15:00', end_time: '17:00' }];

describe('finish forecast', () => {
  // Tue 17 Nov 2026; Sundays after it: 22 Nov, 29 Nov, 6 Dec, 13 Dec...
  const base = { today: '2026-11-17', timings: sundays, startDate: '2026-11-01', total: 10 };

  test('the last unfinished session lands on the class that teaches it', () => {
    const f = forecastBatch({ ...base, done: 5, endDate: null });
    assert.deepEqual(f, { remaining: 5, per_week: 2, finish_date: '2026-12-06', status: 'no_end' });
  });

  test('late: sessions that won’t fit before the end date, in weeks', () => {
    const f = forecastBatch({ ...base, done: 5, endDate: '2026-11-29' });
    assert.equal(f.status, 'late');
    assert.equal(f.short_by, 1);
    assert.equal(f.late_weeks, 1);
  });

  test('on track: classes to spare before the end date', () => {
    const f = forecastBatch({ ...base, done: 5, endDate: '2026-12-20' });
    assert.equal(f.status, 'on_track');
    assert.equal(f.spare, 5, '10 classes up to 20 Dec, 5 needed');
  });

  test('finished, no class times, a start date still ahead, and an ended batch', () => {
    assert.equal(forecastBatch({ ...base, done: 10, endDate: null }).status, 'finished');
    assert.equal(forecastBatch({ ...base, timings: [], done: 0, endDate: null }).status, 'no_times');
    assert.equal(forecastBatch({ ...base, startDate: '2027-01-01', done: 9, endDate: null }).finish_date, '2027-01-03');
    assert.equal(forecastBatch({ ...base, done: 9, endDate: '2026-11-01' }).status, 'ended');
  });
});

describe('reports API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-reports-'));
  const PORT = 3985;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  let server;
  let ids;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const state = async () => (await call('GET', '/state')).body;
  const WEEK = 'from=2026-11-16&to=2026-11-22';

  before(async () => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: { ...process.env, PORT, DB_PATH: path.join(dir, 'reports.db'), GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '' },
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
    const course = (await call('POST', '/courses', { name: 'Report CAT', roles: [{ name: 'QA', subject: 'QA' }, { name: 'VA', subject: 'VA' }] })).body.id;
    const other = (await call('POST', '/courses', { name: 'Report CLAT', roles: [] })).body.id;
    await call('POST', '/faculties/import', { rows: [
      { code: 'TQ', name: 'Test Quant', courses: ['Report CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'TV', name: 'Test Verbal', courses: ['Report CAT'], subjects: ['VA'], week_offs: [] },
      { code: 'TI', name: 'Test Idle', courses: [], subjects: [], week_offs: [] },
    ] });
    const subjects = ['QA', 'VA', 'QA', 'VA', 'QA', 'VA'];
    await call('POST', '/flows', { course_id: course, name: 'CAT 27', scope: 'course', sessions: subjects.map((subject, i) => ({ topic_code: `${subject} ${i}`, topic: `Topic ${i}`, subject })) });
    for (const code of ['27RC01', '27RC02']) await call('POST', '/batches', { course_id: course, code });
    await call('POST', '/batches', { course_id: other, code: '27RL01' });

    const s = await state();
    const fac = (code) => s.faculties.find((f) => f.code === code).id;
    const b1 = s.batches.find((b) => b.name === '27RC01');
    await call('PUT', `/batches/${b1.id}`, {
      name: b1.name, year: b1.year, start_date: '2026-11-01', end_date: '2026-11-29',
      assignments: b1.assignments.map((a) => ({ ...a, faculty_id: fac(a.role === 'QA' ? 'TQ' : 'TV') })),
      timings: sundays,
    });
    ids = { b1: b1.id, TQ: fac('TQ'), TV: fac('TV') };
    await call('POST', '/schedule/generate', { week: '2026-11-16' });
    const classes = (await call('GET', '/schedule?week=2026-11-16')).body.classes;
    ids.first = classes.find((c) => c.start_time === '13:00');
    ids.second = classes.find((c) => c.start_time === '15:00');
    await call('PUT', `/schedule/classes/${ids.first.id}`, { status: 'done' });
    await call('POST', '/schedule/events', { title: 'Planning', date: '2026-11-18', start_time: '10:00', end_time: '11:30', faculty_ids: [ids.TQ], online: true });
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports need signing in and a real period', async () => {
    assert.equal((await realFetch(`${BASE}/reports/workload?${WEEK}`)).status, 401);
    assert.equal((await realFetch(`${BASE}/reports/forecast`)).status, 401);
    assert.equal((await call('GET', '/reports/workload?from=2026-11-22&to=2026-11-16')).status, 400);
    assert.equal((await call('GET', '/reports/workload?from=soon&to=later')).status, 400);
    assert.equal((await call('GET', '/reports/workload?from=2026-01-01&to=2028-01-01')).status, 400);
  });

  test('workload: hours per faculty, done and planned, meetings, by course and batch', async () => {
    const { body } = await call('GET', `/reports/workload?${WEEK}`);
    const by = Object.fromEntries(body.faculties.map((f) => [f.code, f]));
    assert.deepEqual(
      [by.TQ.classes, by.TQ.hours, by.TQ.done_hours, by.TQ.planned_hours, by.TQ.block_hours, by.TQ.days],
      [1, 2, 2, 0, 1.5, 1],
    );
    assert.deepEqual([by.TV.hours, by.TV.planned_hours], [2, 2]);
    assert.deepEqual(by.TQ.courses, [{ name: 'Report CAT', hours: 2 }]);
    assert.deepEqual(by.TQ.batches, [{ name: '27RC01', hours: 2 }]);
    assert.equal(by.TI.hours, 0);
    assert.equal(body.total_hours, 4);
    assert.deepEqual(body.unassigned, { classes: 0, hours: 0 });
    assert.equal((await call('GET', '/reports/workload?from=2026-11-23&to=2026-11-29')).body.total_hours, 0);
  });

  test('a class without faculty is counted apart; a cancelled class not at all', async () => {
    await call('PUT', `/schedule/classes/${ids.second.id}`, { faculty_id: null });
    let { body } = await call('GET', `/reports/workload?${WEEK}`);
    assert.deepEqual(body.unassigned, { classes: 1, hours: 2 });
    assert.equal(body.faculties.find((f) => f.code === 'TV').hours, 0);

    await call('PUT', `/schedule/classes/${ids.second.id}`, { status: 'cancelled' });
    ({ body } = await call('GET', `/reports/workload?${WEEK}`));
    assert.deepEqual(body.unassigned, { classes: 0, hours: 0 });
    await call('PUT', `/schedule/classes/${ids.second.id}`, { status: 'planned', faculty_id: ids.TV });
  });

  test('workload downloads as a spreadsheet with a summary and every class', async () => {
    const res = await fetch(`${BASE}/reports/workload.xlsx?${WEEK}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /faculty-workload-2026-11-16-to-2026-11-22\.xlsx/);
    const [summary, detail] = readXlsx(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual([summary.name, detail.name], ['Workload', 'Every class']);
    const tq = summary.rows.find((r) => r[0] === 'TQ');
    assert.deepEqual(tq.slice(0, 8), ['TQ', 'Test Quant', '1', '1', '2', '2', '0', '1.5']);
    assert.equal(detail.rows.length, 4, 'heading, two classes, one meeting');
    assert.deepEqual(detail.rows.map((r) => r[7]).slice(1), ['Meeting', 'Class', 'Class']);
  });

  test('forecast: progress, recent pace, and lateness against the end date', async () => {
    const { body } = await call('GET', '/reports/forecast?today=2026-11-24');
    const b1 = body.batches.find((b) => b.name === '27RC01');
    // 1 of 6 finished; 2 classes a week on Sundays: 29 Nov (2), 6 Dec (2), 13 Dec (1).
    assert.deepEqual([b1.done, b1.total, b1.remaining, b1.per_week], [1, 6, 5, 2]);
    assert.equal(b1.finish_date, '2026-12-13');
    assert.equal(b1.status, 'late');
    assert.equal(b1.short_by, 3);
    assert.equal(b1.late_weeks, 2);
    assert.equal(b1.next.no, 2);
    assert.deepEqual(b1.subjects.map((s) => `${s.subject} ${s.done}/${s.total}`), ['QA 1/3', 'VA 0/3']);
    assert.deepEqual([b1.done_last_4_weeks, b1.timetabled_last_4_weeks], [1, 8], 'one class marked done; the timetable had 4 Sundays of 2 since 1 Nov');

    const b2 = body.batches.find((b) => b.name === '27RC02');
    assert.equal(b2.status, 'no_times');
    assert.deepEqual(body.missing_flow, ['27RL01']);
    assert.equal(body.batches[0].name, '27RC01', 'late batches come first');
  });
});
