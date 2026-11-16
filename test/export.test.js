import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, columnName } from '../src/xlsx.js';
import { weekWorkbook } from '../src/schedule/export.js';
import { unzip } from './unzip.js';

const sheetNames = (files) => [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
const texts = (xml) => [...xml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) => m[1]);
const merges = (xml) => [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);

describe('spreadsheet file', () => {
  test('column names run A to Z, then AA', () => {
    assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  test('a workbook has every part, with text escaped and sheet names made safe', () => {
    const files = unzip(buildXlsx([
      { name: 'Mon/Tue [draft]', rows: [['<b>Tom & Jerry</b>', 42, null, { v: 'styled', s: { bold: true, fill: '#ff0000' } }]] },
      { name: 'Mon/Tue [draft]', rows: [] },
    ]));
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      assert.ok(files[part], part);
    }
    assert.deepEqual(sheetNames(files), ['Mon Tue  draft', 'Mon Tue  draft 2']);
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /&lt;b&gt;Tom &amp; Jerry&lt;\/b&gt;/);
    assert.match(sheet, /<c r="B1"><v>42<\/v><\/c>/);
    assert.match(files['xl/styles.xml'], /FFFF0000/);
  });

  test('characters a spreadsheet cannot hold are dropped, not left to break the file', () => {
    const files = unzip(buildXlsx([{ name: 'S', rows: [['bad\u0001char', 'ok – ✓ ⚠ ગુજરાતી']] }]));
    const t = texts(files['xl/worksheets/sheet1.xml']);
    assert.deepEqual(t, ['badchar', 'ok – ✓ ⚠ ગુજરાતી']);
  });
});

describe('week export', () => {
  const rooms = [{ id: 1, name: 'Room 10', capacity: 40 }, { id: 2, name: 'Room 2', capacity: 30 }];
  const faculties = [
    { id: 1, code: 'AB', name: 'Test Faculty One', week_offs: ['Mon'] },
    { id: 2, code: 'CD', name: 'Test Faculty Two', week_offs: [] },
  ];
  const cls = (over) => ({
    id: 1, batch_id: 1, batch_name: 'TEST01', date: '2026-11-16', start_time: '18:00', end_time: '20:00',
    session_id: 5, no: 6, subject: 'QA', topic_code: 'QA 1.5', topic: 'Percentages', area: 'Arithmetic', homework: null,
    faculty_id: 2, faculty_code: 'CD', faculty_name: 'Test Faculty Two', room_id: 2, room_name: 'Room 2', online: false,
    status: 'planned', edited: false, note: null, flags: [], warnings: [], ...over,
  });
  const classes = [
    cls({}),
    cls({ id: 2, batch_name: 'TEST02', start_time: '19:00', end_time: '21:00', warnings: ['Room 2 is also booked for TEST01.'] }),
    cls({ id: 3, batch_name: 'TEST03', start_time: '09:15', end_time: '10:45', room_id: null, room_name: null, online: true }),
    cls({ id: 4, batch_name: 'TEST04', date: '2026-11-17', room_id: null, room_name: null, warnings: ['No room yet.'] }),
    cls({ id: 5, batch_name: 'TEST05', status: 'cancelled', room_id: 1, room_name: 'Room 10' }),
  ];
  const events = [{ id: 1, title: 'Faculty meeting', date: '2026-11-16', start_time: '11:00', end_time: '12:00', room_id: 1, room_name: 'Room 10', online: false, faculty_ids: [1, 2], warnings: [] }];
  const files = unzip(weekWorkbook({ weekStart: '2026-11-16', classes, events, rooms, faculties }));
  const monday = files['xl/worksheets/sheet1.xml'];

  test('one tab per day of the week, then the list of every class', () => {
    assert.deepEqual(sheetNames(files), ['Mon 16 Nov', 'Tue 17 Nov', 'Wed 18 Nov', 'Thu 19 Nov', 'Fri 20 Nov', 'Sat 21 Nov', 'Sun 22 Nov', 'All classes']);
  });

  test('a day tab has rooms across in number order, Online, and who is off', () => {
    const t = texts(monday);
    assert.equal(t[0], 'Monday, 16 Nov 2026');
    assert.equal(t[1], 'Week off: AB');
    assert.deepEqual(t.slice(2, 6), ['Time', 'Room 2 – 30', 'Room 10 – 40', 'Online']);
    assert.ok(!t.includes('No room yet'), 'only shown on days that need it');
    assert.ok(texts(files['xl/worksheets/sheet2.xml']).includes('No room yet'));
  });

  test('each class is one block covering its half-hours, and a clash gets its own column', () => {
    // Rows: 3 above the grid, then 7:00 am in row 4, so 6:00 pm is row 26.
    // Room 2 holds two overlapping classes, so it spans B and C; Room 10 is D, Online is E.
    const m = merges(monday);
    assert.ok(m.includes('B3:C3'), 'room heading spans both columns');
    assert.ok(m.includes('B26:B29'), '6 to 8 pm');
    assert.ok(m.includes('C28:C31'), '7 to 9 pm, beside it');
    assert.ok(m.includes('D12:D13'), 'the meeting, 11 to 12');
    assert.ok(m.includes('E8:E11'), '9:15 to 10:45 covers the 9:00 to 10:30 rows');
    const t = texts(monday);
    assert.ok(t.includes('CD\nQA 1.5 Percentages\nTEST01\n6:00 pm – 8:00 pm'));
    assert.ok(t.some((x) => x.startsWith('CD\nQA 1.5 Percentages\nTEST02') && x.includes('⚠ Room 2 is also booked')));
    assert.ok(t.includes('Faculty meeting\nAB/CD\n11:00 am – 12:00 pm'));
    assert.ok(!t.some((x) => x.includes('TEST05')), 'cancelled classes are left off the grid');
    assert.ok(t.includes('Needs attention'));
  });

  test('the list tab has every class, cancelled ones and blocks included', () => {
    const list = texts(files['xl/worksheets/sheet8.xml']);
    for (const name of ['TEST01', 'TEST02', 'TEST03', 'TEST04', 'TEST05', 'Faculty meeting', 'Cancelled', 'Online', 'No room yet.']) {
      assert.ok(list.includes(name), name);
    }
    assert.match(files['xl/worksheets/sheet8.xml'], /<autoFilter ref="A1:R7"\/>/);
    assert.match(files['xl/workbook.xml'], /_xlnm._FilterDatabase/);
  });
});
