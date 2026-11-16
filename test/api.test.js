import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn } from './sign-in.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklies-test-'));
const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}/api`;
let server;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const state = async () => (await call('GET', '/state')).body;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: { ...process.env, PORT, DB_PATH: path.join(dir, 'test.db') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/state');
      await signIn(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start');
});

after(async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a new database starts with the five courses and the CAT slots', async () => {
  const { courses } = await state();
  assert.deepEqual(courses.map((c) => c.name), ['CAT', 'CLAT', 'CMAT', 'IPMAT', 'MSU BBA']);
  assert.deepEqual(
    courses.find((c) => c.name === 'CAT').roles.map((r) => r.name),
    ['Mentor', 'QA1', 'QA2', 'QA3', 'VRC1', 'VRC2', 'DILR'],
  );
});

test('faculty: saves details, rejects a duplicate code, merges subject spelling', async () => {
  const { courses } = await state();
  const cat = courses.find((c) => c.name === 'CAT');
  const made = await call('POST', '/faculties', {
    code: 'RS01', name: 'Riya Shah', course_ids: [cat.id], subjects: ['quant', 'QUANT'], week_offs: ['Sun', 'Mon'],
  });
  assert.equal(made.status, 201);

  const f = (await state()).faculties.find((x) => x.id === made.body.id);
  assert.deepEqual(f.subjects, ['Quant']);
  assert.deepEqual(f.week_offs, ['Mon', 'Sun']);
  assert.deepEqual(f.course_ids, [cat.id]);

  const dupe = await call('POST', '/faculties', { code: 'rs01', name: 'Someone Else' });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /Riya Shah/);

  const badDay = await call('POST', '/faculties', { code: 'X1', name: 'X', week_offs: ['Funday'] });
  assert.equal(badDay.status, 400);
});

test('planned batches: use the sheet-style code, get course slots and unique codes', async () => {
  const cat = (await state()).courses.find((c) => c.name === 'CAT');
  for (let i = 1; i <= 10; i++) {
    const code = `26CA${String(i).padStart(2, '0')}`;
    assert.equal((await call('POST', '/batches', { course_id: cat.id, code })).status, 201);
  }

  const { batches } = await state();
  assert.equal(batches.length, 10);
  assert.equal(batches[0].name, '26CA01');
  assert.equal(batches[9].name, '26CA10');
  assert.equal(batches[0].year, 2026);
  assert.equal(batches[0].assignments.length, 7);
  assert.ok(batches[0].assignments.every((a) => a.faculty_id === null));

  assert.equal((await call('POST', '/batches', { course_id: cat.id, code: '26 ca 01' })).status, 409);
  assert.equal((await call('POST', '/batches', { course_id: cat.id, code: 'GC' })).status, 400);
  assert.equal((await call('POST', '/batches', { course_id: cat.id, code: 'GC', year: 2027 })).status, 201);
  const gc = (await state()).batches.find((b) => b.name === 'GC');
  assert.equal((await call('DELETE', `/batches/${gc.id}`)).status, 204);
});

test('variants are ticked into courses; none are assigned by themselves', async () => {
  assert.deepEqual((await state()).variant_map, [], 'new courses start with no variants');
  const made = await call('POST', '/courses', { name: 'Test Course', variants: ['Alpha 2027', 'alpha 2027', 'Beta 2027'] });
  const map = (await state()).variant_map;
  assert.deepEqual(map.map((m) => [m.variant, m.course_id]), [['alpha 2027', made.body.id], ['Beta 2027', made.body.id]]);
  await call('DELETE', `/courses/${made.body.id}`);
  assert.deepEqual((await state()).variant_map, [], 'deleting a course frees its variants');
});

test('batch slots can vary per batch; deleting faculty leaves the slot open', async () => {
  const s = await state();
  const batch = s.batches[0];
  const riya = s.faculties.find((f) => f.code === 'RS01');
  const assignments = [
    ...batch.assignments.map((a) => (a.role === 'QA1' ? { ...a, faculty_id: riya.id } : a)),
    { role: 'Doubt Desk', subject: 'Quant', faculty_id: riya.id },
  ];
  const saved = await call('PUT', `/batches/${batch.id}`, { name: batch.name, year: batch.year, assignments });
  assert.equal(saved.status, 200);

  const dupeSlot = await call('PUT', `/batches/${batch.id}`, {
    name: batch.name, year: batch.year, assignments: [{ role: 'QA1' }, { role: 'qa1' }],
  });
  assert.equal(dupeSlot.status, 400);

  const temp = await call('POST', '/faculties', { code: 'TMP', name: 'Temp' });
  await call('PUT', `/batches/${batch.id}`, {
    name: batch.name, year: batch.year,
    assignments: assignments.map((a) => (a.role === 'Doubt Desk' ? { ...a, faculty_id: temp.body.id } : a)),
  });
  assert.equal((await call('DELETE', `/faculties/${temp.body.id}`)).status, 204);
  const after = (await state()).batches.find((b) => b.id === batch.id);
  assert.equal(after.assignments.find((a) => a.role === 'Doubt Desk').faculty_id, null);
  assert.equal(after.assignments.find((a) => a.role === 'QA1').faculty_id, riya.id);
});

test('course edit can push new slots to existing batches without touching old ones', async () => {
  const s = await state();
  const cat = s.courses.find((c) => c.name === 'CAT');
  const res = await call('PUT', `/courses/${cat.id}`, {
    name: 'CAT', roles: [...cat.roles, { name: 'QA4', subject: 'Quant' }], apply_to_batches: true,
  });
  assert.equal(res.status, 200);
  const after = await state();
  assert.ok(after.batches.every((b) => b.assignments.some((a) => a.role === 'QA4')));
  assert.equal(after.batches[0].assignments.find((a) => a.role === 'QA1').faculty_id != null, true);
});

test('flows: batch group overrides course-wide flow and conflicts are refused', async () => {
  const s = await state();
  const cat = s.courses.find((c) => c.name === 'CAT');
  const [b1, b2] = s.batches;
  const sessions = [
    { subject: 'quant', topic: 'Percentages', topic_code: 'QA 1.5A', area: 'Arithmetic', homework: 'https://example.com/hw' },
    { subject: 'Verbal', topic: 'RC basics' },
  ];

  const wide = await call('POST', '/flows', { course_id: cat.id, name: 'Standard', scope: 'course', sessions });
  assert.equal(wide.status, 201);
  const secondWide = await call('POST', '/flows', { course_id: cat.id, name: 'Other', scope: 'course' });
  assert.equal(secondWide.status, 409);

  const group = await call('POST', '/flows', {
    course_id: cat.id, name: 'Fast track', scope: 'batches', batch_ids: [b1.id], sessions,
  });
  assert.equal(group.status, 201);

  const clash = await call('POST', '/flows', {
    course_id: cat.id, name: 'Clash', scope: 'batches', batch_ids: [b1.id],
  });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Fast track/);

  const after = await state();
  assert.equal(after.batches.find((b) => b.id === b1.id).flow.name, 'Fast track');
  assert.equal(after.batches.find((b) => b.id === b2.id).flow.name, 'Standard');
  assert.equal(after.flows.find((f) => f.name === 'Standard').sessions[0].subject, 'Quant');

  const wrongCourse = s.courses.find((c) => c.name === 'CLAT');
  const cross = await call('POST', '/flows', {
    course_id: wrongCourse.id, name: 'Cross', scope: 'batches', batch_ids: [b2.id],
  });
  assert.equal(cross.status, 400);

  const blank = await call('POST', '/flows', {
    course_id: cat.id, name: 'Blank', scope: 'batches', batch_ids: [b2.id], sessions: [{ subject: 'Quant', topic: '' }],
  });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /Session 1/);
});

test('batch progress: stored per batch, per flow, and survives flow corrections', async () => {
  const cat = (await state()).courses.find((c) => c.name === 'CAT');
  const rows = [
    { topic_code: 'QA 1', topic: 'One', subject: 'QA' },
    { topic_code: 'Test', topic: 'Same test', subject: 'TEST QA' },
    { topic_code: 'VA 1', topic: 'Two', subject: 'VA' },
    { topic_code: 'Test', topic: 'Same test', subject: 'TEST QA' },
    { topic_code: 'QA 2', topic: 'Three', subject: 'QA' },
  ];
  // Batch 26CA05 onwards aren't in a group flow yet.
  const pick = (await state()).batches.filter((b) => b.name === '26CA05' || b.name === '26CA06');
  const made = await call('POST', '/flows', { course_id: cat.id, name: 'Progress flow', scope: 'batches', batch_ids: pick.map((b) => b.id), sessions: rows });
  assert.equal(made.status, 201);
  const flowOf = async () => (await state()).flows.find((f) => f.id === made.body.id);
  let ids = (await flowOf()).sessions.map((s) => s.id);

  const [first, second] = pick;
  assert.equal((await call('PUT', `/batches/${first.id}/progress`, { finished: [ids[0], ids[1], ids[4]] })).status, 200);
  let batch = (await state()).batches.find((b) => b.id === first.id);
  assert.deepEqual([batch.progress.done, batch.progress.total, batch.progress.next.topic], [3, 5, 'Two']);
  assert.equal((await state()).batches.find((b) => b.id === second.id).progress.done, 0, 'other batches are separate');

  const wrong = await call('PUT', `/batches/${first.id}/progress`, { finished: [999999] });
  assert.equal(wrong.status, 400);

  // A re-upload without ids: reordered, one topic fixed, one row new, one row removed.
  const reupload = [
    { topic_code: 'QA 2', topic: 'Three (corrected)', subject: 'QA' },
    { topic_code: 'QA 1', topic: 'One', subject: 'QA' },
    { topic_code: 'New', topic: 'Brand new', subject: 'VA' },
    { topic_code: 'Test', topic: 'Same test', subject: 'TEST QA' },
    { topic_code: 'Test', topic: 'Same test', subject: 'TEST QA' },
  ];
  const body = { name: 'Progress flow', scope: 'batches', batch_ids: pick.map((b) => b.id), sessions: reupload };
  const saved = await call('PUT', `/flows/${made.body.id}`, body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.progress_lost, 0);
  const after = (await flowOf()).sessions;
  assert.deepEqual(after.map((s) => s.topic), ['Three (corrected)', 'One', 'Brand new', 'Same test', 'Same test']);
  const finished = (await call('GET', `/flows/${made.body.id}/progress`)).body.finished[first.id];
  assert.deepEqual(new Set(finished), new Set([after[0].id, after[1].id, after[3].id]));

  // Editing a row on screen keeps its id, even with a completely new name.
  const edited = after.map((s, i) => (i === 1 ? { ...s, topic_code: 'QA X', topic: 'Renamed' } : s));
  await call('PUT', `/flows/${made.body.id}`, { ...body, sessions: edited });
  assert.equal((await flowOf()).sessions[1].id, after[1].id);

  // Removing a finished session reports the loss.
  const lost = await call('PUT', `/flows/${made.body.id}`, { ...body, sessions: edited.slice(1) });
  assert.equal(lost.body.progress_lost, 1);

  await call('DELETE', `/flows/${made.body.id}`);
  batch = (await state()).batches.find((b) => b.id === first.id);
  assert.equal((await call('GET', `/flows/${made.body.id}/progress`)).status, 404);
  assert.equal(batch.flow.scope, 'course');
});

test('a course with batches or flows cannot be deleted', async () => {
  const s = await state();
  const cat = s.courses.find((c) => c.name === 'CAT');
  const res = await call('DELETE', `/courses/${cat.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /batches/);

  const clat = s.courses.find((c) => c.name === 'CLAT');
  assert.equal((await call('DELETE', `/courses/${clat.id}`)).status, 204);
});

test('rooms: add, reject duplicates, validate capacity, delete', async () => {
  const made = await call('POST', '/rooms', { name: 'Room 101', capacity: 40, location: 'Floor 1' });
  assert.equal(made.status, 201);
  assert.equal((await call('POST', '/rooms', { name: 'room 101' })).status, 409);
  assert.equal((await call('POST', '/rooms', { name: 'R2', capacity: -3 })).status, 400);
  assert.equal((await call('DELETE', `/rooms/${made.body.id}`)).status, 204);
});

test('bad input gets a clean JSON error', async () => {
  const res = await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal((await call('PUT', '/rooms/99999', { name: 'x' })).status, 404);
});
