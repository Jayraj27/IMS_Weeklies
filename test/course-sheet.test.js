import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFetch, signIn } from './sign-in.js';
import { courseSubjects, dayChoiceOf, parseClock, parseDayChoice, readHeading } from '../public/admin/course-sheet.js';
import { buildCourseSheet, readCourseSheet, sheetRows, slotsFor } from '../src/batches/course-sheet.js';
import { buildXlsx } from '../src/xlsx.js';
import { readXlsx } from '../src/xlsx-read.js';
import { unzip } from '../src/unzip.js';

const flow = (...subjects) => ({ sessions: subjects.map((subject) => ({ subject })) });

describe('course faculty sheet: reading', () => {
  test('subjects come from the master flows, most sessions first; TEST QA is covered by QA', () => {
    const subjects = courseSubjects([flow('QA', 'QA', 'VA', 'TEST QA', 'DILR', 'QA'), flow('va', 'MISC', 'DILR', 'VA')]);
    assert.deepEqual(subjects.map((s) => [s.subject, s.sessions, s.covered_by]), [
      ['QA', 3, null], ['VA', 3, null], ['DILR', 2, null], ['MISC', 1, null], ['TEST QA', 1, 'QA'],
    ]);
    assert.deepEqual(courseSubjects([flow('VARC', 'VA')]).map((s) => s.covered_by), [null, null], 'VA does not cover VARC');
  });

  test('days: MWF, TTS, Sunday, or a typed list', () => {
    assert.deepEqual(parseDayChoice('MWF').days, ['Mon', 'Wed', 'Fri']);
    assert.deepEqual(parseDayChoice('tts').days, ['Tue', 'Thu', 'Sat']);
    assert.deepEqual(parseDayChoice(' Sunday ').days, ['Sun']);
    assert.deepEqual(parseDayChoice('Mon, Thu').days, ['Mon', 'Thu']);
    assert.ok(parseDayChoice('Weekends').error);
    assert.ok(parseDayChoice('').error);
    assert.equal(dayChoiceOf(['Fri', 'Mon', 'Wed']), 'MWF');
    assert.equal(dayChoiceOf(['Sun']), 'Sunday');
    assert.equal(dayChoiceOf(['Sat', 'Sun']), 'Sat, Sun');
  });

  test('times: 24-hour HH:MM, AM/PM, or an Excel time', () => {
    assert.equal(parseClock('18:30').time, '18:30');
    assert.equal(parseClock('06:30').time, '06:30', 'the sheet asks for 24-hour, so 06:30 is morning');
    assert.equal(parseClock('07:00:00').time, '07:00');
    assert.equal(parseClock('6:30 PM').time, '18:30');
    assert.equal(parseClock('0.75').time, '18:00');
    assert.ok(parseClock('25:00').error);
    assert.ok(parseClock('6:30').error, 'one-digit hour without AM/PM before 7 stays refused');
    assert.ok(parseClock('soon').error);
  });

  test('headings: QA1 primary, QA2 substitute, Mentor alone', () => {
    assert.deepEqual(readHeading('Batch'), { field: 'batch' });
    assert.deepEqual(readHeading('Start time (HH:MM)'), { field: 'start' });
    assert.deepEqual(readHeading('QA1'), { subject: 'QA', rank: 1 });
    assert.deepEqual(readHeading('TEST QA 2'), { subject: 'TEST QA', rank: 2 });
    assert.deepEqual(readHeading('Mentor'), { subject: 'Mentor', rank: 1 });
  });

  test('a sheet subject stands for its slot, or old numbered slots of that subject', () => {
    const slots = [
      { role: 'Mentor', subject: null }, { role: 'QA1', subject: 'QA' }, { role: 'QA2', subject: 'QA' },
      { role: 'VARC1', subject: 'VARC' }, { role: 'QA', subject: 'QA' }, { role: 'DILR', subject: null },
    ];
    assert.deepEqual(slotsFor('QA', slots).map((s) => s.role), ['QA1', 'QA2', 'QA']);
    assert.deepEqual(slotsFor('VA', slots).map((s) => s.role), [], 'VA is not VARC');
    assert.deepEqual(slotsFor('Mentor', slots).map((s) => s.role), ['Mentor']);
    assert.deepEqual(slotsFor('DILR', slots).map((s) => s.role), ['DILR']);
  });

  test('rows: extra rows add class times; faculty may repeat but not disagree', () => {
    const rows = [
      ['Batch', 'Days', 'Start time (HH:MM)', 'End time (HH:MM)', 'Mentor', 'QA1', 'QA2'],
      ['T01', 'MWF', '18:00', '20:00', 'AB', 'CD', 'EF'],
      ['T01', 'Sunday', '09:00', '12:00', '', '', ''],
      ['T02', '', '', '', '', 'CD', ''],
      ['T02', '', '', '', '', 'GH', ''],
      ['T03', 'Fun days', '9', '25:00', '', '', ''],
      ['', '', '', '', '', '', ''],
      ['', 'MWF', '', '', '', '', ''],
    ];
    const { batches, subjects, problems } = readCourseSheet(rows);
    assert.deepEqual(subjects, [{ subject: 'Mentor', ranks: [1] }, { subject: 'QA', ranks: [1, 2] }]);
    const t01 = batches.find((b) => b.code === 'T01');
    assert.equal(t01.timings.length, 4);
    assert.equal(t01.faculty.get('qa|2'), 'EF');
    assert.ok(problems.some((p) => /T02: QA1 is CD on one row and GH on another/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /Row 6 \(T03\): "Fun days"/.test(p)));
    assert.ok(problems.some((p) => /Row 6 \(T03\): .*24-hour HH:MM/.test(p)));
    assert.ok(problems.some((p) => /Row 8: the batch code is missing/.test(p)));
  });
});

describe('course faculty sheet: the template file', () => {
  const file = buildCourseSheet({
    course: { name: 'Test CAT' },
    subjects: ['QA', 'VA'],
    batches: [
      {
        name: 'T01',
        timings: [{ weekday: 'Mon', start_time: '18:00', end_time: '20:00' }, { weekday: 'Wed', start_time: '18:00', end_time: '20:00' }, { weekday: 'Fri', start_time: '18:00', end_time: '20:00' }, { weekday: 'Sun', start_time: '09:00', end_time: '12:00' }],
        slots: [
          { role: 'Mentor', subject: null, faculty_code: 'AB', substitute_codes: [] },
          { role: 'QA1', subject: 'QA', faculty_code: 'CD', substitute_codes: [] },
          { role: 'QA2', subject: 'QA', faculty_code: 'EF', substitute_codes: [] },
        ],
      },
      { name: 'T02', timings: [], slots: [] },
    ],
    faculties: [{ code: 'AB', name: 'Test One', subjects: ['QA'], week_offs: ['Sun'] }, { code: 'CD', name: 'Test Two', subjects: [], week_offs: [] }],
  });

  test('columns: Batch, Days, times, Mentor, then a pair per subject; filled with what is saved', () => {
    const sheets = readXlsx(file);
    assert.deepEqual(sheets.map((s) => s.name), ['Test CAT faculty', 'Faculty codes', 'How to fill']);
    const [head, first, second, third] = sheets[0].rows;
    assert.deepEqual(head, ['Batch', 'Days', 'Start time (HH:MM)', 'End time (HH:MM)', 'Mentor', 'QA1', 'QA2', 'VA1', 'VA2']);
    assert.deepEqual(first, ['T01', 'MWF', '18:00', '20:00', 'AB', 'CD', 'EF', '', '']);
    assert.deepEqual(second.slice(0, 5), ['T01', 'Sunday', '09:00', '12:00', '']);
    assert.equal(third[0], 'T02');
    assert.deepEqual(sheets[1].rows[1], ['AB', 'Test One', 'QA', 'Sun']);
  });

  test('Days and faculty columns have dropdowns; time cells are text so 18:00 stays 18:00', () => {
    const xml = unzip(file)['xl/worksheets/sheet1.xml'];
    assert.match(xml, /<formula1>&quot;MWF,TTS,Sunday&quot;<\/formula1>/);
    assert.match(xml, /sqref="E2:I\d+"><formula1>'Faculty codes'!\$A\$2:\$A\$3<\/formula1>/);
    assert.match(unzip(file)['xl/styles.xml'], /numFmtId="49"/);
  });

  test('the filled template reads back the same', () => {
    const { batches, problems } = readCourseSheet(sheetRows(file, 'x.xlsx'));
    assert.deepEqual(problems, []);
    assert.deepEqual(batches.map((b) => [b.code, b.timings.length]), [['T01', 4], ['T02', 0]]);
  });

  test('a CSV of the same sheet works too, and a broken file is refused', () => {
    const csv = Buffer.from('Batch,Days,Start time,End time,Mentor,QA1,QA2\nT01,TTS,07:00,09:00,AB,CD,\n');
    const { batches, problems } = readCourseSheet(sheetRows(csv, 'sheet.csv'));
    assert.deepEqual(problems, []);
    assert.deepEqual(batches[0].timings.map((t) => t.weekday), ['Tue', 'Thu', 'Sat']);
    assert.throws(() => sheetRows(Buffer.from('PK nonsense'), 'x.xlsx'), /not a readable/);
    assert.throws(() => sheetRows(buildXlsx([{ name: 'Other', rows: [['Hello']] }]), 'x.xlsx'), /Batch heading/);
  });
});

describe('course faculty sheet: through the server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-course-sheet-'));
  const PORT = 3984;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  let server;
  let ids;

  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const state = async () => (await call('GET', '/state')).body;
  const upload = (rows, apply = false) => call('POST', `/courses/${ids.course}/faculty-sheet`, {
    name: 'filled.xlsx', apply, file: buildXlsx([{ name: 'Sheet', rows }]).toString('base64'),
  });
  const HEAD = ['Batch', 'Days', 'Start time (HH:MM)', 'End time (HH:MM)', 'Mentor', 'QA1', 'QA2', 'VA1', 'VA2'];

  before(async () => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: { ...process.env, PORT, DB_PATH: path.join(dir, 'sheet.db'), GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '' },
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
    const course = (await call('POST', '/courses', { name: 'Sheet CAT', roles: [{ name: 'Mentor', subject: '' }, { name: 'QA1', subject: 'QA' }, { name: 'QA2', subject: 'QA' }, { name: 'VARC1', subject: 'VARC' }] })).body.id;
    const other = (await call('POST', '/courses', { name: 'Sheet CLAT', roles: [] })).body.id;
    await call('POST', '/faculties/import', { rows: [
      { code: 'MN', name: 'Test Mentor', courses: ['Sheet CAT'], subjects: [], week_offs: [] },
      { code: 'QP', name: 'Test Quant', courses: ['Sheet CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'QS', name: 'Test Quant Sub', courses: ['Sheet CAT'], subjects: ['QA'], week_offs: [] },
      { code: 'VP', name: 'Test Verbal', courses: ['Sheet CLAT'], subjects: ['VA'], week_offs: [] },
    ] });
    for (const code of ['27SC01', '27SC02']) await call('POST', '/batches', { course_id: course, code });
    await call('POST', '/batches', { course_id: other, code: '27SL01' });
    ids = { course, other };
  });

  after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the template needs a master flow first, then takes its subjects as columns', async () => {
    assert.equal((await realFetch(`${BASE}/courses/${ids.course}/faculty-sheet`)).status, 401);
    const early = await call('GET', `/courses/${ids.course}/faculty-sheet`);
    assert.equal(early.status, 400);
    assert.match(early.body.error, /Upload a master flow for Sheet CAT first/);

    await call('POST', '/flows', { course_id: ids.course, name: 'CAT 27', scope: 'course', sessions: [
      { topic: 'Percentages', subject: 'QA' }, { topic: 'Reading', subject: 'VA' }, { topic: 'Ratios', subject: 'QA' }, { topic: 'Test 1', subject: 'TEST QA' },
    ] });
    const res = await fetch(`${BASE}/courses/${ids.course}/faculty-sheet`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /Sheet-CAT-faculty-sheet\.xlsx/);
    const [sheet] = readXlsx(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(sheet.rows[0], HEAD, 'TEST QA is left out: QA covers it');
    assert.deepEqual(sheet.rows.slice(1, 3).map((r) => r[0]), ['27SC01', '27SC02'], 'only this course’s batches');

    const chosen = readXlsx(Buffer.from(await (await fetch(`${BASE}/courses/${ids.course}/faculty-sheet?subjects=VA`)).arrayBuffer()))[0];
    assert.deepEqual(chosen.rows[0], ['Batch', 'Days', 'Start time (HH:MM)', 'End time (HH:MM)', 'Mentor', 'VA1', 'VA2']);
  });

  test('problems are all listed, and nothing is saved', async () => {
    const res = await upload([
      HEAD,
      ['27SC01', 'MWF', '18:00', '17:00', 'MN', 'QP', 'QP', '', ''],
      ['27SL01', 'MWF', '18:00', '20:00', '', '', '', '', ''],
      ['27XX99', 'MWF', '18:00', '20:00', '', '', '', '', ''],
      ['27SC02', 'TTS', '07:00', '09:00', 'ZZ', '', '', '', ''],
    ]);
    assert.equal(res.status, 200);
    const text = res.body.errors.join('\n');
    assert.match(text, /27SC01: On Mon, the class must end after it starts/);
    assert.match(text, /27SC01 QA: QP can’t be both primary and substitute/);
    assert.match(text, /27SL01 belongs to Sheet CLAT, not Sheet CAT/);
    assert.match(text, /There is no batch "27XX99"/);
    assert.match(text, /27SC02 Mentor: there is no faculty with code "ZZ"/);
    const refused = await upload([HEAD, ['27SC02', 'TTS', '07:00', '09:00', 'ZZ', '', '', '', '']], true);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Nothing was changed/);
    const b = (await state()).batches.find((x) => x.name === '27SC02');
    assert.equal(b.timings.length, 0);
  });

  test('preview lists each change; applying saves hours and one slot per subject with its substitute', async () => {
    const rows = [
      HEAD,
      ['27SC01', 'MWF', '18:00', '20:00', 'MN', 'QP', 'QS', 'VP', ''],
      ['27SC01', 'Sunday', '09:00', '12:00', '', '', '', '', ''],
    ];
    const preview = await upload(rows);
    assert.deepEqual(preview.body.errors, []);
    assert.equal(preview.body.applied, false);
    const changes = preview.body.batches.find((b) => b.name === '27SC01').changes.join('\n');
    assert.match(changes, /Class times: MWF 18:00–20:00; Sunday 09:00–12:00 \(was no class times\)/);
    assert.match(changes, /QA: QP, substitute QS \(was QA1 nobody; QA2 nobody\)/);
    assert.match(changes, /VA: VP \(was no slot\)/);
    const notes = preview.body.notes.join('\n');
    assert.match(notes, /VP \(27SC01 VA\) isn’t listed for Sheet CAT/);
    assert.match(notes, /27SC01 keeps its VARC1 slot \(VARC\), but no subject in Sheet CAT’s master flow is called VARC/);
    assert.equal((await state()).batches.find((x) => x.name === '27SC01').timings.length, 0, 'a preview saves nothing');

    const done = await upload(rows, true);
    assert.equal(done.status, 200);
    assert.equal(done.body.applied, true);
    const s = await state();
    const b = s.batches.find((x) => x.name === '27SC01');
    assert.equal(b.timings.length, 4);
    const code = (id) => s.faculties.find((f) => f.id === id)?.code;
    const slots = Object.fromEntries(b.assignments.map((a) => [a.role, [code(a.faculty_id) ?? null, (a.substitute_ids ?? []).map(code)]]));
    assert.deepEqual(slots, { Mentor: ['MN', []], QA: ['QP', ['QS']], VARC1: [null, []], VA: ['VP', []] });

    const again = await upload(rows);
    assert.deepEqual(again.body.batches.find((x) => x.name === '27SC01').changes, [], 'uploading the same sheet again changes nothing');
  });

  test('empty days leave hours alone; an empty faculty cell clears the slot', async () => {
    const res = await upload([HEAD, ['27SC01', '', '', '', 'MN', 'QS', '', 'VP', '']], true);
    assert.equal(res.status, 200);
    const s = await state();
    const b = s.batches.find((x) => x.name === '27SC01');
    assert.equal(b.timings.length, 4);
    const qa = b.assignments.find((a) => a.role === 'QA');
    assert.equal(s.faculties.find((f) => f.id === qa.faculty_id).code, 'QS');
    assert.deepEqual(qa.substitute_ids, []);
  });
});
