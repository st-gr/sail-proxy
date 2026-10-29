// PowerPoint (.pptx) → Markdown, for file_search. Slides in presentation order
// (ppt/presentation.xml's slide list + its relationships), each:
//
//   ## Slide N: <title>          ("## Slide N" without a title; "(hidden)" after N for a hidden slide)
//   <text frames, one block each, paragraphs one per line, in the slide's shape order>
//   <tables as pipe tables>
//   ### Notes
//   <the speaker notes>
//   \f
//
// One form feed ends every slide, an empty one too, so slide N is page N (pages.ts). The shape
// order is the slide's shape tree order — the order PowerPoint's own reading order follows. The
// title placeholder's text is the heading and is not repeated below it. Not read: charts,
// SmartArt, images, comments, slide masters/layouts (their placeholder prompts are not slide text).
// The same text serves the static and the structure strategies.

import { asDocumentRead, OoxmlFault, OoxmlReadOptions, ReadContext } from './limits';
import { cleanText, escapeCell, mainPart, markdownLine, pipeDelimiter, pipeLine, readRels, scanPart, skippingFallback } from './parts';
import { prefixedAttr, XmlHandler } from './xml';
import { openZip, ZipFile } from './zip';

interface ShapeFrame { ph: string | null; paras: string[] }
interface TableFrame { rows: string[][]; row: string[] | null; cell: string[] | null }

/** Reads one slide (or notes page): its title, its blocks in order, and whether it is hidden. */
class SlideText implements XmlHandler {
  title: string | null = null;
  blocks: string[] = [];
  hidden = false;
  private shapes: ShapeFrame[] = [];
  private tables: TableFrame[] = [];
  private para: string[] | null = null;
  private inText = 0;

  /** notes: only the notes body placeholder is read (not the slide number, header, footer, date).
   *  Every character of collected text is charged to the read's output cap as it arrives. */
  constructor(private readonly notes: boolean, private readonly ctx: ReadContext) {}

  open(name: string, attrs: Map<string, string>): void {
    switch (name) {
      case 'sld': this.hidden = ['0', 'false'].includes(attrs.get('show') ?? ''); break;
      case 'sp': this.shapes.push({ ph: null, paras: [] }); break;
      case 'ph': if (this.shapes.length > 0) this.shapes[this.shapes.length - 1].ph = attrs.get('type') ?? 'obj'; break;
      case 'tbl': this.tables.push({ rows: [], row: null, cell: null }); break;
      case 'tr': if (this.tables.length > 0) this.tables[this.tables.length - 1].row = []; break;
      case 'tc': if (this.tables.length > 0) this.tables[this.tables.length - 1].cell = []; break;
      case 'p': this.para = []; break;
      case 't': this.inText += 1; break;
      case 'br':
        // Consecutive breaks make empty lines, which are dropped anyway: one is kept.
        if (this.para && this.para[this.para.length - 1] !== '\n') {
          this.ctx.addOutput(1);
          this.para.push('\n');
        }
        break;
      default:
    }
  }

  text(text: string): void {
    if (this.inText > 0 && this.para) {
      this.ctx.addOutput(text.length);
      this.para.push(text);
    }
  }

  close(name: string): void {
    const table = this.tables[this.tables.length - 1];
    switch (name) {
      case 't': this.inText = Math.max(0, this.inText - 1); break;
      case 'p': {
        if (this.para === null) break;
        const text = this.para.join('');
        this.para = null;
        if (table?.cell) table.cell.push(cleanText(text));
        else if (this.shapes.length > 0) this.shapes[this.shapes.length - 1].paras.push(this.lines(text));
        else this.addBlock(this.lines(text));
        break;
      }
      case 'tc':
        if (table?.cell && table.row) {
          const text = table.cell.filter((t) => t !== '').join(' ');
          const cell = escapeCell(text);
          this.ctx.addOutput(cell.length - text.length); // the escapes' growth; the text was charged on arrival
          table.row.push(cell);
        }
        if (table) table.cell = null;
        break;
      case 'tr':
        if (table?.row) table.rows.push(table.row);
        if (table) table.row = null;
        if (table && table.rows.length > this.ctx.limits.maxTableRows) {
          throw new OoxmlFault(`a slide table has more than ${this.ctx.limits.maxTableRows} rows`);
        }
        break;
      case 'tbl':
        this.tables.pop();
        if (table && table.rows.some((r) => r.some((c) => c !== ''))) this.addBlock(this.renderTable(table.rows));
        break;
      case 'sp': this.closeShape(this.shapes.pop()!); break;
      default:
    }
  }

  /** A pipe table, its structure (3 × width + 2 per row, the delimiter row too) charged before it is built. */
  private renderTable(rows: string[][]): string {
    let width = 0;
    for (const r of rows) width = Math.max(width, r.length);
    this.ctx.addOutput((3 * width + 2) * (rows.length + 1));
    const lines = [pipeLine(rows[0], width), pipeDelimiter(width)];
    for (let i = 1; i < rows.length; i += 1) lines.push(pipeLine(rows[i], width));
    return lines.join('\n');
  }

  private closeShape(shape: ShapeFrame): void {
    const block = shape.paras.filter((p) => p !== '').join('\n');
    if (this.notes) {
      if (shape.ph === 'body') this.addBlock(block);
      return;
    }
    if ((shape.ph === 'title' || shape.ph === 'ctrTitle') && this.title === null) {
      // The title's lines joined by spaces; its Markdown escapes are not needed in a heading.
      const title = shape.paras.flatMap((p) => p.split('\n')).map((l) => l.replace(/^\\/, '')).filter((t) => t !== '').join(' ');
      if (title !== '') {
        this.title = title;
        return;
      }
    }
    this.addBlock(block);
  }

  /** A paragraph → Markdown lines (a line break inside a paragraph starts a new line); empty ones dropped. */
  private lines(para: string): string {
    return para.split('\n').map(markdownLine).filter((l) => l !== '').join('\n');
  }

  private addBlock(block: string): void {
    if (block !== '') this.blocks.push(block);
  }
}

async function readSlideList(zip: ZipFile, presentation: string, ctx: ReadContext): Promise<string[]> {
  const ids: string[] = [];
  let root: string | null = null;
  await scanPart(zip, presentation, skippingFallback({
    open(name, attrs) {
      root ??= name;
      if (name !== 'sldId') return;
      ids.push(prefixedAttr(attrs, 'id') ?? '');
      if (ids.length > ctx.limits.maxSlides) throw new OoxmlFault(`it has more than ${ctx.limits.maxSlides} slides`);
    },
  }), ctx);
  if (root !== 'presentation') throw new OoxmlFault('the presentation part is missing');
  const rels = await readRels(zip, presentation, ctx);
  return ids.map((id) => {
    const rel = rels.get(id);
    if (!rel || rel.type !== 'slide' || rel.target === null || !zip.has(rel.target)) {
      throw new OoxmlFault('a slide the presentation lists is missing');
    }
    return rel.target;
  });
}

async function readSlide(zip: ZipFile, part: string, n: number, ctx: ReadContext): Promise<string> {
  const slide = new SlideText(false, ctx);
  await scanPart(zip, part, skippingFallback(slide), ctx);
  let notes: SlideText | null = null;
  for (const rel of (await readRels(zip, part, ctx)).values()) {
    if (rel.type === 'notesSlide' && rel.target !== null && zip.has(rel.target)) {
      notes = new SlideText(true, ctx);
      await scanPart(zip, rel.target, skippingFallback(notes), ctx);
      break;
    }
  }
  const heading = `## Slide ${n}${slide.hidden ? ' (hidden)' : ''}${slide.title ? `: ${slide.title}` : ''}`;
  let parts = [heading].concat(slide.blocks);
  if (notes && notes.blocks.length > 0) parts = parts.concat(['### Notes'], notes.blocks);
  const text = `${parts.join('\n\n')}\n\f\n`;
  ctx.addOutput(heading.length + parts.length * 2 + 3); // the structure around the text already charged
  return text;
}

/** The presentation's text as Markdown, one section and one form feed per slide. */
export async function readPptx(bytes: Buffer, opts: OoxmlReadOptions): Promise<string> {
  return asDocumentRead('PowerPoint', async () => {
    const ctx = new ReadContext('PowerPoint', opts);
    const zip = openZip(bytes, ctx.limits);
    const presentation = await mainPart(zip, 'ppt/presentation.xml', 'presentation', ctx);
    const slides = await readSlideList(zip, presentation, ctx);
    const out: string[] = [];
    for (let i = 0; i < slides.length; i += 1) out.push(await readSlide(zip, slides[i], i + 1, ctx));
    return out.join('');
  });
}
