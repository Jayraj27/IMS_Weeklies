/*
 * Reads the cells of an .xlsx file as text, enough for uploads filled in Excel, LibreOffice
 * or Google Sheets. Formulas give their last saved value; numbers come back as written
 * in the file (a time typed into a time-formatted cell is a fraction of a day).
 */

import { unzip } from './unzip.js';

const decode = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

// Rich text splits a cell into runs; phonetic hints (<rPh>) are not part of the value.
const textOf = (xml) => decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function columnIndex(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** [{ name, rows: [[text, ...], ...] }] for every sheet, in workbook order. */
export function readXlsx(buffer) {
  let files;
  try {
    files = unzip(buffer);
  } catch {
    throw new Error('That file is not a readable .xlsx spreadsheet.');
  }
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('That file is not a readable .xlsx spreadsheet.');

  const strings = [...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const targets = new Map([...(files['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [
    /Id="([^"]+)"/.exec(m[1])?.[1],
    /Target="([^"]+)"/.exec(m[1])?.[1],
  ]));

  return [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const name = decode(/name="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const target = targets.get(/r:id="([^"]+)"/.exec(m[1])?.[1]) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = files[path] ?? '';
    const rows = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const index = Number(/\br="(\d+)"/.exec(row[1])?.[1] ?? rows.length + 1) - 1;
      const cells = [];
      for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cell[1])?.[1];
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const body = cell[2] ?? '';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw != null) value = decode(raw);
        cells[ref ? columnIndex(ref) : cells.length] = value;
      }
      rows[index] = Array.from(cells, (c) => c ?? '');
    }
    return { name, rows: Array.from(rows, (r) => r ?? []) };
  });
}
