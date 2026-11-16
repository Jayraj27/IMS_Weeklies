import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'weeklies.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const SCHEMA = `
CREATE TABLE courses (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

-- The faculty slots every new batch of a course starts with (Mentor, QA1, VRC1...).
CREATE TABLE course_roles (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL COLLATE NOCASE,
  subject   TEXT COLLATE NOCASE,
  UNIQUE (course_id, name)
);

CREATE TABLE faculties (
  id   INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL
);

CREATE TABLE faculty_courses (
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  PRIMARY KEY (faculty_id, course_id)
);

CREATE TABLE faculty_subjects (
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (faculty_id, subject)
);

CREATE TABLE faculty_week_offs (
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  day        TEXT NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  PRIMARY KEY (faculty_id, day)
);

CREATE TABLE batches (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  year      INTEGER NOT NULL,
  name      TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (course_id, year, name)
);

-- A batch's own copy of its slots, so the admin can vary them batch by batch.
CREATE TABLE batch_assignments (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  role       TEXT NOT NULL COLLATE NOCASE,
  subject    TEXT COLLATE NOCASE,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  UNIQUE (batch_id, role)
);

CREATE TABLE flows (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  name      TEXT NOT NULL COLLATE NOCASE,
  scope     TEXT NOT NULL CHECK (scope IN ('course','batches')),
  UNIQUE (course_id, name)
);

-- One course-wide flow per course. A batch group's flow overrides it.
CREATE UNIQUE INDEX one_course_wide_flow ON flows(course_id) WHERE scope = 'course';

CREATE TABLE flow_batches (
  flow_id  INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL UNIQUE REFERENCES batches(id) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, batch_id)
);

CREATE TABLE flow_sessions (
  id           INTEGER PRIMARY KEY,
  flow_id      INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  subject      TEXT NOT NULL COLLATE NOCASE,
  topic        TEXT NOT NULL,
  duration_min INTEGER
);

CREATE TABLE rooms (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  capacity INTEGER,
  location TEXT
);
`;

function seed() {
  const addCourse = db.prepare('INSERT INTO courses (name) VALUES (?)');
  const addRole = db.prepare(
    'INSERT INTO course_roles (course_id, position, name, subject) VALUES (?, ?, ?, ?)',
  );
  const catRoles = [
    ['Mentor', null],
    ['QA1', 'Quant'],
    ['QA2', 'Quant'],
    ['QA3', 'Quant'],
    ['VRC1', 'Verbal'],
    ['VRC2', 'Verbal'],
    ['DILR', 'DILR'],
  ];
  for (const course of ['CAT', 'CLAT', 'CMAT', 'IPMAT', 'MSU BBA']) {
    const id = addCourse.run(course).lastInsertRowid;
    const roles = course === 'CAT' ? catRoles : [['Mentor', null]];
    roles.forEach(([name, subject], i) => addRole.run(id, i, name, subject));
  }
}

// A read-only copy of the BRD student sheet. One row per sheet row, so nothing in
// the sheet is lost, including an IMS ID that appears twice.
const STUDENTS_SCHEMA = `
CREATE TABLE students (
  sheet_row INTEGER PRIMARY KEY,
  sr_no TEXT, status TEXT, comments TEXT,
  ims_id TEXT COLLATE NOCASE,
  first_name TEXT, surname TEXT, email TEXT, mobile TEXT,
  guardian_name TEXT, guardian_mobile TEXT, gender TEXT,
  dob_raw TEXT, dob TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT,
  doj_raw TEXT, doj TEXT,
  course TEXT, reference TEXT, variant TEXT, batch TEXT, live_batch_added TEXT,
  university TEXT, college TEXT, program TEXT, tuition TEXT, remark TEXT,
  raw TEXT NOT NULL,
  issues TEXT NOT NULL
);
CREATE INDEX students_ims_id ON students(ims_id);
CREATE INDEX students_batch ON students(batch);
CREATE INDEX students_course ON students(course);
CREATE INDEX students_status ON students(status);

CREATE TABLE student_sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  error_code TEXT,
  tab TEXT,
  row_count INTEGER,
  added INTEGER,
  updated INTEGER,
  removed INTEGER,
  issue_rows INTEGER,
  warnings TEXT
);
`;

// user_version records which setup steps a database has had. It also stops a course
// the admin deleted from coming back on the next restart.
const version = () => db.prepare('PRAGMA user_version').get().user_version;

if (version() < 1) {
  tx(() => {
    db.exec(SCHEMA);
    seed();
    db.exec('PRAGMA user_version = 1');
  });
}
if (version() < 2) {
  tx(() => {
    db.exec(STUDENTS_SCHEMA);
    db.exec('PRAGMA user_version = 2');
  });
}
if (version() < 3) {
  tx(() => {
    db.exec(`
      ALTER TABLE courses ADD COLUMN variant_keywords TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE batches ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE students ADD COLUMN course_id INTEGER;
      ALTER TABLE students ADD COLUMN batch_id INTEGER;
      CREATE INDEX students_course_id ON students(course_id);
      CREATE INDEX students_batch_id ON students(batch_id);
    `);
    db.exec('PRAGMA user_version = 3');
  });
}
if (version() < 4) {
  tx(() => {
    db.exec(`
      ALTER TABLE flow_sessions ADD COLUMN topic_code TEXT NOT NULL DEFAULT '';
      ALTER TABLE flow_sessions ADD COLUMN area TEXT NOT NULL DEFAULT '';
      ALTER TABLE flow_sessions ADD COLUMN homework TEXT NOT NULL DEFAULT '';
      ALTER TABLE flow_sessions DROP COLUMN duration_min;

      -- Which sessions of its flow each batch has finished. A set rather than one
      -- position, because each subject moves at its own pace.
      CREATE TABLE batch_session_progress (
        batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES flow_sessions(id) ON DELETE CASCADE,
        marked_at  TEXT NOT NULL,
        PRIMARY KEY (batch_id, session_id)
      );
      CREATE INDEX progress_session ON batch_session_progress(session_id);
    `);
    db.exec('PRAGMA user_version = 4');
  });
}
if (version() < 5) {
  tx(() => {
    db.exec(`
      CREATE TABLE faculty_topics (
        faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
        topic      TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (faculty_id, topic)
      );

      -- Who covers a slot if its primary faculty can't, in order of preference.
      CREATE TABLE batch_assignment_substitutes (
        assignment_id INTEGER NOT NULL REFERENCES batch_assignments(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        faculty_id    INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
        PRIMARY KEY (assignment_id, faculty_id)
      );

      CREATE TABLE batch_timings (
        id         INTEGER PRIMARY KEY,
        batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        weekday    TEXT NOT NULL CHECK (weekday IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        CHECK (start_time < end_time)
      );
      CREATE INDEX batch_timings_batch ON batch_timings(batch_id);

      ALTER TABLE batches ADD COLUMN start_date TEXT;
      ALTER TABLE batches ADD COLUMN end_date TEXT;
    `);
    db.exec('PRAGMA user_version = 5');
  });
}
if (version() < 6) {
  tx(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
    `);
    db.exec('PRAGMA user_version = 6');
  });
}
if (version() < 7) {
  tx(() => {
    db.exec(`
      -- Which course each Current Variant belongs to, ticked by the admin. The old
      -- courses.variant_keywords column is no longer used.
      CREATE TABLE variant_courses (
        variant_key TEXT PRIMARY KEY,
        variant     TEXT NOT NULL,
        course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE
      );
    `);
    db.exec('PRAGMA user_version = 7');
  });
}
if (version() < 8) {
  tx(() => {
    db.exec(`
      -- One class of one batch on one date. "edited" means someone changed its session or
      -- faculty by hand, so regenerating the week would overwrite their choice.
      CREATE TABLE schedule_classes (
        id         INTEGER PRIMARY KEY,
        batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        session_id INTEGER REFERENCES flow_sessions(id) ON DELETE SET NULL,
        faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
        status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','cancelled')),
        edited     INTEGER NOT NULL DEFAULT 0,
        note       TEXT,
        flags      TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX schedule_classes_date ON schedule_classes(date);
      CREATE INDEX schedule_classes_batch ON schedule_classes(batch_id, date);
    `);
    db.exec('PRAGMA user_version = 8');
  });
}
