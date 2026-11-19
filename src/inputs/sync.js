/*
 * Copies the Google Form's response sheet into the program. Like the student sheet, it is
 * only read, never written. Each good read replaces the form's entries; reviews are kept
 * by entry key, so an approved answer stays approved, and an answer changed in the form
 * comes back to be reviewed again.
 */

import { db, tx } from '../db.js';
import { fetchGrid, readServiceAccount, sheetIdFrom, SheetAccessError } from '../students/google.js';
import { syncIntervalMinutes } from '../students/sync.js';
import { checkEntry, looksLikeInputHeader, readResponses } from './parse.js';
import { batchLookup } from './effects.js';

const MAX_RUNS_KEPT = 100;

export function inputSheetId() {
  return sheetIdFrom(process.env.INPUT_SHEET_ID);
}

export function inputConnection() {
  const sheetId = inputSheetId();
  try {
    const key = readServiceAccount();
    return { sheetId, email: key?.client_email ?? null, ready: Boolean(sheetId && key), error: null };
  } catch (err) {
    return { sheetId, email: null, ready: false, error: err.message };
  }
}

export function lookups() {
  return {
    faculties: new Map(db.prepare('SELECT id, code FROM faculties').all().map((f) => [f.code.toLowerCase(), f])),
    batches: batchLookup(),
    rooms: new Map(db.prepare('SELECT id, name FROM rooms').all().map((r) => [r.id, r])),
  };
}

const COLUMNS = ['entry_key', 'source', 'sheet_row', 'submitted_at', 'month', 'faculty_code', 'faculty_id', 'kind', 'from_date', 'to_date', 'from_time', 'to_time', 'batch_codes', 'others', 'room_id', 'details', 'problems'];

export function insertEntry(entry) {
  return Number(db.prepare(`INSERT INTO input_entries (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`)
    .run(...COLUMNS.map((c) => (c === 'problems' ? JSON.stringify(entry.problems ?? []) : entry[c] ?? null))).lastInsertRowid);
}

/** Takes back an approval: deletes the blocks it put on the schedule. */
export function dropReview(entryKey) {
  const review = db.prepare('SELECT event_ids FROM input_reviews WHERE entry_key = ?').get(entryKey);
  if (!review) return;
  const remove = db.prepare('DELETE FROM schedule_events WHERE id = ?');
  for (const id of JSON.parse(review.event_ids)) remove.run(id);
  db.prepare('DELETE FROM input_reviews WHERE entry_key = ?').run(entryKey);
}

/** Stores the form's answers in place of the last read. */
export function replaceFormEntries(entries) {
  const found = lookups();
  tx(() => {
    db.prepare("DELETE FROM input_entries WHERE source = 'form'").run();
    for (const entry of entries) {
      const checked = checkEntry(entry, found);
      insertEntry({ ...entry, kind: entry.kind ?? `unknown:${entry.kind_text ?? ''}`, month: entry.month ?? '', faculty_id: checked.faculty_id, problems: checked.problems });
    }
    // A response deleted or edited in the sheet takes its approval, and its blocks, with it.
    const gone = db.prepare("SELECT entry_key FROM input_reviews WHERE entry_key LIKE 'form:%' AND entry_key NOT IN (SELECT entry_key FROM input_entries)").all();
    for (const { entry_key: key } of gone) dropReview(key);
  });
}

function recordRun(run) {
  db.prepare('INSERT INTO input_sync_runs (started_at, finished_at, ok, error, tab, row_count) VALUES (?, ?, ?, ?, ?, ?)')
    .run(run.started_at, new Date().toISOString(), run.ok ? 1 : 0, run.error ?? null, run.tab ?? null, run.row_count ?? null);
  db.prepare('DELETE FROM input_sync_runs WHERE id NOT IN (SELECT id FROM input_sync_runs ORDER BY id DESC LIMIT ?)').run(MAX_RUNS_KEPT);
}

async function sync() {
  const run = { started_at: new Date().toISOString(), ok: false };
  try {
    const { tab, grid } = await fetchGrid({
      sheetId: inputSheetId(),
      wanted: process.env.INPUT_SHEET_TAB?.trim(),
      looksRight: (row) => looksLikeInputHeader(row),
      what: '"Faculty Code" and "What is it?" headings',
      tabSetting: 'INPUT_SHEET_TAB',
    });
    run.tab = tab;
    const { entries, error } = readResponses(grid);
    if (error) run.error = error;
    else {
      replaceFormEntries(entries);
      run.ok = true;
      run.row_count = entries.length;
    }
  } catch (err) {
    if (err instanceof SheetAccessError) run.error = err.message;
    else if (err.name === 'TimeoutError' || err.name === 'TypeError') run.error = "Couldn't reach Google. Check the internet connection. The next read will try again.";
    else {
      run.error = 'Reading the form responses failed unexpectedly. See the server log.';
      console.error('Input sync error:', err);
    }
  }
  recordRun(run);
  if (!run.ok) console.error(`Faculty input sync failed: ${run.error}`);
  return run;
}

let running = null;

export function runInputSync() {
  if (!running) running = sync().finally(() => { running = null; });
  return running;
}

export function inputSyncStatus() {
  const conn = inputConnection();
  const parse = (r) => r && { ...r, ok: Boolean(r.ok) };
  return {
    configured: conn.ready,
    config_error: conn.error,
    service_account_email: conn.email,
    form_url: process.env.INPUT_FORM_URL?.trim() || null,
    running: Boolean(running),
    last_run: parse(db.prepare('SELECT * FROM input_sync_runs ORDER BY id DESC LIMIT 1').get()) ?? null,
    last_success: parse(db.prepare('SELECT * FROM input_sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get()) ?? null,
  };
}

export function startInputSyncSchedule() {
  if (!inputConnection().ready) return;
  const tick = async () => {
    await runInputSync();
    setTimeout(tick, syncIntervalMinutes() * 60_000).unref();
  };
  tick();
}
