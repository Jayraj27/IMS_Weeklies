/*
 * A small .xlsx writer: enough for the schedule export (text, styles, merged cells,
 * frozen panes, filters, print setup) without a dependency. The file opens in Excel,
 * LibreOffice and Google Sheets.
 *
 * buildXlsx([{ name, rows, merges, cols, rowHeights, freeze, filter, repeatRows, repeatCols, landscape, fitWidth, colBreaks }])
 *   rows:   arrays of cells; a cell is text, a number, null, or { v, s } with a style
 *   style:  { bold, size, color, fill, wrap, h, v, border, borderColor, borderWeight }
 *   merges: ['B4:B7', ...]
 */

import zlib from 'node:zlib';

export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export const cellRef = (row, col) => `${columnName(col)}${row + 1}`;

// Characters XML can't hold at all are dropped; the rest are escaped.
const xml = (text) => String(text)
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;

/** Collects the distinct styles used, so styles.xml lists each once. */
function styleBook() {
  const fonts = ['<font><sz val="10"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const seen = new Map([['{}', 0]]);
  const indexOf = (list, item) => {
    const at = list.indexOf(item);
    return at >= 0 ? at : list.push(item) - 1;
  };

  function id(style) {
    if (!style) return 0;
    const key = JSON.stringify(style, Object.keys(style).sort());
    if (seen.has(key)) return seen.get(key);
    const font = `<font>${style.bold ? '<b/>' : ''}${style.italic ? '<i/>' : ''}<sz val="${style.size ?? 10}"/>${style.color ? `<color rgb="${argb(style.color)}"/>` : ''}<name val="Calibri"/></font>`;
    const fill = style.fill
      ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(style.fill)}"/><bgColor indexed="64"/></patternFill></fill>`
      : fills[0];
    const side = (name) => (style.border
      ? `<${name} style="${style.borderWeight ?? 'thin'}"><color rgb="${argb(style.borderColor ?? '#BFBFBF')}"/></${name}>`
      : `<${name}/>`);
    const border = `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
    const align = style.wrap || style.h || style.v
      ? `<alignment${style.h ? ` horizontal="${style.h}"` : ''}${style.v ? ` vertical="${style.v}"` : ''}${style.wrap ? ' wrapText="1"' : ''}/>`
      : '';
    const xf = `<xf numFmtId="0" fontId="${indexOf(fonts, font)}" fillId="${indexOf(fills, fill)}" borderId="${indexOf(borders, border)}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
    const at = xfs.push(xf) - 1;
    seen.set(key, at);
    return at;
  }

  const toXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  return { id, toXml };
}

function sheetXml(sheet, styles) {
  const rows = sheet.rows ?? [];
  const width = Math.max(1, ...rows.map((r) => r.length));
  const rowXml = rows.map((cells, r) => {
    const height = sheet.rowHeights?.[r];
    const body = cells.map((cell, c) => {
      if (cell == null) return '';
      const { v, s } = typeof cell === 'object' ? cell : { v: cell };
      const style = styles.id(s);
      const attrs = `r="${cellRef(r, c)}"${style ? ` s="${style}"` : ''}`;
      if (v == null || v === '') return `<c ${attrs}/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c ${attrs}><v>${v}</v></c>`;
      return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}"${height ? ` ht="${height}" customHeight="1"` : ''}>${body}</row>`;
  }).join('');

  const freeze = sheet.freeze
    ? `<pane${sheet.freeze.col ? ` xSplit="${sheet.freeze.col}"` : ''}${sheet.freeze.row ? ` ySplit="${sheet.freeze.row}"` : ''} topLeftCell="${cellRef(sheet.freeze.row ?? 0, sheet.freeze.col ?? 0)}" activePane="bottomRight" state="frozen"/>`
    : '';
  const cols = sheet.cols?.length
    ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  // A page break after each listed column number, e.g. so each day prints on its own pages.
  const colBreaks = sheet.colBreaks?.length
    ? `<colBreaks count="${sheet.colBreaks.length}" manualBreakCount="${sheet.colBreaks.length}">${sheet.colBreaks.map((n) => `<brk id="${n}" max="1048575" man="1"/>`).join('')}</colBreaks>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${sheet.fitWidth ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}<dimension ref="A1:${cellRef(Math.max(0, rows.length - 1), width - 1)}"/>
<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml}</sheetData>${sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : ''}${merges}
<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>${sheet.landscape ? `<pageSetup orientation="landscape"${sheet.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : ''}/>` : ''}${colBreaks}
</worksheet>`;
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ], and no two alike. */
function safeNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = String(raw).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsx(sheets) {
  const styles = styleBook();
  const names = safeNames(sheets.map((s) => s.name));
  const files = sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, styles)]);
  const quoted = (i) => `'${xml(names[i]).replace(/'/g, "''")}'`;
  const filterNames = sheets.map((s, i) => [
    s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${quoted(i)}!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '',
    // Columns and rows printed again on every page, e.g. the times and the room names.
    s.repeatRows || s.repeatCols
      ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${[
          s.repeatCols ? `${quoted(i)}!$A:$${columnName(s.repeatCols - 1)}` : '',
          s.repeatRows ? `${quoted(i)}!$1:$${s.repeatRows}` : '',
        ].filter(Boolean).join(',')}</definedName>`
      : '',
  ].join('')).join('');

  files.push(
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${filterNames ? `<definedNames>${filterNames}</definedNames>` : ''}
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', styles.toXml()],
  );
  return zip(files);
}

/** A plain zip archive, each file deflated. */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBytes, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
