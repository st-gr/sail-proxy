// Builds small .pptx/.xlsx files in memory for the OOXML reader's tests: a minimal zip writer
// (stored or deflated entries, sizes that can be made to lie) and the few XML parts each format
// needs. Nothing is written to disk.
import * as zlib from 'zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Deflate (default) or store. */
  store?: boolean;
  /** Override the uncompressed size written in the central directory (a lying archive). */
  declaredSize?: number;
  /** General-purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Compression method (default 8 deflate, 0 stored). */
  method?: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const method = e.method ?? (e.store ? 0 : 8);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function rels(list: Array<{ id: string; type: string; target: string; external?: boolean }>): string {
  return `${XML_DECL}<Relationships xmlns="${REL_NS}">${list.map((r) =>
    `<Relationship Id="${r.id}" Type="${REL_TYPE}/${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}

const paras = (lines: string[]): string =>
  lines.map((l) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('');

export type Shape =
  | { title: string | string[] }
  | { text: string[]; placeholder?: string }
  | { table: string[][] }
  | { group: Shape[] };

function shapeXml(s: Shape, id: number): string {
  if ('title' in s) {
    const lines = Array.isArray(s.title) ? s.title : [s.title];
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
      + `<p:spPr/><p:txBody><a:bodyPr/>${paras(lines)}</p:txBody></p:sp>`;
  }
  if ('text' in s) {
    const ph = s.placeholder ? `<p:ph type="${s.placeholder}" idx="1"/>` : '';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
      + `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${paras(s.text)}</p:txBody></p:sp>`;
  }
  if ('table' in s) {
    const rows = s.table.map((r) => `<a:tr h="1">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${paras(c.split('\n'))}</a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`).join('');
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
      + `<p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid/>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  }
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
    + `${s.group.map((g, i) => shapeXml(g, id * 10 + i)).join('')}</p:grpSp>`;
}

export interface SlideSpec {
  shapes: Shape[];
  notes?: string[];
  hidden?: boolean;
}

export function slideXml(spec: SlideSpec): string {
  return `${XML_DECL}<p:sld ${NS_P}${spec.hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
    + `${spec.shapes.map((s, i) => shapeXml(s, i + 2)).join('')}</p:spTree></p:cSld></p:sld>`;
}

export function notesXml(lines: string[]): string {
  return `${XML_DECL}<p:notes ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras(lines)}</p:txBody></p:sp>`
    + '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:fld id="{X}" type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>'
    + '</p:spTree></p:cSld></p:notes>';
}

/** A .pptx whose slides are listed in `order` (indexes into `slides`; default: as given). The slide
 *  parts are named in reverse so file order never equals presentation order by accident. */
export function pptxEntries(slides: SlideSpec[], order?: number[]): ZipEntry[] {
  const n = slides.length;
  const partOf = (i: number): number => n - i; // slide i is stored as slide<n-i>.xml
  const listed = order ?? slides.map((_, i) => i);
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]) },
    {
      name: 'ppt/presentation.xml',
      data: `${XML_DECL}<p:presentation ${NS_P}><p:sldMasterIdLst/><p:sldIdLst>${listed.map((i) =>
        `<p:sldId id="${256 + i}" r:id="rIdS${i}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: rels([
        { id: 'rIdM', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
        ...slides.map((_, i) => ({ id: `rIdS${i}`, type: 'slide', target: `slides/slide${partOf(i)}.xml` })),
      ]),
    },
  ];
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${partOf(i)}.xml`, data: slideXml(s) });
    const r = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
    if (s.notes) {
      r.push({ id: 'rId2', type: 'notesSlide', target: `../notesSlides/notesSlide${partOf(i)}.xml` });
      entries.push({ name: `ppt/notesSlides/notesSlide${partOf(i)}.xml`, data: notesXml(s.notes) });
    }
    entries.push({ name: `ppt/slides/_rels/slide${partOf(i)}.xml.rels`, data: rels(r) });
  });
  return entries;
}

export const pptx = (slides: SlideSpec[], order?: number[]): Buffer => zip(pptxEntries(slides, order));

export type CellSpec = string | number | boolean | null | { v: string; t?: string; s?: number; f?: string } | { inline: string };

export interface SheetSpec {
  name: string;
  rows: CellSpec[][];
  state?: 'hidden' | 'veryHidden';
  /** Row numbers (1-based) per row; default consecutive from 1. */
  rowNumbers?: number[];
}

const colName = (c: number): string => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A .xlsx: strings go to the shared string table; numbers/booleans as typed cells; objects as given. */
export function xlsxEntries(sheets: SheetSpec[], opts: { styles?: string; date1904?: boolean; sharedStrings?: boolean } = {}): ZipEntry[] {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const sid = (s: string): number => {
    if (!index.has(s)) { index.set(s, shared.length); shared.push(s); }
    return index.get(s)!;
  };
  const sheetParts = sheets.map((sheet) => {
    const rows = sheet.rows.map((row, ri) => {
      const r = sheet.rowNumbers?.[ri] ?? ri + 1;
      const cells = row.map((cell, ci) => {
        const ref = `${colName(ci)}${r}`;
        if (cell === null) return '';
        if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${sid(cell)}</v></c>`;
        if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
        if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
        if ('inline' in cell) return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.inline)}</t></is></c>`;
        return `<c r="${ref}"${cell.t ? ` t="${cell.t}"` : ''}${cell.s !== undefined ? ` s="${cell.s}"` : ''}>`
          + `${cell.f ? `<f>${esc(cell.f)}</f>` : ''}<v>${esc(cell.v)}</v></c>`;
      }).join('');
      return `<row r="${r}">${cells}</row>`;
    }).join('');
    return `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData>${rows}</sheetData></worksheet>`;
  });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]) },
    {
      name: 'xl/workbook.xml',
      data: `${XML_DECL}<workbook ${ns}>${opts.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets>${sheets.map((s, i) =>
        `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rIdW${i}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ...sheets.map((_, i) => ({ id: `rIdW${i}`, type: 'worksheet', target: `worksheets/sheet${sheets.length - i}.xml` })),
        { id: 'rIdSS', type: 'sharedStrings', target: 'sharedStrings.xml' },
        { id: 'rIdST', type: 'styles', target: 'styles.xml' },
      ]),
    },
  ];
  sheetParts.forEach((xml, i) => entries.push({ name: `xl/worksheets/sheet${sheets.length - i}.xml`, data: xml }));
  if (opts.sharedStrings !== false) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: `${XML_DECL}<sst ${ns} count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    });
  }
  if (opts.styles) entries.push({ name: 'xl/styles.xml', data: `${XML_DECL}<styleSheet ${ns}>${opts.styles}</styleSheet>` });
  return entries;
}

export const xlsx = (sheets: SheetSpec[], opts?: Parameters<typeof xlsxEntries>[1]): Buffer => zip(xlsxEntries(sheets, opts));

/** Replace (or add) one entry of an entry list. */
export function withEntry(entries: ZipEntry[], entry: ZipEntry): ZipEntry[] {
  return [...entries.filter((e) => e.name !== entry.name), entry];
}

export const withoutEntry = (entries: ZipEntry[], name: string): ZipEntry[] => entries.filter((e) => e.name !== name);
