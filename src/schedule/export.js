/*
 * The week as one spreadsheet: a tab per day laid out like the centre's own sheet (rooms
 * across, half-hours down, one merged block per class), then an "All classes" tab with a
 * row per class for sorting and filtering.
 */

import { WEEK, addDays, formatDate, formatTime, weekdayOf } from '../../public/admin/calendar.js';
import { EVENT_COLOURS, colourFor } from '../../public/admin/colours.js';
import { buildXlsx, cellRef } from '../xlsx.js';

const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const ROW_MINUTES = 30;
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (item) => `${formatTime(item.start_time)} – ${formatTime(item.end_time)}`;

const S = {
  title: { bold: true, size: 14 },
  sub: { color: '#555555' },
  head: { bold: true, fill: '#E7E6E1', border: true, h: 'center', v: 'center', wrap: true },
  time: { color: '#555555', border: true, borderColor: '#D9D9D9', v: 'top', h: 'right' },
  empty: { border: true, borderColor: '#E3E3E3' },
  warn: { bold: true, color: '#B91C1C' },
  listHead: { bold: true, fill: '#E7E6E1', border: true },
  list: { border: true, borderColor: '#E3E3E3', v: 'top', wrap: true },
  listWarn: { border: true, borderColor: '#E3E3E3', v: 'top', wrap: true, color: '#B91C1C' },
};

function columnsFor(rooms, items) {
  const columns = [...rooms]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .map((r) => ({ key: `room:${r.id}`, label: r.capacity ? `${r.name} – ${r.capacity}` : r.name }));
  columns.push({ key: 'online', label: 'Online' });
  if (items.some((x) => !x.online && !x.room_id)) columns.push({ key: 'none', label: 'No room yet' });
  return columns;
}

const columnKeyOf = (item) => (item.online ? 'online' : item.room_id ? `room:${item.room_id}` : 'none');

function blockText(item, faculties) {
  const lines = item.kind === 'event'
    ? [item.title, item.faculty_ids.map((id) => faculties.get(id)?.code).filter(Boolean).join('/')]
    : [
        item.faculty_code ?? 'No faculty',
        item.session_id ? `${item.topic_code || item.subject} ${item.topic}` : 'No session',
        item.batch_name,
      ];
  lines.push(span(item));
  if (item.status === 'done') lines.push('✓ Done');
  for (const w of item.warnings) lines.push(`⚠ ${w}`);
  return lines.filter(Boolean).join('\n');
}

function daySheet(date, { classes, events, rooms, faculties, colourBy }) {
  const items = [
    ...classes.filter((c) => c.date === date && c.status !== 'cancelled').map((c) => ({ ...c, kind: 'class' })),
    ...events.filter((e) => e.date === date).map((e) => ({ ...e, kind: 'event' })),
  ];
  const weekday = weekdayOf(date);
  let start = 7 * 60;
  let end = 21 * 60;
  for (const x of items) {
    start = Math.min(start, Math.floor(toMinutes(x.start_time) / ROW_MINUTES) * ROW_MINUTES);
    end = Math.max(end, Math.ceil(toMinutes(x.end_time) / ROW_MINUTES) * ROW_MINUTES);
  }
  const slots = (end - start) / ROW_MINUTES;
  const FIRST = 3; // rows above the grid: title, week-offs, room names

  // Each item covers whole half-hour rows. Items that share a row in one room go side by
  // side in extra columns, so a clash shows instead of one class hiding another.
  const columns = columnsFor(rooms, items).map((col) => {
    const placed = items
      .filter((x) => columnKeyOf(x) === col.key)
      .map((x) => ({
        item: x,
        top: Math.floor((toMinutes(x.start_time) - start) / ROW_MINUTES),
        bottom: Math.max(Math.floor((toMinutes(x.start_time) - start) / ROW_MINUTES), Math.ceil((toMinutes(x.end_time) - start) / ROW_MINUTES) - 1),
      }))
      .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
    const laneEnds = [];
    for (const p of placed) {
      let lane = laneEnds.findIndex((last) => last < p.top);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = p.bottom;
      p.lane = lane;
    }
    return { ...col, placed, lanes: Math.max(1, laneEnds.length) };
  });

  const width = 1 + columns.reduce((n, c) => n + c.lanes, 0);
  const rows = Array.from({ length: FIRST + slots }, () => Array(width).fill(null));
  const merges = [];
  const merge = (r1, c1, r2, c2) => { if (r1 !== r2 || c1 !== c2) merges.push(`${cellRef(r1, c1)}:${cellRef(r2, c2)}`); };

  rows[0][0] = { v: `${DAY_NAMES[weekday]}, ${formatDate(date)}`, s: S.title };
  merge(0, 0, 0, width - 1);
  const off = [...faculties.values()].filter((f) => f.week_offs.includes(weekday)).map((f) => f.code).sort();
  rows[1][0] = { v: off.length ? `Week off: ${off.join(', ')}` : 'Week off: nobody', s: S.sub };
  merge(1, 0, 1, width - 1);

  rows[2][0] = { v: 'Time', s: S.head };
  for (let r = 0; r < slots; r++) {
    rows[FIRST + r][0] = { v: formatTime(toTime(start + r * ROW_MINUTES)), s: S.time };
    for (let c = 1; c < width; c++) rows[FIRST + r][c] = { v: null, s: S.empty };
  }

  let col = 1;
  for (const column of columns) {
    for (let lane = 0; lane < column.lanes; lane++) rows[2][col + lane] = { v: lane ? null : column.label, s: S.head };
    merge(2, col, 2, col + column.lanes - 1);
    for (const p of column.placed) {
      const x = p.item;
      const [fill, edge] = x.kind === 'event' ? EVENT_COLOURS : colourFor(colourBy === 'batch' ? x.batch_name : x.faculty_code);
      const warned = x.warnings.length > 0;
      const style = {
        fill, wrap: true, v: 'top', border: true,
        borderColor: warned ? '#DC2626' : edge, borderWeight: warned ? 'medium' : 'thin',
        bold: false, color: warned ? '#7F1D1D' : '#1F2937',
      };
      const c = col + p.lane;
      for (let r = p.top; r <= p.bottom; r++) rows[FIRST + r][c] = { v: null, s: style };
      rows[FIRST + p.top][c] = { v: blockText(x, faculties), s: style };
      merge(FIRST + p.top, c, FIRST + p.bottom, c);
    }
    col += column.lanes;
  }

  // Problems for the day, listed under the grid as on the Day grid page.
  const problems = items.filter((x) => x.warnings.length).sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (problems.length) {
    rows.push([], [{ v: 'Needs attention', s: S.warn }]);
    for (const x of problems) {
      const name = x.kind === 'event' ? x.title : x.batch_name;
      rows.push([{ v: `${formatTime(x.start_time)}  ${name}: ${x.warnings.join(' ')}`, s: { color: '#B91C1C' } }]);
    }
  }

  const rowHeights = [22, 16, 30, ...Array(slots).fill(30)];
  return {
    name: `${weekday} ${formatDate(date).replace(/ \d{4}$/, '')}`,
    rows,
    merges,
    cols: [10, ...Array(width - 1).fill(24)],
    rowHeights,
    freeze: { row: FIRST, col: 1 },
    repeatRows: FIRST,
    landscape: true,
  };
}

function listSheet({ classes, events, faculties }) {
  const head = ['Date', 'Day', 'Start', 'End', 'Type', 'Batch / block', 'Subject', 'No', 'Topic code', 'Topic', 'Area',
    'Faculty code', 'Faculty', 'Room', 'Status', 'Problems', 'Notes', 'Homework'];
  const rowsOf = [
    ...classes.map((c) => ({
      sort: `${c.date} ${c.start_time} ${c.batch_name}`,
      warned: c.warnings.length > 0,
      cells: [formatDate(c.date), weekdayOf(c.date), formatTime(c.start_time), formatTime(c.end_time), 'Class', c.batch_name,
        c.subject ?? '', c.no ?? '', c.topic_code ?? '', c.topic ?? '', c.area ?? '', c.faculty_code ?? '', c.faculty_name ?? '',
        c.online ? 'Online' : c.room_name ?? '', c.status[0].toUpperCase() + c.status.slice(1), c.warnings.join(' '),
        [...(c.flags ?? []), c.note, c.edited ? 'Changed by hand' : null].filter(Boolean).join(' '), c.homework ?? ''],
    })),
    ...events.map((e) => ({
      sort: `${e.date} ${e.start_time} ${e.title}`,
      warned: e.warnings.length > 0,
      cells: [formatDate(e.date), weekdayOf(e.date), formatTime(e.start_time), formatTime(e.end_time), 'Block', e.title,
        '', '', '', '', '', e.faculty_ids.map((id) => faculties.get(id)?.code).filter(Boolean).join(', '), '',
        e.online ? 'Online' : e.room_name ?? '', '', e.warnings.join(' '), '', ''],
    })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));

  const rows = [
    head.map((v) => ({ v, s: S.listHead })),
    ...rowsOf.map((r) => r.cells.map((v, i) => ({ v, s: r.warned && i === 15 ? S.listWarn : S.list }))),
  ];
  return {
    name: 'All classes',
    rows,
    cols: [12, 6, 9, 9, 7, 16, 10, 5, 10, 30, 12, 10, 18, 14, 10, 40, 40, 30],
    freeze: { row: 1 },
    filter: `A1:${cellRef(Math.max(1, rows.length - 1), head.length - 1)}`,
  };
}

/**
 * classes and events come from the schedule's week, each with its warnings.
 * faculties: [{ id, code, name, week_offs }], rooms: [{ id, name, capacity }].
 */
export function weekWorkbook({ weekStart, classes, events, rooms, faculties, colourBy = 'faculty' }) {
  const byId = new Map(faculties.map((f) => [f.id, f]));
  const days = WEEK.map((_, i) => addDays(weekStart, i));
  return buildXlsx([
    ...days.map((date) => daySheet(date, { classes, events, rooms, faculties: byId, colourBy })),
    listSheet({ classes, events, faculties: byId }),
  ]);
}
