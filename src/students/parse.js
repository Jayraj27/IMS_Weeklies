/*
 * Turns the BRD student sheet into student records. No database or network here.
 *
 * Input is a grid of cells: { text: what the sheet displays, number: the underlying
 * numeric value, if any }. Values are kept as written. The only derived values are
 * the normalised phone numbers and ISO dates, and anything doubtful is flagged on the
 * row rather than corrected, because the sheet is the source of truth.
 */

const COLUMNS = {
  srno: 'sr_no',
  status: 'status',
  comments: 'comments',
  imsid: 'ims_id',
  name: 'first_name',
  surname: 'surname',
  emailid: 'email',
  mobilenumber: 'mobile',
  parentsguardianname: 'guardian_name',
  parentsguardiannumbers: 'guardian_mobile',
  gender: 'gender',
  dobmmddyyyy: 'dob_raw',
  dob: 'dob_raw',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  doj: 'doj_raw',
  course: 'course',
  reference: 'reference',
  currentvariant: 'variant',
  batch: 'batch',
  livebatchadded: 'live_batch_added',
  universityname: 'university',
  collegenameschoolname: 'college',
  program: 'program',
  tution: 'tuition',
  tuition: 'tuition',
  remark: 'remark',
};

const REQUIRED = { imsid: 'IMS ID', name: 'Name', status: 'Status', course: 'Course', batch: 'Batch' };

export const STUDENT_FIELDS = [...new Set(Object.values(COLUMNS))];

export class SheetFormatError extends Error {}

const headerKey = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (cell) => String(cell?.text ?? '').trim();

export function looksLikeHeader(textCells) {
  const keys = new Set(textCells.map(headerKey));
  return keys.has('imsid') && keys.has('name');
}

/* ---------- dates ---------- */

function toIso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.toISOString().slice(0, 10) : null;
}

/**
 * The sheet mixes formats, so the displayed text is what gets read:
 *   15-10-2005  dashes are day first
 *   25/05/2006  slashes with a first part over 12 are day first
 *   7/26/2006   slashes with a second part over 12 are month first
 *   8/4/2006    could be either: DOB follows its MM/DD/YYYY heading, DOJ is day first
 *               (DOJ values in the sheet run in date order only when read day first)
 *
 * The underlying date value is only a fallback. It reflects how the sheet's locale
 * interpreted what was typed, which is the very thing in doubt for 8/4/2006.
 */
export function parseDate(cell, kind) {
  const text = clean(cell);
  if (!text) return { iso: null, ambiguous: false };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return { iso: toIso(+iso[1], +iso[2], +iso[3]), ambiguous: false };

  const m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/.exec(text);
  if (m) {
    const [a, sep, b, year] = [+m[1], m[2], +m[3], +m[4]];
    if (a > 12) return { iso: toIso(year, b, a), ambiguous: false };
    if (b > 12) return { iso: toIso(year, a, b), ambiguous: false };
    if (sep !== '/' || kind === 'doj') return { iso: toIso(year, b, a), ambiguous: false };
    return { iso: toIso(year, a, b), ambiguous: a !== b };
  }

  // A real date cell displayed some other way, such as "Oct 15, 2005".
  if (typeof cell?.number === 'number' && cell.number > 1 && cell.number < 80000) {
    const date = new Date(Math.round((cell.number - 25569) * 86400000));
    return { iso: date.toISOString().slice(0, 10), ambiguous: false };
  }
  return { iso: null, ambiguous: false };
}

/* ---------- phones ---------- */

/** A 12-digit number stored in a cell can display as 9.72E+11, so the stored value is used. */
export function parsePhone(cell) {
  const text = clean(cell);
  if (!text) return { value: '', lostDigits: false };
  if (typeof cell?.number === 'number') return { value: String(Math.round(cell.number)), lostDigits: false };
  if (/\de\+?\d/i.test(text)) return { value: text, lostDigits: true };
  return { value: text.replace(/[\s()-]/g, '').replace(/^\+/, ''), lostDigits: false };
}

const isIndianMobile = (value) => /^(91)?[6-9]\d{9}$/.test(value);

/* ---------- one row ---------- */

function checkRow(row, phones, dob, doj) {
  const issues = [];
  if (!row.ims_id) issues.push('IMS ID is missing');
  else if (!/^(IMS|STU|RSTU)\d+$/i.test(row.ims_id)) issues.push('IMS ID is in an unexpected format');

  if (phones.mobile.lostDigits) issues.push('Mobile number has lost digits in the sheet');
  else if (!phones.mobile.value) issues.push('Mobile number is missing');
  else if (!isIndianMobile(phones.mobile.value)) issues.push('Mobile number is not a 10-digit Indian mobile');

  const guardianLooksWrong =
    /@/.test(row.guardian_name) || /^[\d\s+-]{7,}$/.test(row.guardian_name) || /@/.test(row.guardian_mobile);
  if (guardianLooksWrong) issues.push('Guardian name and number look wrong or swapped');
  else if (phones.guardian.lostDigits) issues.push('Guardian number has lost digits in the sheet');
  else if (phones.guardian.value && !isIndianMobile(phones.guardian.value)) {
    issues.push('Guardian number is not a 10-digit Indian mobile');
  }

  if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) issues.push('Email looks invalid');

  if (!row.dob_raw) issues.push('Date of birth is missing');
  else if (!dob.iso) issues.push('Date of birth could not be read');
  else {
    if (dob.ambiguous) issues.push('Date of birth could be day/month or month/day');
    const joined = doj.iso ?? new Date().toISOString().slice(0, 10);
    // Nobody here joined before about age 10, so this catches a form-filling date typed as DOB.
    if (+dob.iso.slice(0, 4) > +joined.slice(0, 4) - 10) issues.push('Date of birth looks too recent');
  }
  if (row.doj_raw && !doj.iso) issues.push('Date of joining could not be read');
  return issues;
}

/* ---------- whole sheet ---------- */

export function parseSheet(grid) {
  const headerIndex = grid.slice(0, 10).findIndex((cells) => looksLikeHeader(cells.map(clean)));
  if (headerIndex < 0) {
    throw new SheetFormatError('Could not find the heading row. It needs at least "IMS ID" and "Name" columns in the first 10 rows.');
  }

  const headers = grid[headerIndex].map(clean);
  const warnings = [];
  const fieldAt = new Map();
  const seen = new Set();
  headers.forEach((header, i) => {
    if (!header) return;
    const key = headerKey(header);
    if (seen.has(key)) {
      warnings.push(`Column "${header}" appears more than once. The first one is used.`);
      return;
    }
    seen.add(key);
    if (COLUMNS[key]) fieldAt.set(i, COLUMNS[key]);
    else warnings.push(`New column "${header}" is kept with each student's full record, but has no field of its own.`);
  });

  const missing = Object.entries(REQUIRED).filter(([key]) => !seen.has(key)).map(([, label]) => label);
  if (missing.length) {
    throw new SheetFormatError(`The sheet is missing required columns: ${missing.join(', ')}. Nothing was changed.`);
  }
  for (const [key, field] of Object.entries(COLUMNS)) {
    const covered = [...fieldAt.values()].includes(field);
    if (!seen.has(key) && !covered && key !== 'tuition' && key !== 'dob') warnings.push(`Expected column for "${field}" was not found.`);
  }

  const rows = [];
  grid.slice(headerIndex + 1).forEach((cells, offset) => {
    const row = Object.fromEntries(STUDENT_FIELDS.map((f) => [f, '']));
    const raw = {};
    const cellOf = {};
    cells.forEach((cell, i) => {
      const text = clean(cell);
      if (headers[i] && text && !(headers[i] in raw)) raw[headers[i]] = text;
      const field = fieldAt.get(i);
      if (field) {
        row[field] = text;
        cellOf[field] = cell;
      }
    });
    // Rows that only carry a pre-filled serial number aren't students yet.
    if (!row.ims_id && !row.first_name && !row.email && !row.mobile) return;

    const phones = { mobile: parsePhone(cellOf.mobile), guardian: parsePhone(cellOf.guardian_mobile) };
    const dob = parseDate(cellOf.dob_raw, 'dob');
    const doj = parseDate(cellOf.doj_raw, 'doj');
    const issues = checkRow(row, phones, dob, doj);

    rows.push({
      ...row,
      sheet_row: headerIndex + offset + 2,
      mobile: phones.mobile.value,
      guardian_mobile: /@/.test(row.guardian_mobile) ? row.guardian_mobile : phones.guardian.value,
      dob: dob.iso,
      doj: doj.iso,
      live_batch_added: row.live_batch_added.toUpperCase(),
      raw,
      issues,
    });
  });

  // Every row is kept. A repeated IMS ID may be a genuine second enrolment, so
  // choosing a winner is a human decision.
  const rowsById = new Map();
  for (const row of rows) {
    if (!row.ims_id) continue;
    const key = row.ims_id.toLowerCase();
    if (!rowsById.has(key)) rowsById.set(key, []);
    rowsById.get(key).push(row);
  }
  for (const same of rowsById.values()) {
    if (same.length < 2) continue;
    for (const row of same) {
      const others = same.filter((r) => r !== row).map((r) => r.sheet_row).join(', ');
      row.issues.push(`IMS ID also appears on sheet row ${others}`);
    }
  }

  return { rows, warnings, headerRow: headerIndex + 1 };
}
