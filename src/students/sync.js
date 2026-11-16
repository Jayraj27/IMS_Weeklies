/*
 * Copies the student sheet into the local database. The sheet is the source of truth:
 * nothing is ever written back, and each good read replaces the local copy in one
 * transaction. A bad read leaves the previous copy in place.
 */

import { db, tx } from '../db.js';
import { fetchStudentGrid, readServiceAccount, sheetIdFrom, SheetAccessError } from './google.js';
import { reconcileStudentLinks } from './link.js';
import { parseSheet, SheetFormatError, STUDENT_FIELDS } from './parse.js';

const MAX_RUNS_KEPT = 200;
const COLUMNS = ['sheet_row', ...STUDENT_FIELDS, 'dob', 'doj', 'raw', 'issues'];

export function syncIntervalMinutes() {
  const minutes = Number(process.env.SHEET_SYNC_MINUTES);
  return Number.isFinite(minutes) && minutes >= 1 ? minutes : 5;
}

function connection() {
  const sheetId = sheetIdFrom(process.env.GOOGLE_SHEET_ID);
  try {
    const key = readServiceAccount();
    return { sheetId, email: key?.client_email ?? null, ready: Boolean(sheetId && key), error: null };
  } catch (err) {
    return { sheetId, email: null, ready: false, error: err.message };
  }
}

/** Identity for spotting changes between syncs, allowing for repeated IMS IDs. */
function keyedRows(rows) {
  const counts = new Map();
  const map = new Map();
  for (const { ims_id: id, sheet_row: sheetRow, raw } of rows) {
    const base = id ? id.toLowerCase() : `row:${sheetRow}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    map.set(`${base}#${n}`, typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
  return map;
}

function compare(previous, next) {
  const before = keyedRows(previous);
  const after = keyedRows(next);
  let added = 0;
  let updated = 0;
  for (const [key, raw] of after) {
    if (!before.has(key)) added += 1;
    else if (before.get(key) !== raw) updated += 1;
  }
  let removed = 0;
  for (const key of before.keys()) if (!after.has(key)) removed += 1;
  return { added, updated, removed };
}

function replaceStudents(rows) {
  db.exec('DELETE FROM students');
  const insert = db.prepare(
    `INSERT INTO students (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    insert.run(
      ...COLUMNS.map((column) => {
        if (column === 'raw' || column === 'issues') return JSON.stringify(row[column]);
        return row[column] ?? null;
      }),
    );
  }
}

function recordRun(run) {
  db.prepare(
    `INSERT INTO student_sync_runs
       (started_at, finished_at, trigger, ok, error, error_code, tab, row_count, added, updated, removed, issue_rows, warnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.started_at, new Date().toISOString(), run.trigger, run.ok ? 1 : 0, run.error ?? null, run.error_code ?? null,
    run.tab ?? null, run.row_count ?? null, run.added ?? null, run.updated ?? null, run.removed ?? null,
    run.issue_rows ?? null, JSON.stringify(run.warnings ?? []),
  );
  db.prepare(
    'DELETE FROM student_sync_runs WHERE id NOT IN (SELECT id FROM student_sync_runs ORDER BY id DESC LIMIT ?)',
  ).run(MAX_RUNS_KEPT);
}

async function sync(trigger, allowShrink) {
  const run = { started_at: new Date().toISOString(), trigger, ok: false };
  try {
    const { tab, grid } = await fetchStudentGrid();
    run.tab = tab;
    const { rows, warnings } = parseSheet(grid);
    run.warnings = warnings;

    const previous = db.prepare('SELECT ims_id, sheet_row, raw FROM students').all();
    if (!rows.length) {
      run.error = 'The sheet returned no students, so the existing copy was kept.';
      run.error_code = 'empty';
    } else if (!allowShrink && previous.length >= 20 && rows.length < previous.length / 2) {
      // Protects against a half-deleted or accidentally filtered sheet wiping the copy.
      run.error = `The sheet now has ${rows.length} students, down from ${previous.length}. The existing copy was kept until someone confirms this is right.`;
      run.error_code = 'shrink';
    } else {
      Object.assign(run, compare(previous, rows));
      tx(() => {
        replaceStudents(rows);
        reconcileStudentLinks();
      });
      run.ok = true;
      run.row_count = rows.length;
      run.issue_rows = rows.filter((r) => r.issues.length).length;
    }
  } catch (err) {
    if (err instanceof SheetAccessError || err instanceof SheetFormatError) {
      run.error = err.message;
    } else if (err.name === 'TimeoutError' || err.name === 'TypeError') {
      run.error = "Couldn't reach Google. Check the internet connection. The next sync will try again.";
      console.error('Student sync network error:', err.message);
    } else {
      run.error = 'The sync failed unexpectedly. See the server log.';
      console.error('Student sync error:', err);
    }
  }
  recordRun(run);
  if (!run.ok) console.error(`Student sync failed: ${run.error}`);
  return run;
}

let running = null;

export function runSync({ trigger = 'manual', allowShrink = false } = {}) {
  if (!running) running = sync(trigger, allowShrink).finally(() => { running = null; });
  return running;
}

const parseRun = (row) => row && { ...row, ok: Boolean(row.ok), warnings: JSON.parse(row.warnings || '[]') };

export function syncStatus() {
  const conn = connection();
  const runs = db.prepare('SELECT * FROM student_sync_runs ORDER BY id DESC LIMIT 10').all().map(parseRun);
  const lastSuccess = parseRun(db.prepare('SELECT * FROM student_sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get());
  return {
    configured: conn.ready,
    config_error: conn.error,
    sheet_id: conn.sheetId || null,
    service_account_email: conn.email,
    interval_minutes: syncIntervalMinutes(),
    running: Boolean(running),
    last_run: runs[0] ?? null,
    last_success: lastSuccess ?? null,
    runs,
  };
}

export function startSyncSchedule() {
  if (!connection().ready) {
    console.log('Student sheet sync is not set up yet. See "Connect the student sheet" in README.md.');
    return;
  }
  const tick = async () => {
    await runSync({ trigger: 'schedule' });
    setTimeout(tick, syncIntervalMinutes() * 60_000).unref();
  };
  tick();
}
