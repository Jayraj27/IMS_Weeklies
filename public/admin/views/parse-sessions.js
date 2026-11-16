/*
 * Reads a master flow pasted from a spreadsheet or loaded from a CSV file. Columns are
 * found by heading, so the summary rows above the headings and any blank columns are
 * ignored. Needs headings for Topic and Subject; Topic Code, Area and Homework link are
 * optional.
 */

const COLUMNS = {
  topiccode: 'topic_code',
  code: 'topic_code',
  topic: 'topic',
  area: 'area',
  subject: 'subject',
  suject: 'subject',
  homeworklink: 'homework',
  homework: 'homework',
  no: 'no',
  sno: 'no',
  srno: 'no',
};

/** Splits text into rows and cells, keeping quoted cells whole, including line breaks. */
export function splitCells(text, separator) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === separator) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const headingKey = (text) => text.toLowerCase().replace(/[^a-z]/g, '');

export function parseSessions(text) {
  const separator = text.includes('\t') ? '\t' : ',';
  const rows = splitCells(text, separator).map((r) => r.map((c) => c.trim().replace(/\s+/g, ' ')));

  const headerIndex = rows.findIndex((r) => {
    const fields = r.map((c) => COLUMNS[headingKey(c)]);
    return fields.includes('topic') && fields.includes('subject');
  });
  if (headerIndex < 0) {
    const problems = text.trim() ? ['Include the heading row, with at least Topic and Subject columns.'] : [];
    return { sessions: [], problems, notes: [] };
  }

  const fieldAt = rows[headerIndex].map((c) => COLUMNS[headingKey(c)]);
  const sessions = [];
  const problems = [];
  const notes = [];

  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (!cells.some(Boolean)) return;
    const line = headerIndex + offset + 2;
    const session = { topic_code: '', topic: '', area: '', subject: '', homework: '' };
    let no = '';
    cells.forEach((value, i) => {
      if (fieldAt[i] === 'no') no = value;
      else if (fieldAt[i]) session[fieldAt[i]] = value;
    });
    if (!session.topic || !session.subject) {
      problems.push(`Line ${line}: needs both a topic and a subject.`);
      return;
    }
    sessions.push(session);
    if (no && Number(no) !== sessions.length) {
      notes.push(`Line ${line} is numbered ${no} but is session ${sessions.length} in this order.`);
    }
  });
  return { sessions, problems, notes };
}
