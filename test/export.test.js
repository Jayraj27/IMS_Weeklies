import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, columnName } from '../src/xlsx.js';
import { weekWorkbook } from '../src/schedule/export.js';
import { unzip } from '../src/unzip.js';
import { readXlsx } from '../src/xlsx-read.js';

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
  const weekWorkbookFile = weekWorkbook({ weekStart: '2026-11-16', classes, events, rooms, faculties });
  const files = unzip(weekWorkbookFile);
  const week = files['xl/worksheets/sheet1.xml'];

  test('the whole week is one tab, then the list of every class', () => {
    assert.deepEqual(sheetNames(files), ['Week of 16 Nov', 'All classes']);
  });

  test('days sit side by side, each with its rooms in number order, Online, and who is off', () => {
    const t = texts(week);
    assert.equal(t[0], 'Schedule, week of 16 Nov 2026 – 22 Nov 2026');
    assert.deepEqual(t.slice(1, 8), ['Monday, 16 Nov', 'Tuesday, 17 Nov', 'Wednesday, 18 Nov', 'Thursday, 19 Nov', 'Friday, 20 Nov', 'Saturday, 21 Nov', 'Sunday, 22 Nov']);
    assert.deepEqual(t.slice(8, 10), ['Week off: AB', 'Week off: nobody']);
    // Monday: Room 2 (two columns for its clash) B–C, Room 10 D, Online E; divider F.
    // Tuesday: Room 2 G, Room 10 H, Online I, and No room yet J, needed only that day.
    assert.deepEqual(t.slice(15, 23), ['Time', 'Room 2 – 30', 'Room 10 – 40', 'Online', 'Room 2 – 30', 'Room 10 – 40', 'Online', 'No room yet']);
    assert.equal(t.filter((x) => x === 'No room yet').length, 1);
    const m = merges(week);
    assert.ok(m.includes('B2:E2') && m.includes('G2:J2'), 'each day name spans its rooms');
    assert.match(week, /<c r="F10" s="\d+"\/>/, 'the divider column runs down the grid');
    assert.match(week, /<colBreaks count="6"/, 'each day prints on its own pages');
  });

  // Rows: 4 above the grid, then one row per quarter hour from 7:00 am in row 5,
  // so 6:00 pm is row 49 and 11:00 am is row 21.
  const grid = readXlsx(weekWorkbookFile)[0].rows;
  const at = (ref) => {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(ref);
    let c = 0;
    for (const ch of letters) c = c * 26 + ch.charCodeAt(0) - 64;
    return grid[Number(digits) - 1]?.[c - 1] ?? '';
  };
  const column = (letter, from, to) => Array.from({ length: to - from + 1 }, (_, i) => at(`${letter}${from + i}`));

  test('each line of a class has its own cell, and a clash gets its own column', () => {
    assert.ok(merges(week).includes('B4:C4'), 'room heading spans both columns');
    assert.deepEqual(column('B', 49, 56), ['CD', 'QA 1.5 Percentages', 'TEST01', '6:00 pm – 8:00 pm', '', '', '', '']);
    assert.deepEqual(column('C', 53, 57), ['CD', 'QA 1.5 Percentages', 'TEST02', '7:00 pm – 9:00 pm', '⚠ Room 2 is also booked for TEST01.']);
    assert.deepEqual(column('D', 21, 24), ['Faculty meeting', 'AB/CD', '11:00 am – 12:00 pm', '']);
    assert.deepEqual(column('E', 14, 17), ['CD', 'QA 1.5 Percentages', 'TEST03', '9:15 am – 10:45 am'], '9:15 starts on the 9:15 row');
    assert.deepEqual(column('J', 49, 53), ['CD', 'QA 1.5 Percentages', 'TEST04', '6:00 pm – 8:00 pm', '⚠ No room yet.'], 'Tuesday, no room');
    assert.ok(!grid.flat().includes('TEST05'), 'cancelled classes are left off the grid');
    assert.ok(grid.flat().includes('Needs attention'));
  });

  test('blocks are not merged, and have one outline with no lines inside', () => {
    assert.ok(!merges(week).some((m) => /^[B-Z]\d+:[B-Z]\d+$/.test(m) && Number(m.split(':')[0].slice(1)) > 4), 'no merged cells inside the grid');
    const styles = files['xl/styles.xml'];
    const xfs = [...styles.matchAll(/<xf numFmtId[^>]*?borderId="(\d+)"/g)].map((m) => Number(m[1])).slice(1);
    const borders = [...styles.match(/<borders[^>]*>([\s\S]*?)<\/borders>/)[1].matchAll(/<border>([\s\S]*?)<\/border>/g)].map((m) => m[1]);
    const borderOf = (ref) => {
      const s = Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(week)[1]);
      const b = borders[xfs[s]];
      return ['left', 'right', 'top', 'bottom'].filter((side) => new RegExp(`<${side} style=`).test(b)).join(',');
    };
    assert.equal(borderOf('B49'), 'left,right,top', 'first line: open at the bottom');
    assert.equal(borderOf('B50'), 'left,right', 'middle lines: no line above or below');
    assert.equal(borderOf('B56'), 'left,right,bottom', 'last row closes the block');
    assert.equal(at('A5'), '7:00 am');
    assert.equal(at('A6'), '', 'times every half hour');
    assert.ok(merges(week).includes('A5:A6'));
  });

  test('a short class keeps every line: the last row holds the rest', () => {
    const short = readXlsx(weekWorkbook({ weekStart: '2026-11-16', rooms, faculties, events: [], classes: [cls({ start_time: '18:00', end_time: '18:30', warnings: ['Clash.'] })] }))[0].rows;
    const row = (n) => short[n - 1][1];
    assert.deepEqual([row(49), row(50)], ['CD', 'QA 1.5 Percentages · TEST01 · 6:00 pm – 6:30 pm · ⚠ Clash.']);
  });

  test('the list tab has every class, cancelled ones and blocks included', () => {
    const list = texts(files['xl/worksheets/sheet2.xml']);
    for (const name of ['TEST01', 'TEST02', 'TEST03', 'TEST04', 'TEST05', 'Faculty meeting', 'Cancelled', 'Online', 'No room yet.']) {
      assert.ok(list.includes(name), name);
    }
    assert.match(files['xl/worksheets/sheet2.xml'], /<autoFilter ref="A1:R7"\/>/);
    assert.match(files['xl/workbook.xml'], /_xlnm._FilterDatabase/);
  });
});
