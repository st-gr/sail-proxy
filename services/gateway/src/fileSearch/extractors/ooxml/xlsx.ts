// Excel (.xlsx) → Markdown, for file_search. Sheets in workbook order (xl/workbook.xml + its
// relationships), each non-empty worksheet:
//
//   ## Sheet: <name>              (" (hidden)" after the name of a hidden sheet — hidden sheets are read)
//
//   | <first non-empty row> |     the header
//   | --- |
//   | <every further non-empty row> |
//
// Empty rows and columns are dropped; a sheet without values is left out. The structure chunker
// splits a long table between rows and repeats its header on every continuation (W2's carry).
//
// Values as displayed where that is cheap, the raw value otherwise: shared and inline strings,
// TRUE/FALSE, error codes (#N/A), formulas by their cached value (never recomputed), numbers
// without float noise (15 significant digits, as Excel shows), percentages (formats 9/10), and
// dates/times for the built-in date formats and custom formats made of date/time codes (1900 and
// 1904 date systems) as ISO "YYYY-MM-DD[ HH:MM[:SS]]". Other number formats (currency, thousands
// separators, fractions, elapsed time) show the raw number. Chart sheets, comments, images and
// header/footer text are not read. The same text serves the static and the structure strategies.

import { asDocumentRead, OoxmlFault, OoxmlReadOptions, ReadContext } from './limits';
import { cleanText, escapeCell, mainPart, pipeDelimiter, pipeLine, readRels, scanPart, skippingFallback } from './parts';
import { prefixedAttr } from './xml';
import { openZip, ZipFile } from './zip';

interface DateKind { date: boolean; time: boolean }
interface Styles {
  xfs: number[];
  formats: Map<number, string>;
  /** dateKind per number format id, worked out once. */
  kinds: Map<number, DateKind | null>;
}
interface Row { r: number; cells: Array<[number, string]> }

const decodeEscapes = (s: string): string => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

async function readSharedStrings(zip: ZipFile, part: string, ctx: ReadContext): Promise<string[]> {
  const strings: string[] = [];
  let parts: string[] | null = null;
  let inText = false;
  let phonetic = 0;
  await scanPart(zip, part, skippingFallback({
    open(name) {
      if (name === 'si') parts = [];
      else if (name === 'rPh') phonetic += 1;
      else if (name === 't' && phonetic === 0) inText = true;
    },
    text(text) { if (inText && parts) parts.push(text); },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'rPh') phonetic -= 1;
      // Cleaned once here, not again for every cell that refers to it.
      else if (name === 'si' && parts) { strings.push(cleanText(decodeEscapes(parts.join('')))); parts = null; }
    },
  }), ctx);
  return strings;
}

async function readStyles(zip: ZipFile, part: string, ctx: ReadContext): Promise<Styles> {
  const styles: Styles = { xfs: [], formats: new Map(), kinds: new Map() };
  let inCellXfs = false;
  let inNumFmts = false; // the workbook's number formats (not those of differential formats, dxfs)
  await scanPart(zip, part, skippingFallback({
    open(name, attrs) {
      if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'numFmts') inNumFmts = true;
      else if (name === 'xf' && inCellXfs) styles.xfs.push(Number(attrs.get('numFmtId')) || 0);
      else if (name === 'numFmt' && inNumFmts) {
        const code = attrs.get('formatCode') ?? '';
        // A code past the cap (Excel allows 255 characters) is not read: its numbers show raw.
        styles.formats.set(Number(attrs.get('numFmtId')), code.length > ctx.limits.maxNumFmtChars ? '' : code);
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
      else if (name === 'numFmts') inNumFmts = false;
    },
  }), ctx);
  return styles;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);

/** Whether a format code's first section shows a date and/or a time, in one pass: quoted text,
 *  escaped characters, padding (_x) and fill (*x) codes and brackets are literals; an elapsed-time
 *  bracket ([h], [mm], [ss]) means a duration, shown raw. Best effort. */
function formatKind(code: string): DateKind | null {
  let date = false;
  let time = false;
  let month = false;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === ';') break;
    if (c === '\\' || c === '_' || c === '*') { i += 1; continue; }
    if (c === '"' || c === '[') {
      const end = code.indexOf(c === '"' ? '"' : ']', i + 1);
      if (end < 0) break;
      if (c === '[' && /^\[(h+|m+|s+)\]$/i.test(code.slice(i, end + 1))) return null;
      i = end;
      continue;
    }
    const l = c.toLowerCase();
    if (l === 'd' || l === 'y') date = true;
    else if (l === 'h' || l === 's') time = true;
    else if (l === 'm') month = true;
  }
  if (month && !time) date = true;
  return date || time ? { date, time } : null;
}

/** Whether number format `id` shows a date and/or a time; memoised per id. */
function dateKind(id: number, styles: Styles): DateKind | null {
  if (BUILTIN_DATE.has(id)) return { date: true, time: id === 22 };
  if (BUILTIN_TIME.has(id)) return { date: false, time: true };
  let kind = styles.kinds.get(id);
  if (kind === undefined) {
    const code = styles.formats.get(id);
    kind = code === undefined ? null : formatKind(code);
    styles.kinds.set(id, kind);
  }
  return kind;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function excelDate(serial: number, date1904: boolean, kind: DateKind): string | null {
  if (!(serial >= 0 && serial < 2958466)) return null;
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) { days += 1; secs = 0; }
  let date: string;
  if (!date1904 && days === 60) date = '1900-02-29'; // Excel's 1900 leap-year bug
  else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const d = new Date(base + days * 86_400_000);
    date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = secs % 60;
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}${s ? `:${pad(s)}` : ''}`;
  const showDate = kind.date && (date1904 || days > 0 || !kind.time);
  return [showDate ? date : null, kind.time ? time : null].filter((p) => p !== null).join(' ');
}

function numberText(raw: string, style: number, styles: Styles | null, date1904: boolean): string {
  const num = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(num)) return raw;
  const id = styles?.xfs[style] ?? 0;
  if (styles && id === 9) return `${Math.round(num * 100)}%`;
  if (styles && id === 10) return `${(num * 100).toFixed(2)}%`;
  const kind = styles ? dateKind(id, styles) : null;
  if (kind) return excelDate(num, date1904, kind) ?? raw;
  return String(Number(num.toPrecision(15)));
}

/** XFD: Excel's last column (0-based). */
const MAX_COLUMN = 16_383;

/** "BC12" → 54 (0-based column), or null. */
function columnOf(ref: string | undefined): number | null {
  const m = ref ? /^([A-Za-z]{1,3})[0-9]/.exec(ref) : null;
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

interface Book { shared: string[] | null; styles: Styles | null; date1904: boolean }

interface Sheet { rows: Row[]; /** Columns holding a value somewhere. */ used: Set<number> }

async function readSheet(zip: ZipFile, part: string, book: Book, ctx: ReadContext, cellCount: { n: number }): Promise<Sheet> {
  const rows: Row[] = [];
  const used = new Set<number>();
  let row: Row | null = null;
  let rowCursor = 0;
  let colCursor = 0;
  let cell: { col: number; t: string; s: number; v: string[]; inline: string[] } | null = null;
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  const value = (c: NonNullable<typeof cell>): string => {
    const raw = c.v.join('');
    switch (c.t) {
      case 's': {
        if (raw.trim() === '') return '';
        if (!book.shared) throw new OoxmlFault('the shared strings part is missing');
        const s = book.shared[Number(raw)];
        if (s === undefined) throw new OoxmlFault('a cell refers to a shared string that does not exist');
        return s;
      }
      case 'inlineStr': return decodeEscapes(c.inline.join(''));
      case 'b': return raw === '' ? '' : raw.trim() === '1' || raw.trim() === 'true' ? 'TRUE' : 'FALSE';
      case 'n': return numberText(raw, c.s, book.styles, book.date1904);
      default: return decodeEscapes(raw); // str (formula text), e (error code), d (ISO date)
    }
  };
  await scanPart(zip, part, skippingFallback({
    open(name, attrs) {
      switch (name) {
        case 'row':
          rowCursor = Number(attrs.get('r')) || rowCursor + 1;
          colCursor = 0;
          row = { r: rowCursor, cells: [] };
          break;
        case 'c': {
          const col = columnOf(attrs.get('r')) ?? colCursor;
          if (col > MAX_COLUMN) throw new OoxmlFault('a cell lies beyond the last column (XFD)');
          colCursor = col + 1;
          cell = { col, t: attrs.get('t') ?? 'n', s: Number(attrs.get('s')) || 0, v: [], inline: [] };
          break;
        }
        case 'v': inValue = true; break;
        case 'is': inInline = true; break;
        case 'rPh': phonetic += 1; break;
        case 't': inText = inInline && phonetic === 0; break;
        default:
      }
    },
    text(text) {
      if (!cell) return;
      if (inValue) cell.v.push(text);
      else if (inText) cell.inline.push(text);
    },
    close(name) {
      switch (name) {
        case 'v': inValue = false; break;
        case 't': inText = false; break;
        case 'rPh': phonetic -= 1; break;
        case 'is': inInline = false; break;
        case 'c':
          if (cell && row) {
            // Shared strings are cleaned already; the value's length is charged to the output cap
            // here, before any row is rendered, so a long string repeated in many cells stops early.
            const v = escapeCell(cell.t === 's' ? value(cell) : cleanText(value(cell)));
            ctx.addOutput(v.length);
            if (v !== '') {
              row.cells.push([cell.col, v]);
              used.add(cell.col);
              cellCount.n += 1;
              if (cellCount.n > ctx.limits.maxCells) throw new OoxmlFault(`it has more than ${ctx.limits.maxCells} cells with values`);
            }
          }
          cell = null;
          break;
        case 'row':
          if (row && row.cells.length > 0) rows.push(row);
          row = null;
          break;
        default:
      }
    },
  }), ctx);
  return { rows, used };
}

/** One sheet's section. The values were charged while reading; each row's table structure is
 *  charged before the row is built (a wide, sparse sheet stops at the cap without building it),
 *  and the event loop gets a turn every 2 000 rows or ~1 Mi characters. */
async function renderSheet(name: string, hidden: boolean, { rows, used }: Sheet, ctx: ReadContext): Promise<string> {
  rows.sort((a, b) => a.r - b.r);
  const cols = [...used].sort((a, b) => a - b);
  const position = new Map(cols.map((c, i) => [c, i]));
  const width = cols.length;
  const lines = [`## Sheet: ${cleanText(name)}${hidden ? ' (hidden)' : ''}`, ''];
  let sinceTick = 0;
  for (let i = 0; i < rows.length; i += 1) {
    ctx.addOutput(3 * width + 2);
    const cells: string[] = new Array(width).fill('');
    for (const [c, v] of rows[i].cells) cells[position.get(c)!] = v; // escaped and charged while reading
    const line = pipeLine(cells, width);
    lines.push(line);
    if (i === 0) lines.push(pipeDelimiter(width));
    sinceTick += line.length;
    if (i % 2000 === 1999 || sinceTick > 1024 * 1024) {
      sinceTick = 0;
      await ctx.tick();
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The workbook's text as Markdown, one section with one pipe table per non-empty sheet. */
export async function readXlsx(bytes: Buffer, opts: OoxmlReadOptions): Promise<string> {
  return asDocumentRead('Excel', async () => {
    const ctx = new ReadContext('Excel', opts);
    const zip = openZip(bytes, ctx.limits);
    const workbook = await mainPart(zip, 'xl/workbook.xml', 'workbook', ctx);
    const sheets: Array<{ name: string; hidden: boolean; id: string }> = [];
    let root: string | null = null;
    let date1904 = false;
    await scanPart(zip, workbook, skippingFallback({
      open(name, attrs) {
        root ??= name;
        if (name === 'workbookPr') date1904 = ['1', 'true'].includes(attrs.get('date1904') ?? '');
        if (name !== 'sheet') return;
        const state = attrs.get('state');
        sheets.push({ name: attrs.get('name') ?? '', hidden: state === 'hidden' || state === 'veryHidden', id: prefixedAttr(attrs, 'id') ?? '' });
        if (sheets.length > ctx.limits.maxSheets) throw new OoxmlFault(`it has more than ${ctx.limits.maxSheets} sheets`);
      },
    }), ctx);
    if (root !== 'workbook') throw new OoxmlFault('the workbook part is missing');

    const rels = await readRels(zip, workbook, ctx);
    const byType = (type: string): string | null => {
      for (const rel of rels.values()) if (rel.type === type && rel.target !== null && zip.has(rel.target)) return rel.target;
      return null;
    };
    const sharedPart = byType('sharedStrings');
    const stylesPart = byType('styles');
    const book: Book = {
      shared: sharedPart ? await readSharedStrings(zip, sharedPart, ctx) : null,
      styles: stylesPart ? await readStyles(zip, stylesPart, ctx) : null,
      date1904,
    };
    const cellCount = { n: 0 };
    const out: string[] = [];
    for (const sheet of sheets) {
      const rel = rels.get(sheet.id);
      if (rel && rel.type !== 'worksheet') continue; // a chart or dialog sheet: no cells
      if (!rel || rel.target === null || !zip.has(rel.target)) throw new OoxmlFault('a sheet the workbook lists is missing');
      const read = await readSheet(zip, rel.target, book, ctx, cellCount);
      if (read.rows.length > 0) out.push(await renderSheet(sheet.name, sheet.hidden, read, ctx));
    }
    return out.join('\n');
  });
}
