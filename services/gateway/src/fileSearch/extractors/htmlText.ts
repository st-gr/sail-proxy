// HTML to Markdown-shaped text for the `structure` chunking strategy: tags are
// stripped, h1–h6 become ATX headings, <pre> becomes a fenced block, block
// elements become line breaks, and script/style/template/noscript content and
// comments are dropped. `static` keeps indexing raw HTML (registry.ts).
//
// The input is untrusted: one linear pass, no backtracking-prone regexes over
// the document (every regex here is anchored or bounded, or runs on a single
// tag).

import { MAX_HEADING_CHARS } from '../structureScanner';

const DROPPED = new Set(['script', 'style', 'template', 'noscript']);
// An <h1>–<h6> whose closing tag is further away than this is not a heading
// (e.g. one closed only at the end of the page): its open tag is ignored and
// its content stays body text with its own structure.
const MAX_HEADING_HTML_CHARS = 2000;
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary',
  'table', 'tbody', 'tfoot', 'thead', 'title', 'tr', 'ul',
]);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Placeholder for a <pre> block while whitespace is normalised; NUL is removed
// from the document text first, so it cannot collide.
const PRE_MARK = '\u0000';

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Finds closing tags, remembering each tag's next match so a document full of
 * unclosed tags is still searched once per tag name, not once per tag.
 */
class CloseFinder {
  private readonly cache = new Map<string, { from: number; index: number; length: number }>();

  constructor(private readonly html: string) {}

  /** The first `</name>` at or after `from`, or null if there is none. */
  find(name: string, from: number): { index: number; length: number } | null {
    const cached = this.cache.get(name);
    if (cached && cached.from <= from && (cached.index === -1 || cached.index >= from)) {
      return cached.index === -1 ? null : cached;
    }
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    close.lastIndex = from;
    const m = close.exec(this.html);
    const found = { from, index: m ? m.index : -1, length: m ? m[0].length : 0 };
    this.cache.set(name, found);
    return m ? found : null;
  }
}

interface ScanState {
  /** No '>' exists at or after this offset. */
  noGtFrom: number;
  /** Next offset of each quote character at or after the last lookup (-1: none). */
  nextQuote: Record<string, number>;
}

function newScanState(): ScanState {
  return { noGtFrom: Infinity, nextQuote: { '"': -2, "'": -2 } };
}

/** Next offset of `quote` at or after `from`; lookups only move forward, so each scan is reused. */
function nextQuoteAt(html: string, quote: string, from: number, state: ScanState): number {
  const cached = state.nextQuote[quote];
  if (cached === -1 || (cached !== -2 && cached >= from)) return cached;
  const found = html.indexOf(quote, from);
  state.nextQuote[quote] = found;
  return found;
}

/**
 * Offset of the '>' ending a tag opened at `lt`, or -1 when `lt` does not open
 * a tag. A '>' inside a quoted attribute value does not end the tag when the
 * quote closes before the next '<'; otherwise the first '>' does.
 */
function tagEnd(html: string, lt: number, state: ScanState): number {
  if (!/[A-Za-z/!?]/.test(html[lt + 1] ?? '')) return -1;
  const nextLt = html.indexOf('<', lt + 1);
  const limit = nextLt === -1 ? html.length : nextLt;
  for (let j = lt + 1; j < limit; j += 1) {
    const c = html[j];
    if (c === '>') return j;
    if (c === '"' || c === "'") {
      const close = nextQuoteAt(html, c, j + 1, state);
      if (close !== -1 && close < limit) j = close;
    }
  }
  if (lt >= state.noGtFrom) return -1;
  const gt = html.indexOf('>', lt);
  if (gt === -1) state.noGtFrom = lt;
  return gt;
}

const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/;

/** Name and kind of the tag html[lt..gt], or null for <!doctype>, <?xml?> and the like. */
function tagName(html: string, lt: number, gt: number): { closing: boolean; name: string } | null {
  const m = TAG_NAME.exec(html.slice(lt, Math.min(gt + 1, lt + 64)));
  return m ? { closing: m[1] === '/', name: m[2].toLowerCase() } : null;
}

/** Text content of an HTML fragment: tags removed, script/style content and comments dropped. */
function stripTags(fragment: string): string {
  const state = newScanState();
  const closes = new CloseFinder(fragment);
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf('<', i);
    if (lt === -1) {
      out += fragment.slice(i);
      break;
    }
    out += fragment.slice(i, lt);
    if (fragment.startsWith('<!--', lt)) {
      const end = fragment.indexOf('-->', lt + 4);
      i = end === -1 ? fragment.length : end + 3;
      continue;
    }
    const gt = tagEnd(fragment, lt, state);
    if (gt === -1) {
      out += '<';
      i = lt + 1;
      continue;
    }
    i = gt + 1;
    const tag = tagName(fragment, lt, gt);
    if (tag && !tag.closing && DROPPED.has(tag.name)) {
      const close = closes.find(tag.name, i);
      i = close ? close.index + close.length : fragment.length;
    }
  }
  return decodeEntities(out);
}

function fenced(code: string): string {
  let longest = 2;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${code.replace(/^\n/, '').replace(/\s+$/, '')}\n${fence}`;
}

export function htmlToStructuredText(input: string): string {
  const html = input.split(PRE_MARK).join('');
  const closes = new CloseFinder(html);
  const state = newScanState();
  const out: string[] = [];
  const pres: string[] = [];
  const text = (raw: string): void => {
    out.push(decodeEntities(raw.replace(/\s+/g, ' ')));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = tagEnd(html, lt, state);
    if (gt === -1) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const tag = tagName(html, lt, gt);
    i = gt + 1;
    if (!tag) continue; // <!doctype>, <?xml?>
    const { closing, name } = tag;
    if (!closing && DROPPED.has(name)) {
      // Unclosed script/style: the rest of the document is its content.
      const close = closes.find(name, i);
      i = close ? close.index + close.length : html.length;
    } else if (!closing && (name === 'pre' || /^h[1-6]$/.test(name))) {
      // An unclosed <pre> or heading is ignored like any other tag; so is a
      // heading whose close is too far away to be a heading.
      const close = closes.find(name, i);
      if (!close) continue;
      if (name !== 'pre' && close.index - i > MAX_HEADING_HTML_CHARS) continue;
      const inner = stripTags(html.slice(i, close.index));
      i = close.index + close.length;
      if (name === 'pre') {
        pres.push(fenced(inner));
        out.push(`\n${PRE_MARK}${pres.length - 1}${PRE_MARK}\n`);
      } else {
        const heading = inner.replace(/\s+/g, ' ').trim();
        // Longer than a heading may be: kept as a paragraph.
        const marker = heading.length > MAX_HEADING_CHARS ? '' : `${'#'.repeat(Number(name[1]))} `;
        out.push(heading === '' ? '\n' : `\n\n${marker}${heading}\n\n`);
      }
    } else if (name === 'li' || name === 'tr') {
      // Items and rows break the line where they open, so a list or table stays tight.
      if (!closing) out.push(name === 'li' ? '\n- ' : '\n');
    } else if (BLOCK.has(name) || (closing && /^h[1-6]$/.test(name))) {
      out.push('\n');
    } else if ((name === 'td' || name === 'th') && !closing) {
      out.push(' ');
    }
  }
  const normalised = out
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalised.replace(new RegExp(`${PRE_MARK}(\\d+)${PRE_MARK}`, 'g'), (_, n: string) => `\n${pres[Number(n)]}\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * pandoc's gfm writer keeps what Markdown cannot express as raw HTML. Tables
 * with block content stay HTML tables (dropping raw HTML would turn them into
 * "[TABLE]"), but the empty anchors (`# <span id="anchor"></span>Install`,
 * odt/docx) and the section <div> wrapper lines (epub) carry no text and
 * would break heading detection and paths, so they go.
 */
export function tidyPandocMarkdown(text: string): string {
  return text
    .replace(/<span id="[^"<>\n]*"><\/span>/g, '')
    .replace(/^[ \t]*<\/?div\b[^>\n]*>[ \t]*(?:\r?\n|$)/gm, '');
}
