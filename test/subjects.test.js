import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupBySubject, similarSubjects } from '../public/admin/subjects.js';

const flow = [
  { topic: 'A Date with CAT', subject: 'MISC' },
  { topic: 'Fun with QA', subject: 'QA' },
  { topic: 'Orientation to Reading', subject: 'VARC' },
  { topic: 'Percentages', subject: 'QA' },
  { topic: 'Test QA 1', subject: 'TEST QA' },
  { topic: 'Arrangements', subject: 'DILR' },
  { topic: 'Para jumbles', subject: ' varc ' },
  { topic: 'No subject yet', subject: '' },
];

describe('a master flow divided by subject', () => {
  test('each subject keeps the flow’s order, numbered within the subject', () => {
    const groups = groupBySubject(flow);
    assert.deepEqual(groups.map((g) => g.subject), ['MISC', 'QA', 'VARC', 'DILR'], 'in order of first appearance');
    const qa = groups.find((g) => g.subject === 'QA');
    assert.deepEqual(qa.items.map((i) => [i.no, i.index, i.session.topic]), [[1, 1, 'Fun with QA'], [2, 3, 'Percentages'], [3, 4, 'Test QA 1']], 'TEST QA is taught by QA faculty, so it sits under QA');
    assert.deepEqual(groups.find((g) => g.subject === 'VARC').items.map((i) => i.index), [2, 6], 'spacing and capitals don’t split a subject');
    assert.equal(groups.flatMap((g) => g.items).length, 7, 'a session without a subject belongs to none');
  });

  test('a subject only covers another when the flow has it', () => {
    assert.deepEqual(groupBySubject([{ subject: 'TEST QA' }, { subject: 'VARC' }]).map((g) => g.subject), ['TEST QA', 'VARC']);
  });

  test('names that look like one subject written two ways are flagged', () => {
    assert.deepEqual(similarSubjects(['QA', 'VA', 'VARC', 'DILR', 'LRDI', 'TEST QA', 'MISC']), [['VA', 'VARC'], ['DILR', 'LRDI']]);
    assert.deepEqual(similarSubjects(['QA', 'VARC', 'DILR', 'TEST QA', 'qa ']), [], 'one spelling each: nothing to flag');
  });
});
