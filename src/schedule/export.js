/*
 * The week as one spreadsheet. The "Week" tab is laid out like the centre's own sheet,
 * with the days side by side: under each day, its rooms across and half-hours down, one
 * merged block per class, and a shaded column between days. An "All classes" tab follows,
 * with a row per class for sorting and filtering.
 */

import { WEEK, addDays, formatDate, formatTime, weekdayOf } from '../../public/admin/calendar.js';
import { EVENT_COLOURS, colourFor } from '../../public/admin/colours.js';
import { buildXlsx, cellRef } from '../xlsx.js';

const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
// Quarter-hour rows, so each line of a class (faculty, topic, batch, time) gets its own cell.
const ROW_MINUTES = 15;
const LABEL_MINUTES = 30; // times are labelled every half hour
const FIRST = 4; // rows above the grid: title, day names, week-offs, room names
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (item) => `${formatTime(item.start_time)} – ${formatTime(item.end_time)}`;
const shortDate = (iso) => formatDate(iso).replace(/ \d{4}$/, '');

const S = {
  title: { bold: true, size: 14 },
  day: { bold: true, size: 12, fill: '#D6D3C9', border: true, borderColor: '#8A8A80', h: 'center', v: 'center' },
  off: { color: '#555555', fill: '#F4F3EF', border: true, borderColor: '#D9D9D9', h: 'center', wrap: true },
  head: { bold: true, fill: '#E7E6E1', border: true, h: 'center', v: 'center', wrap: true },
  time: { color: '#555555', border: true, borderColor: '#D9D9D9', sides: 'rb', v: 'top', h: 'right' },
  // Empty grid cells: faint lines between rooms, and across only at each half hour.
  empty: { border: true, borderColor: '#E3E3E3', sides: 'lr' },
  emptyHalf: { border: true, borderColor: '#E3E3E3', sides: 'lrb' },
  divider: { fill: '#5D6474' },
  warn: { bold: true, color: '#B91C1C' },
  listHead: { bold: true, fill: '#E7E6E1', border: true },
  list: { border: true, borderColor: '#E3E3E3', v: 'top', wrap: true },
  listWarn: { border: true, borderColor: '#E3E3E3', v: 'top', wrap: true, color: '#B91C1C' },
};

const columnKeyOf = (item) => (item.online ? 'online' : item.room_id ? `room:${item.room_id}` : 'none');

/** The lines of a block, each for its own cell: { text, kind }, kind deciding the style. */
function blockLines(item, faculties) {
  const lines = item.kind === 'event'
    ? [
        { text: item.title, kind: 'lead' },
        { text: item.faculty_ids.map((id) => faculties.get(id)?.code).filter(Boolean).join('/'), kind: 'plain' },
      ]
    : [
        { text: item.faculty_code ?? 'No faculty', kind: 'lead' },
        { text: item.session_id ? `${item.topic_code || item.subject} ${item.topic}` : 'No session', kind: 'plain' },
        { text: item.batch_name, kind: 'batch' },
      ];
  lines.push({ text: span(item), kind: 'time' });
  if (item.status === 'done') lines.push({ text: '✓ Done', kind: 'done' });
  for (const w of item.warnings) lines.push({ text: `⚠ ${w}`, kind: 'warn' });
  return lines.filter((l) => l.text);
}

/**
 * One day's columns: every room (so each day looks the same), Online, and "No room yet"
 * only when needed. Items that share a half-hour row in one room go side by side in extra
 * columns, so a clash shows instead of one class hiding another.
 */
function dayColumns(items, rooms, start) {
  const columns = [...rooms]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .map((r) => ({ key: `room:${r.id}`, label: r.capacity ? `${r.name} – ${r.capacity}` : r.name }));
  columns.push({ key: 'online', label: 'Online' });
  if (items.some((x) => !x.online && !x.room_id)) columns.push({ key: 'none', label: 'No room yet' });

  return columns.map((col) => {
    const placed = items
      .filter((x) => columnKeyOf(x) === col.key)
      .map((x) => {
        const top = Math.floor((toMinutes(x.start_time) - start) / ROW_MINUTES);
        return { item: x, top, bottom: Math.max(top, Math.ceil((toMinutes(x.end_time) - start) / ROW_MINUTES) - 1) };
      })
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
}

function weekSheet(weekStart, { classes, events, rooms, faculties, colourBy }) {
  const days = WEEK.map((weekday, i) => {
    const date = addDays(weekStart, i);
    const items = [
      ...classes.filter((c) => c.date === date && c.status !== 'cancelled').map((c) => ({ ...c, kind: 'class' })),
      ...events.filter((e) => e.date === date).map((e) => ({ ...e, kind: 'event' })),
    ];
    return { date, weekday, items };
  });

  // One set of times for the whole week, so rows line up across the days.
  let start = 7 * 60;
  let end = 21 * 60;
  for (const x of days.flatMap((d) => d.items)) {
    start = Math.min(start, Math.floor(toMinutes(x.start_time) / ROW_MINUTES) * ROW_MINUTES);
    end = Math.max(end, Math.ceil(toMinutes(x.end_time) / ROW_MINUTES) * ROW_MINUTES);
  }
  const slots = (end - start) / ROW_MINUTES;
  for (const day of days) {
    day.columns = dayColumns(day.items, rooms, start);
    day.width = day.columns.reduce((n, c) => n + c.lanes, 0);
  }

  const width = 1 + days.reduce((n, d) => n + d.width, 0) + days.length - 1;
  const rows = Array.from({ length: FIRST + slots }, () => Array(width).fill(null));
  const merges = [];
  const merge = (r1, c1, r2, c2) => { if (r1 !== r2 || c1 !== c2) merges.push(`${cellRef(r1, c1)}:${cellRef(r2, c2)}`); };
  const colWidths = [10];
  const breaks = [];

  rows[0][0] = { v: `Schedule, week of ${formatDate(weekStart)} – ${formatDate(addDays(weekStart, 6))}`, s: S.title };
  merge(0, 0, 0, Math.min(width - 1, 8));
  rows[FIRST - 1][0] = { v: 'Time', s: S.head };
  const isHalfEnd = (r) => (start + (r + 1) * ROW_MINUTES) % LABEL_MINUTES === 0;
  for (let r = 0; r < slots; r++) {
    const minute = start + r * ROW_MINUTES;
    const labelled = minute % LABEL_MINUTES === 0;
    rows[FIRST + r][0] = { v: labelled ? formatTime(toTime(minute)) : null, s: S.time };
    if (labelled && r + 1 < slots) merge(FIRST + r, 0, FIRST + r + 1, 0);
  }

  let col = 1;
  days.forEach((day, i) => {
    if (i > 0) {
      // The divider column between days.
      breaks.push(col + 1); // printing starts each day on a new page
      for (let r = 1; r < rows.length; r++) rows[r][col] = { v: null, s: S.divider };
      colWidths.push(2);
      col += 1;
    }
    const first = col;
    const last = col + day.width - 1;
    rows[1][first] = { v: `${DAY_NAMES[day.weekday]}, ${shortDate(day.date)}`, s: S.day };
    const off = [...faculties.values()].filter((f) => f.week_offs.includes(day.weekday)).map((f) => f.code).sort();
    rows[2][first] = { v: off.length ? `Week off: ${off.join(', ')}` : 'Week off: nobody', s: S.off };
    for (let c = first; c <= last; c++) {
      if (c > first) {
        rows[1][c] = { v: null, s: S.day };
        rows[2][c] = { v: null, s: S.off };
      }
      for (let r = 0; r < slots; r++) rows[FIRST + r][c] = { v: null, s: isHalfEnd(r) ? S.emptyHalf : S.empty };
      colWidths.push(26);
    }
    merge(1, first, 1, last);
    merge(2, first, 2, last);

    for (const column of day.columns) {
      for (let lane = 0; lane < column.lanes; lane++) rows[FIRST - 1][col + lane] = { v: lane ? null : column.label, s: S.head };
      merge(FIRST - 1, col, FIRST - 1, col + column.lanes - 1);
      for (const p of column.placed) {
        const x = p.item;
        const [fill, edge] = x.kind === 'event' ? EVENT_COLOURS : colourFor(colourBy === 'batch' ? x.batch_name : x.faculty_code);
        const warned = x.warnings.length > 0;
        const c = col + p.lane;
        const height = p.bottom - p.top + 1;
        const lines = blockLines(x, faculties);
        // More lines than rows (a short class): the last row holds the rest.
        const cells = lines.length > height
          ? [...lines.slice(0, height - 1), { text: lines.slice(height - 1).map((l) => l.text).join(' · '), kind: lines[height - 1].kind }]
          : lines;
        for (let r = 0; r < height; r++) {
          // One outline round the whole block, no lines between its cells.
          const sides = `lr${r === 0 ? 't' : ''}${r === height - 1 ? 'b' : ''}`;
          const kind = cells[r]?.kind;
          const style = {
            fill, border: true, sides, borderColor: warned ? '#DC2626' : edge, borderWeight: warned ? 'medium' : 'thin',
            v: 'center', h: 'left', indent: 1, shrink: true,
            bold: kind === 'lead' || kind === 'batch',
            color: kind === 'warn' ? '#B91C1C' : kind === 'time' ? '#4B5563' : kind === 'done' ? '#15803D' : '#1F2937',
          };
          rows[FIRST + p.top + r][c] = { v: cells[r]?.text ?? null, s: style };
        }
      }
      col += column.lanes;
    }
  });

  // Problems for the week, listed under the grid as on the Day grid page.
  const problems = days.flatMap((d) => d.items.filter((x) => x.warnings.length)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .map((x) => `${d.weekday} ${shortDate(d.date)}, ${formatTime(x.start_time)}  ${x.kind === 'event' ? x.title : x.batch_name}: ${x.warnings.join(' ')}`));
  if (problems.length) {
    rows.push([], [{ v: 'Needs attention', s: S.warn }]);
    for (const text of problems) rows.push([{ v: text, s: { color: '#B91C1C' } }]);
  }

  return {
    name: `Week of ${shortDate(weekStart)}`,
    rows,
    merges,
    cols: colWidths,
    rowHeights: [22, 20, 16, 30, ...Array(slots).fill(16)],
    freeze: { row: FIRST, col: 1 },
    repeatRows: FIRST,
    repeatCols: 1,
    colBreaks: breaks,
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
    landscape: true,
    fitWidth: true,
  };
}

/**
 * classes and events come from the schedule's week, each with its warnings.
 * faculties: [{ id, code, name, week_offs }], rooms: [{ id, name, capacity }].
 */
export function weekWorkbook({ weekStart, classes, events, rooms, faculties, colourBy = 'faculty' }) {
  const byId = new Map(faculties.map((f) => [f.id, f]));
  return buildXlsx([
    weekSheet(weekStart, { classes, events, rooms, faculties: byId, colourBy }),
    listSheet({ classes, events, faculties: byId }),
  ]);
}
