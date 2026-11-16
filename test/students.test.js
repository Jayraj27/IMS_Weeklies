import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDate, parsePhone, parseSheet, SheetFormatError } from '../src/students/parse.js';
import { sheetIdFrom } from '../src/students/google.js';
import { signIn } from './sign-in.js';
import { normalizeCode, variantKey, yearFromCode } from '../src/students/variants.js';
import { startFakeGoogle, generateServiceKey, student, toGridRows, HEADERS } from './fake-google.js';

/* ---------- reading values ---------- */

describe('dates', () => {
  const dob = (text) => parseDate({ text }, 'dob');
  const doj = (text) => parseDate({ text }, 'doj');

  test('each format seen in the sheet', () => {
    assert.equal(dob('15-10-2005').iso, '2005-10-15');
    assert.equal(dob('7/26/2006').iso, '2006-07-26');
    assert.equal(dob('25/05/2006').iso, '2006-05-25');
    assert.equal(doj('21/7/2024').iso, '2024-07-21');
    assert.equal(doj('15/02/2025').iso, '2025-02-15');
  });

  test('a DOB that fits both orders follows its heading and is flagged', () => {
    assert.deepEqual(dob('8/4/2006'), { iso: '2006-08-04', ambiguous: true });
    assert.deepEqual(dob('5/5/2006'), { iso: '2006-05-05', ambiguous: false });
  });

  test('a DOJ that fits both orders is day first, whatever the stored value says', () => {
    // 1/7/2024 means 1 July here, even if a US-locale sheet stored it as 7 January.
    assert.deepEqual(parseDate({ text: '1/7/2024', number: 45298 }, 'doj'), { iso: '2024-07-01', ambiguous: false });
  });

  test('impossible, empty and unusual values', () => {
    assert.equal(dob('31/02/2006').iso, null);
    assert.equal(dob('soon').iso, null);
    assert.equal(dob('').iso, null);
    assert.equal(parseDate({ text: 'Oct 15, 2005', number: 38640 }, 'dob').iso, '2005-10-15');
  });
});

describe('phones', () => {
  test('spaces and signs are removed', () => {
    assert.equal(parsePhone({ text: '84908 07244' }).value, '8490807244');
    assert.equal(parsePhone({ text: '+91 98765-43210' }).value, '919876543210');
  });

  test('a number displayed as 9.72E+11 is recovered from the stored value', () => {
    assert.deepEqual(parsePhone({ text: '9.72E+11', number: 971501234567 }), { value: '971501234567', lostDigits: false });
  });

  test('if 9.72E+11 was stored as text, the loss is reported', () => {
    assert.equal(parsePhone({ text: '9.72E+11' }).lostDigits, true);
  });
});

describe('variants and codes', () => {
  test('variant names ignore spacing and capitals', () => {
    assert.equal(variantKey('  CATapult   Classroom 2026 '), variantKey('catapult classroom 2026'));
    assert.notEqual(variantKey('CATapult Classroom 2026'), variantKey('CATapult Classroom Pro 2026'));
  });

  test('year from the batch code', () => {
    assert.equal(yearFromCode('26CA02'), 2026);
    assert.equal(yearFromCode('eCAT26 : 101'), 2026);
    assert.equal(yearFromCode('27 E: IPMAT101'), 2027);
    assert.equal(yearFromCode('27UGGCS01'), 2027);
    assert.equal(yearFromCode('GC01'), null);
    assert.equal(yearFromCode('IPMAT101'), null);
  });

  test('codes that differ only in spacing or capitals are the same', () => {
    assert.equal(normalizeCode('27 E: IPMAT101'), normalizeCode('27 e:ipmat101'));
    assert.notEqual(normalizeCode('26CA02'), normalizeCode('26CA03'));
  });
});

test('sheet link or bare ID both work', () => {
  assert.equal(sheetIdFrom('https://docs.google.com/spreadsheets/d/abc_D-1/edit?usp=sharing'), 'abc_D-1');
  assert.equal(sheetIdFrom(' abc_D-1 '), 'abc_D-1');
});

/* ---------- reading a sheet ---------- */

const gridOf = (rows, headers) =>
  toGridRows(rows, headers).map((r) => r.values.map((c) => ({ text: c.formattedValue ?? '', number: c.effectiveValue?.numberValue })));

describe('parseSheet', () => {
  test('finds columns by heading, so reordering them is harmless', () => {
    const reordered = [...HEADERS].reverse();
    const { rows } = parseSheet(gridOf([student()], reordered));
    assert.equal(rows[0].ims_id, 'IMS0000000001');
    assert.equal(rows[0].batch, '26CA02');
    assert.equal(rows[0].mobile, '9000000001');
  });

  test('a heading row below a title row is found and row numbers match the sheet', () => {
    const grid = [[{ text: 'Student master' }], ...gridOf([student()])];
    const { rows, headerRow } = parseSheet(grid);
    assert.equal(headerRow, 2);
    assert.equal(rows[0].sheet_row, 3);
  });

  test('a missing required column stops the read', () => {
    const headers = HEADERS.filter((h) => h !== 'Batch');
    assert.throws(() => parseSheet(gridOf([student()], headers)), (e) => e instanceof SheetFormatError && /Batch/.test(e.message));
  });

  test('a new column is kept and noted', () => {
    const { rows, warnings } = parseSheet(gridOf([student({ Scholarship: '50%' })], [...HEADERS, 'Scholarship']));
    assert.equal(rows[0].raw.Scholarship, '50%');
    assert.ok(warnings.some((w) => w.includes('Scholarship')));
  });

  test('rows with only a serial number are skipped; rows with no ID are kept and flagged', () => {
    const { rows } = parseSheet(gridOf([{ 'Sr. No': '9' }, student({ 'IMS ID': '' })]));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].issues.includes('IMS ID is missing'));
  });

  test('all three ID prefixes are accepted, others are flagged', () => {
    const ids = ['IMS0001', 'STU0002', 'RSTU0003', 'XX9'];
    const { rows } = parseSheet(gridOf(ids.map((id) => student({ 'IMS ID': id }))));
    assert.deepEqual(rows.map((r) => r.issues.includes('IMS ID is in an unexpected format')), [false, false, false, true]);
  });

  test('a repeated IMS ID keeps both rows and flags both', () => {
    const { rows } = parseSheet(gridOf([
      student({ Status: 'Course Transfer', Batch: '26CA03' }),
      student({ Batch: '27CA01' }),
    ]));
    assert.equal(rows.length, 2);
    assert.ok(rows[0].issues.includes('IMS ID also appears on sheet row 3'));
    assert.ok(rows[1].issues.includes('IMS ID also appears on sheet row 2'));
  });

  test('suspicious data is flagged, and the value is left as written', () => {
    const { rows } = parseSheet(gridOf([
      student({ 'Parents / Guardian Name': '9000000009', 'Parents/Guardian Numbers': 'parent@example.com' }),
      student({ 'IMS ID': 'IMS2', 'DOB (MM/DD/YYYY)': '5/23/2025', DOJ: '19/04/2025' }),
      student({ 'IMS ID': 'IMS3', 'DOB (MM/DD/YYYY)': '' }),
      student({ 'IMS ID': 'IMS4', 'MOBILE NUMBER': '506420185' }),
      student({ 'IMS ID': 'IMS5', 'Live batch Added?': 'Yes' }),
    ]));
    assert.ok(rows[0].issues.includes('Guardian name and number look wrong or swapped'));
    assert.equal(rows[0].guardian_mobile, 'parent@example.com');
    assert.ok(rows[1].issues.includes('Date of birth looks too recent'));
    assert.ok(rows[2].issues.includes('Date of birth is missing'));
    assert.ok(rows[3].issues.includes('Mobile number is not a 10-digit Indian mobile'));
    assert.equal(rows[4].live_batch_added, 'YES');
    assert.deepEqual(rows[4].issues, []);
  });
});

/* ---------- the full sync, through a running server ---------- */

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

describe('sync', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-sync-'));
  const PORT = 3978;
  const BASE = `http://127.0.0.1:${PORT}/api`;
  let google;
  let server;

  const startServer = async (extraEnv = {}) => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      env: {
        ...process.env,
        PORT,
        DB_PATH: path.join(dir, 'sync.db'),
        GOOGLE_SHEET_ID: 'https://docs.google.com/spreadsheets/d/fake-sheet-id/edit',
        GOOGLE_SERVICE_ACCOUNT_KEY: path.join(dir, 'key.json'),
        GOOGLE_SHEETS_API_BASE: google.base,
        GOOGLE_SHEET_TAB: '',
        SHEET_SYNC_MINUTES: '1440',
        ...extraEnv,
      },
      stdio: 'ignore',
    });
    await waitForServer(`${BASE}/students/sync`);
  };
  const stopServer = async () => {
    if (server.exitCode !== null) return; // already stopped, so no exit event is coming
    server.kill();
    await new Promise((r) => server.once('exit', r));
  };
  const sync = async (body = {}) => {
    const res = await fetch(`${BASE}/students/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()).run;
  };
  const list = async (query = '') => (await fetch(`${BASE}/students?${query}`)).json();

  before(async () => {
    google = await startFakeGoogle();
    const key = generateServiceKey(`${google.base}/token`);
    google.state.publicKey = key.publicKey;
    fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(key.json));
    google.state.tabs.Students = toGridRows([
      student(),
      student({ 'Sr. No': '2', 'IMS ID': 'STU0000000002', Name: 'Asha', Surname: 'Rao', Batch: '27LAW01', Course: 'LAW', 'MOBILE NUMBER': { text: '9.72E+11', number: 971501234567 } }),
      student({ 'Sr. No': '3', 'IMS ID': 'RSTU0000000003', Name: '100%_real', Status: 'Drop Out', 'MOBILE NUMBER': '9000000003' }),
    ]);
    await startServer();
    await signIn(BASE);
  });

  after(async () => {
    await stopServer();
    await google.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('signs in with a valid read-only token, finds the right tab and stores students', async () => {
    const run = await sync();
    assert.equal(run.ok, true, run.error);
    assert.equal(run.tab, 'Students');
    assert.equal(run.row_count, 3);
    assert.equal(google.state.badSignatures, 0);
    assert.ok(google.state.gridRequests.every((t) => t === 'Students'));
  });

  test('the only requests to Google are reads', async () => {
    // The fake answers 405 to anything but GET; a write attempt would have failed the sync.
    assert.equal((await list()).total, 3);
  });

  test('values arrive correctly, including a phone displayed as 9.72E+11', async () => {
    const { rows } = await list('q=asha');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mobile, '971501234567');
    assert.equal(rows[0].dob, '2005-10-15');
    assert.equal(rows[0].doj, '2024-07-21');
    assert.equal(rows[0].raw['IMS ID'], 'STU0000000002');
  });

  test('filters, facets and literal % in search', async () => {
    assert.equal((await list('status=Drop%20Out')).total, 1);
    assert.equal((await list('batch=27LAW01')).total, 1);
    assert.equal((await list('q=100%25_')).total, 1);
    assert.equal((await list('q=%25')).total, 1);
    const { facets } = await list();
    assert.deepEqual(facets.status.map((f) => [f.value, f.count]), [['Active', 2], ['Drop Out', 1]]);
  });

  test('students stay out of the main state payload', async () => {
    const state = await (await fetch(`${BASE}/state`)).json();
    assert.equal(state.student_count, 3);
    assert.equal(state.students, undefined);
    assert.equal(JSON.stringify(state).includes('Asha'), false);
  });

  test('edits, additions and removals in the sheet are picked up and counted', async () => {
    google.state.tabs.Students = toGridRows([
      student({ Batch: '26CA09' }),
      student({ 'Sr. No': '2', 'IMS ID': 'STU0000000002', Name: 'Asha', Surname: 'Rao', Batch: '27LAW01', Course: 'LAW', 'MOBILE NUMBER': { text: '9.72E+11', number: 971501234567 } }),
      student({ 'Sr. No': '4', 'IMS ID': 'STU0000000004', Name: 'New', Surname: 'Joiner' }),
    ]);
    const run = await sync();
    assert.deepEqual([run.added, run.updated, run.removed], [1, 1, 1]);
    const { rows } = await list('q=IMS0000000001');
    assert.equal(rows[0].batch, '26CA09');
    assert.equal((await list('q=RSTU0000000003')).total, 0);
  });

  test('when Google says no access, the copy is kept and the message names the account to share with', async () => {
    google.state.failWith = 403;
    const run = await sync();
    google.state.failWith = null;
    assert.equal(run.ok, false);
    assert.match(run.error, /weeklies-test@example\.iam\.gserviceaccount\.com/);
    assert.equal((await list()).total, 3);
    const state = await (await fetch(`${BASE}/state`)).json();
    assert.equal(state.student_sync.last_ok, false);
  });

  test('a renamed required column keeps the copy', async () => {
    const good = google.state.tabs.Students;
    const headers = HEADERS.map((h) => (h === 'Batch' ? 'Batch Code' : h));
    google.state.tabs.Students = toGridRows([student()], headers);
    const run = await sync();
    google.state.tabs.Students = good;
    assert.equal(run.ok, false);
    assert.match(run.error, /Batch/);
    assert.equal((await list()).total, 3);
  });

  test('an emptied sheet keeps the copy', async () => {
    const good = google.state.tabs.Students;
    google.state.tabs.Students = toGridRows([]);
    const run = await sync();
    google.state.tabs.Students = good;
    assert.equal(run.error_code, 'empty');
    assert.equal((await list()).total, 3);
  });

  test('a sudden large drop waits for confirmation, then applies', async () => {
    const many = Array.from({ length: 30 }, (_, i) => student({ 'IMS ID': `STU${i}`, 'Sr. No': String(i) }));
    google.state.tabs.Students = toGridRows(many);
    assert.equal((await sync()).ok, true);

    google.state.tabs.Students = toGridRows(many.slice(0, 5));
    const blocked = await sync();
    assert.equal(blocked.error_code, 'shrink');
    assert.equal((await list()).total, 30);

    const accepted = await sync({ allow_shrink: true });
    assert.equal(accepted.ok, true);
    assert.equal((await list()).total, 5);
  });

  test('two tabs with the headings need GOOGLE_SHEET_TAB; setting it works', async () => {
    google.state.tabs.Archive = toGridRows([student()]);
    const run = await sync();
    assert.equal(run.ok, false);
    assert.match(run.error, /Students, Archive/);

    await stopServer();
    await startServer({ GOOGLE_SHEET_TAB: 'Archive' });
    const chosen = await sync();
    delete google.state.tabs.Archive;
    assert.equal(chosen.ok, true, chosen.error);
    assert.equal(chosen.tab, 'Archive');
    assert.equal(chosen.row_count, 1);
  });

  describe('courses from Current Variant, batches from the sheet', () => {
    const call = async (method, url, body) => {
      const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const state = async () => (await call('GET', '/state')).body;
    const batch = async (code) => (await state()).batches.find((b) => b.name === code);
    const courseId = async (name) => (await state()).courses.find((c) => c.name === name).id;
    const setSheet = (rows) => { google.state.tabs.Students = toGridRows(rows); };
    const row = (id, code, variant, extra = {}) => student({ 'IMS ID': id, Batch: code, 'Current Variant': variant, ...extra });

    // Ticks a variant into a course, as the Courses page does.
    const tick = async (variant, courseName) => {
      const id = courseName ? await courseId(courseName) : null;
      const res = await call('PUT', '/variants', { variant, course_id: id });
      assert.equal(res.status, 200, res.body?.error);
    };

    before(async () => {
      // The previous test left the server pinned to a tab that no longer exists.
      await stopServer();
      await startServer();
      for (const [variant, course] of [
        ['CATapult Classroom 2030', 'CAT'], ['CATapult Elite Classroom 2030', 'CAT'], ['CATapult Live + GDPI 2030', 'CAT'],
        ['CATapult Classroom 2031', 'CAT'], ['CATapult Classroom 2019', 'CAT'],
        ['IPM Indore Live Online 2030', 'IPMAT'], ['CLAT Comprehensive Classroom Pro 2030', 'CLAT'],
        ['CMAT Xclusive 2030', 'CMAT'], ['cmat30-vadodara-int01', 'CMAT'],
      ]) await tick(variant, course);
    });

    test('each active code becomes a batch in the right course, with the right year and slots', async () => {
      setSheet([
        row('STU1', '30CA02', 'CATapult Classroom 2030'),
        row('STU2', '30CA02', 'CATapult Elite Classroom 2030'),
        row('STU3', 'eCAT30 : 101', 'CATapult Live + GDPI 2030'),
        row('STU4', '30 E: IPMAT101', 'IPM Indore Live Online 2030'),
        row('STU5', '30LAW01', 'CLAT Comprehensive Classroom Pro 2030'),
        row('STU6', '30CM01', 'CMAT Xclusive 2030'),
        row('STU7', '30CM01', 'CMAT30-Vadodara-INT01'),
        row('STU8', 'GC01', 'CATapult Classroom 2031'),
        row('STU9', '19OLD', 'CATapult Classroom 2019', { Status: 'Drop Out' }),
        row('STU10', '', 'CATapult Classroom 2030'),
      ]);
      assert.equal((await sync({ allow_shrink: true })).ok, true);
      const s = await state();
      const courseOf = (code) => s.courses.find((c) => c.id === s.batches.find((b) => b.name === code)?.course_id)?.name;
      assert.equal(courseOf('30CA02'), 'CAT');
      assert.equal(courseOf('eCAT30 : 101'), 'CAT');
      assert.equal(courseOf('30 E: IPMAT101'), 'IPMAT');
      assert.equal(courseOf('30LAW01'), 'CLAT');
      assert.equal(courseOf('30CM01'), 'CMAT');
      assert.equal(s.batches.find((b) => b.name === '19OLD'), undefined, 'no batch for a code with no active student');
      assert.equal(s.batches.find((b) => b.name === '30CA02').year, 2030);
      assert.equal(s.batches.find((b) => b.name === 'GC01').year, 2031, 'year falls back to the variant');
      assert.equal(s.batches.find((b) => b.name === '30CA02').active_students, 2);
      assert.deepEqual(s.batches.find((b) => b.name === '30CA02').assignments.map((a) => a.role)[1], 'QA1');
      assert.deepEqual(s.batches_waiting, []);
    });

    test('students show their course and can be filtered by it', async () => {
      const cat = await courseId('CAT');
      const { rows, facets } = await list(`course=${cat}`);
      assert.ok(rows.every((r) => r.course_name === 'CAT'));
      assert.ok(facets.course.some((f) => f.label === 'CMAT' && f.count === 2));
    });

    test('faculty assignments survive syncs, and spacing or capitals in a code still link', async () => {
      const before = await batch('30CA02');
      const faculty = await call('POST', '/faculties', { code: 'LINK1', name: 'Link Tester' });
      const assignments = before.assignments.map((a) => (a.role === 'QA1' ? { ...a, faculty_id: faculty.body.id } : a));
      assert.equal((await call('PUT', `/batches/${before.id}`, { name: before.name, year: before.year, assignments })).status, 200);

      setSheet([row('STU1', '30 ca02', 'CATapult Classroom 2030'), row('STU5', '30LAW01', 'CLAT Comprehensive Classroom Pro 2030')]);
      assert.equal((await sync({ allow_shrink: true })).ok, true);
      const after = await batch('30CA02');
      assert.equal(after.id, before.id);
      assert.equal(after.active_students, 1);
      assert.equal(after.assignments.find((a) => a.role === 'QA1').faculty_id, faculty.body.id);
      assert.equal((await state()).batches.filter((b) => b.name.toLowerCase().replace(/\s/g, '') === '30ca02').length, 1);
    });

    test('a sheet batch with active students cannot be deleted or recoded, but one without can', async () => {
      const live = await batch('30CA02');
      assert.equal((await call('DELETE', `/batches/${live.id}`)).status, 409);
      assert.equal((await call('PUT', `/batches/${live.id}`, { name: 'OTHER', year: live.year, assignments: live.assignments })).status, 409);
      const gone = await batch('30CM01');
      assert.equal(gone.active_students, 0);
      assert.equal((await call('DELETE', `/batches/${gone.id}`)).status, 204);
    });

    test('an untouched variant is in no course: it waits, is reported, and ticking resolves it at once', async () => {
      setSheet([row('STU1', '30CA02', 'CATapult Classroom 2030'), row('STU20', '30BB01', 'Mystery Foundation 2030')]);
      assert.equal((await sync({ allow_shrink: true })).ok, true);
      let s = await state();
      assert.equal(s.batches.find((b) => b.name === '30BB01'), undefined);
      assert.deepEqual(s.batches_waiting.map((w) => [w.code, w.active, w.variants]), [['30BB01', 1, 'Mystery Foundation 2030']]);
      assert.equal(s.variants.find((v) => v.variant === 'Mystery Foundation 2030').course_id, null);
      assert.equal((await list('course=none')).total, 1);

      // Ticked in the course dialog, with spacing that differs from the sheet.
      const msu = s.courses.find((c) => c.name === 'MSU BBA');
      assert.equal((await call('PUT', `/courses/${msu.id}`, { name: msu.name, roles: msu.roles, variants: ['mystery  foundation 2030'] })).status, 200);
      s = await state();
      assert.deepEqual(s.variant_map.filter((m) => m.course_id === msu.id).map((m) => m.variant), ['mystery foundation 2030']);
      assert.deepEqual(s.batches_waiting, []);
      assert.equal(s.batches.find((b) => b.name === '30BB01').course_id, msu.id);
      assert.equal((await list('course=none')).total, 0);
    });

    test('moving a variant moves an untouched batch but only reports one with assigned faculty', async () => {
      const cat = await courseId('CAT');
      const catCourse = (await state()).courses.find((c) => c.id === cat);

      // Ticking it into CAT moves it out of MSU BBA. 30BB01 has no work on it, so it moves too.
      const catVariants = (await state()).variant_map.filter((m) => m.course_id === cat).map((m) => m.variant);
      await call('PUT', `/courses/${cat}`, { name: 'CAT', roles: catCourse.roles, variants: [...catVariants, 'Mystery Foundation 2030'] });
      assert.equal((await state()).variant_map.filter((m) => m.variant.toLowerCase().startsWith('mystery')).length, 1, 'one course per variant');
      const moved = await batch('30BB01');
      assert.equal(moved.course_id, cat);
      assert.equal(moved.assignments.length, catCourse.roles.length);

      // Once faculty are assigned, the same change is reported rather than applied.
      const faculty = (await state()).faculties[0];
      await call('PUT', `/batches/${moved.id}`, {
        name: moved.name, year: moved.year,
        assignments: moved.assignments.map((a, i) => (i === 0 ? { ...a, faculty_id: faculty.id } : a)),
      });
      await tick('Mystery Foundation 2030', 'MSU BBA');
      assert.equal((await batch('30BB01')).course_id, cat);
      const s = await state();
      assert.deepEqual(s.batches_mismatched.map((m) => [m.code, m.students]), [['30BB01', 1]]);

      // Unticking leaves the students with no course; the batch and its faculty stay.
      await tick('Mystery Foundation 2030', null);
      assert.equal((await list('course=none')).total, 1);
      assert.equal((await batch('30BB01')).course_id, cat);
    });

    test('a course edit that leaves variants out keeps them; a bad course is refused', async () => {
      const catCourse = (await state()).courses.find((c) => c.name === 'CAT');
      const before = (await state()).variant_map.length;
      await call('PUT', `/courses/${catCourse.id}`, { name: 'CAT', roles: catCourse.roles });
      assert.equal((await state()).variant_map.length, before);
      assert.equal((await call('PUT', '/variants', { variant: 'X', course_id: 999999 })).status, 404);
      assert.equal((await call('PUT', '/variants', { variant: '' })).status, 400);
    });

    test('variant report and student data stay separate', async () => {
      const s = await state();
      const text = JSON.stringify({ v: s.variants, w: s.batches_waiting, m: s.batches_mismatched });
      assert.equal(text.includes('test.student@example.com'), false);
    });
  });

  test('status never exposes the private key', async () => {
    const text = await (await fetch(`${BASE}/students/sync`)).text();
    assert.equal(text.includes('PRIVATE KEY'), false);
    assert.ok(JSON.parse(text).service_account_email);
  });

  test('an existing database upgrades without losing admin data', async () => {
    await stopServer();
    const file = path.join(dir, 'sync.db');
    const old = new DatabaseSync(file);
    old.exec("INSERT INTO rooms (name) VALUES ('Room Kept')");
    old.exec(`
      DROP TABLE students;
      DROP TABLE student_sync_runs;
      ALTER TABLE courses DROP COLUMN variant_keywords;
      DROP TABLE variant_courses;
      DROP TABLE schedule_classes;
      ALTER TABLE batches DROP COLUMN source;
      DROP TABLE faculty_topics;
      DROP TABLE batch_assignment_substitutes;
      DROP TABLE batch_timings;
      ALTER TABLE batches DROP COLUMN start_date;
      ALTER TABLE batches DROP COLUMN end_date;
      DROP TABLE batch_session_progress;
      ALTER TABLE flow_sessions DROP COLUMN topic_code;
      ALTER TABLE flow_sessions DROP COLUMN area;
      ALTER TABLE flow_sessions DROP COLUMN homework;
      ALTER TABLE flow_sessions ADD COLUMN duration_min INTEGER;
      PRAGMA user_version = 1;`);
    old.close();

    await startServer({ GOOGLE_SHEET_ID: '' });
    const state = await (await fetch(`${BASE}/state`)).json();
    assert.ok(state.rooms.some((r) => r.name === 'Room Kept'));
    assert.equal(state.student_count, 0);
    assert.equal(state.student_sync.configured, false);
  });
});
