import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessions } from '../public/admin/views/parse-sessions.js';
import { matchSessions } from '../src/flows/match.js';

// Rows in the layout of the real CAT master flow, with its summary rows and blank columns.
const SAMPLE = [
  'VA\t54\tQA\t64\tDILR\t26\tMISC\t2\t146\t158\t146',
  'TEST VA\t0\tTEST QA\t12\t\t\t\t\t12\t13.16666667\t12.16666667',
  '\t\t\t\t\t\t\t\t\t\t',
  '\t\t\t\t\t\t\t\t\t\t',
  'No\tTopic Code\tTopic\tArea\tSuject\thomework link \t\t\t\t\t',
  '1\tDWC\tA Date with CAT\tOrientation\tMISC\t\t\t\t\t\t',
  '2\tQA 0.1\tFun with QA (Speed Maths)\tQuants\tQA\tPercentage to Fraction\t\t\t\t\t',
  '13\tQA 1.5A\tPercentages(A)\tArithmetic\tQA\thttps://drive.google.com/file/d/example/view\t\t\t\t\t',
  '30\tTest\tTest QA 1.5, 1.7, 1.8: Percentage,Profit & Loss, SICI\tQA\tTEST QA\t\t\t\t\t\t',
  '60\tQA 2.2 (B)\tTime-Speed-Distance  (B)\tArithmetic\tQA\t\t\t\t\t\t',
].join('\n');

describe('reading a master flow', () => {
  test('finds the headings below the summary rows, including the "Suject" spelling', () => {
    const { sessions, problems } = parseSessions(SAMPLE);
    assert.deepEqual(problems, []);
    assert.equal(sessions.length, 5);
    assert.deepEqual(sessions[0], { topic_code: 'DWC', topic: 'A Date with CAT', area: 'Orientation', subject: 'MISC', homework: '' });
    assert.equal(sessions[1].homework, 'Percentage to Fraction');
    assert.equal(sessions[2].homework, 'https://drive.google.com/file/d/example/view');
    assert.equal(sessions[3].subject, 'TEST QA');
    assert.equal(sessions[4].topic, 'Time-Speed-Distance (B)');
  });

  test('numbers that disagree with the order are noted, not refused', () => {
    const { notes } = parseSessions(SAMPLE);
    assert.ok(notes.some((n) => n.includes('numbered 13')));
  });

  test('CSV with quoted commas and line breaks', () => {
    const csv = 'Topic Code,Topic,Subject\r\nQA 1,"Percent, ratio ""and""\nmore",QA\r\n';
    const { sessions } = parseSessions(csv);
    assert.deepEqual([sessions[0].topic_code, sessions[0].topic, sessions[0].subject], ['QA 1', 'Percent, ratio "and" more', 'QA']);
  });

  test('a missing heading row or incomplete row is reported', () => {
    assert.match(parseSessions('1\tQA\tPercentages').problems[0], /heading row/);
    assert.deepEqual(parseSessions('   ').problems, []);
    const { sessions, problems } = parseSessions('Topic\tSubject\nGood\tQA\nNo subject\t\n\tNo topic');
    assert.equal(sessions.length, 1);
    assert.deepEqual(problems, ['Line 3: needs both a topic and a subject.', 'Line 4: needs both a topic and a subject.']);
  });
});

describe('matching sessions on re-upload', () => {
  const old = [
    { id: 1, code: 'QA 1', topic: 'One' },
    { id: 2, code: 'Test', topic: 'Same' },
    { id: 3, code: 'Test', topic: 'Same' },
    { id: 4, code: 'QA 2', topic: 'Two' },
    { id: 5, code: 'Test', topic: 'Old test' },
  ];

  test('repeated rows pair up in order, and spacing or capitals do not matter', () => {
    assert.deepEqual(matchSessions(old, [{ code: 'Test', topic: 'SAME' }, { code: 'test', topic: ' Same ' }, { code: 'qa1', topic: 'one' }]), [2, 3, 1]);
  });

  test('a corrected topic matches on a unique code, but not on a generic repeated one', () => {
    assert.deepEqual(matchSessions(old, [{ code: 'QA 2', topic: 'Two (fixed)' }]), [4]);
    assert.deepEqual(matchSessions(old, [{ code: 'Test', topic: 'Different test' }]), [null]);
  });

  test('an id from this flow wins; an id from elsewhere is ignored', () => {
    assert.deepEqual(matchSessions(old, [{ id: 4, code: 'Z', topic: 'Renamed' }]), [4]);
    assert.deepEqual(matchSessions(old, [{ id: 99, code: 'New', topic: 'New' }]), [null]);
  });

  test('each old session is used once', () => {
    const result = matchSessions(old, [{ code: 'QA 1', topic: 'One' }, { code: 'QA 1', topic: 'One' }]);
    assert.deepEqual(result, [1, null]);
  });
});
