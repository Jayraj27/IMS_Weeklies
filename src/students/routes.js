import express from 'express';
import { db } from '../db.js';
import { runSync, syncStatus } from './sync.js';

export const studentsRouter = express.Router();

const PAGE_SIZE = 50;
const likeEscape = (text) => text.replace(/[\\%_]/g, '\\$&');

function facet(column) {
  return db
    .prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM students WHERE ${column} <> '' GROUP BY ${column} ORDER BY ${column}`)
    .all();
}

function courseFacet() {
  const rows = db.prepare(`
    SELECT s.course_id AS value, c.name AS label, COUNT(*) AS count
    FROM students s LEFT JOIN courses c ON c.id = s.course_id
    GROUP BY s.course_id ORDER BY c.name IS NULL, c.name`).all();
  return rows.map((r) => (r.value == null ? { value: 'none', label: 'No matching course', count: r.count } : { ...r, value: String(r.value) }));
}

studentsRouter.get('/', (req, res) => {
  const where = [];
  const params = [];

  const q = String(req.query.q ?? '').trim();
  if (q) {
    const like = `%${likeEscape(q)}%`;
    const fields = ["first_name || ' ' || surname", 'ims_id', 'email', 'mobile', 'guardian_mobile', 'batch'];
    where.push(`(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...fields.map(() => like));
  }
  for (const column of ['status', 'batch']) {
    const value = req.query[column];
    if (typeof value === 'string' && value) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (req.query.course === 'none') where.push('course_id IS NULL');
  else if (req.query.course) {
    where.push('course_id = ?');
    params.push(Number(req.query.course));
  }
  if (req.query.issues === '1') where.push("issues <> '[]'");

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM students ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = Number.parseInt(req.query.page, 10);
  const page = Math.min(pages, Number.isInteger(requested) && requested > 0 ? requested : 1);

  const rows = db
    .prepare(`SELECT *, (SELECT name FROM courses c WHERE c.id = students.course_id) AS course_name
              FROM students ${clause} ORDER BY sheet_row LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .map((row) => ({ ...row, raw: JSON.parse(row.raw), issues: JSON.parse(row.issues) }));

  res.json({
    rows,
    total,
    page,
    pages,
    facets: { status: facet('status'), course: courseFacet(), batch: facet('batch') },
    issue_total: db.prepare("SELECT COUNT(*) AS n FROM students WHERE issues <> '[]'").get().n,
  });
});

studentsRouter.get('/sync', (_req, res) => res.json(syncStatus()));

studentsRouter.post('/sync', async (req, res) => {
  const run = await runSync({ trigger: 'manual', allowShrink: req.body?.allow_shrink === true });
  res.json({ run, status: syncStatus() });
});
