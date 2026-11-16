/*
 * Connects the student copy to the admin data: each student gets a course from their
 * Current Variant, and each batch code in the sheet gets an admin batch.
 *
 * Run this inside a transaction whenever students, courses or batches change. Batches
 * are never deleted here, because they may hold faculty assignments.
 */

import { db } from '../db.js';
import { normalizeCode, variantKey, yearFromCode, yearFromVariant } from './variants.js';

const ACTIVE = "LOWER(TRIM(status)) = 'active'";

function copyCourseSlots(batchId, courseId) {
  const roles = db.prepare('SELECT * FROM course_roles WHERE course_id = ? ORDER BY position').all(courseId);
  const insert = db.prepare('INSERT INTO batch_assignments (batch_id, position, role, subject) VALUES (?, ?, ?, ?)');
  roles.forEach((r, position) => insert.run(batchId, position, r.name, r.subject));
}

/** The course most active students are in, or null if none or a tie. */
function majorityCourse(counts) {
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] === ranked[1]?.[1]) return null;
  return ranked[0][0];
}

function chooseYear(code, variantCounts) {
  const fromCode = yearFromCode(code);
  if (fromCode) return fromCode;
  const common = [...variantCounts].sort((a, b) => b[1] - a[1]);
  for (const [variant] of common) {
    const year = yearFromVariant(variant);
    if (year) return year;
  }
  return new Date().getFullYear();
}

// A variant ticked into the wrong course shouldn't leave a batch stuck in the wrong course. Once work has been
// done on the batch, moving it could lose that work, so it's reported instead.
function canMove(batch) {
  if (batch.source !== 'sheet') return false;
  const filled = db.prepare('SELECT COUNT(*) AS n FROM batch_assignments WHERE batch_id = ? AND faculty_id IS NOT NULL').get(batch.id).n;
  const subs = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_assignment_substitutes s
    JOIN batch_assignments a ON a.id = s.assignment_id WHERE a.batch_id = ?`).get(batch.id).n;
  const inFlow = db.prepare('SELECT COUNT(*) AS n FROM flow_batches WHERE batch_id = ?').get(batch.id).n;
  return !filled && !subs && !inFlow;
}

export function reconcileStudentLinks() {
  const courseOf = new Map(db.prepare('SELECT variant_key, course_id FROM variant_courses').all()
    .map((r) => [r.variant_key, r.course_id]));

  db.exec('UPDATE students SET course_id = NULL, batch_id = NULL');
  const setCourse = db.prepare('UPDATE students SET course_id = ? WHERE variant = ?');
  for (const { variant } of db.prepare("SELECT DISTINCT variant FROM students WHERE variant <> ''").all()) {
    const courseId = courseOf.get(variantKey(variant));
    if (courseId) setCourse.run(courseId, variant);
  }

  const groups = new Map();
  const rows = db.prepare(`
    SELECT batch, course_id, variant, COUNT(*) AS n, SUM(${ACTIVE}) AS active
    FROM students WHERE batch <> '' GROUP BY batch, course_id, variant`).all();
  for (const row of rows) {
    const key = normalizeCode(row.batch);
    if (!groups.has(key)) groups.set(key, { spellings: new Map(), courses: new Map(), variants: new Map(), active: 0 });
    const group = groups.get(key);
    group.spellings.set(row.batch, (group.spellings.get(row.batch) ?? 0) + row.n);
    group.active += row.active;
    if (row.active) {
      group.variants.set(row.variant, (group.variants.get(row.variant) ?? 0) + row.active);
      if (row.course_id) group.courses.set(row.course_id, (group.courses.get(row.course_id) ?? 0) + row.active);
    }
  }

  const existing = new Map();
  for (const batch of db.prepare('SELECT * FROM batches ORDER BY id').all()) {
    const key = normalizeCode(batch.name);
    if (!existing.has(key)) existing.set(key, batch);
  }

  const addBatch = db.prepare("INSERT INTO batches (course_id, year, name, source) VALUES (?, ?, ?, 'sheet')");
  const setBatchCourse = db.prepare('UPDATE batches SET course_id = ? WHERE id = ?');
  const clearSlots = db.prepare('DELETE FROM batch_assignments WHERE batch_id = ?');
  const setStudentBatch = db.prepare('UPDATE students SET batch_id = ? WHERE batch = ?');

  for (const [key, group] of groups) {
    let batch = existing.get(key);
    const courseId = majorityCourse(group.courses);

    if (!batch && group.active && courseId) {
      const code = [...group.spellings].sort((a, b) => b[1] - a[1])[0][0];
      const id = Number(addBatch.run(courseId, chooseYear(code, group.variants), code).lastInsertRowid);
      copyCourseSlots(id, courseId);
      batch = { id };
    } else if (batch && courseId && courseId !== batch.course_id && canMove(batch)) {
      setBatchCourse.run(courseId, batch.id);
      clearSlots.run(batch.id);
      copyCourseSlots(batch.id, courseId);
    }
    if (batch) for (const spelling of group.spellings.keys()) setStudentBatch.run(batch.id, spelling);
  }
}

/** What the admin pages show: how variants matched, and anything left to resolve. */
export function linkReport() {
  const all = (sql) => db.prepare(sql).all();
  return {
    variants: all(`
      SELECT variant, course_id, COUNT(*) AS count, SUM(${ACTIVE}) AS active
      FROM students WHERE variant <> '' GROUP BY variant, course_id ORDER BY variant`),
    waiting: all(`
      SELECT batch AS code, SUM(${ACTIVE}) AS active, GROUP_CONCAT(DISTINCT variant) AS variants
      FROM students WHERE batch <> '' AND batch_id IS NULL
      GROUP BY batch HAVING active > 0 ORDER BY batch`),
    mismatched: all(`
      SELECT b.id AS batch_id, b.name AS code, COUNT(*) AS students, GROUP_CONCAT(DISTINCT s.variant) AS variants
      FROM students s JOIN batches b ON b.id = s.batch_id
      WHERE ${ACTIVE.replace('status', 's.status')} AND s.course_id IS NOT b.course_id
      GROUP BY b.id ORDER BY b.name`),
    counts: all(`SELECT batch_id, COUNT(*) AS total, SUM(${ACTIVE}) AS active FROM students WHERE batch_id IS NOT NULL GROUP BY batch_id`),
    batch_variants: all(`
      SELECT batch_id, GROUP_CONCAT(DISTINCT variant) AS variants FROM students
      WHERE batch_id IS NOT NULL AND variant <> '' AND ${ACTIVE} GROUP BY batch_id`),
  };
}

export function activeStudentCount(batchId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM students WHERE batch_id = ? AND ${ACTIVE}`).get(batchId).n;
}
