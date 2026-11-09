// A small streaming XML scanner for OOXML parts: elements (by local name, prefixes dropped),
// attributes (qualified names) and text. It is fed the part in pieces and keeps only an unfinished
// token between them, so the reader can yield to the event loop after each piece.
//
// Deliberately strict and small: a DOCTYPE/DTD is refused (OOXML has none; no entity expansion
// is ever possible), only the five predefined entities and character references are decoded
// (anything else is malformed), nesting and every token's length are capped, and end tags must match. Comments and
// processing instructions are skipped; CDATA is text.

import { OoxmlFault } from './limits';

export interface XmlHandler {
  open?(name: string, attrs: Map<string, string>, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const malformed = (what: string): OoxmlFault => new OoxmlFault(`a part's XML is malformed (${what})`);

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^&;<\s]{0,12});|&/g, (match, ref: string | undefined) => {
    if (ref === undefined) throw malformed('a bare "&"');
    if (ref.startsWith('#')) {
      const code = /^#x[0-9a-fA-F]{1,6}$/.test(ref) ? parseInt(ref.slice(2), 16)
        : /^#[0-9]{1,7}$/.test(ref) ? parseInt(ref.slice(1), 10) : NaN;
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) throw malformed('a bad character reference');
      return String.fromCodePoint(code);
    }
    if (Object.prototype.hasOwnProperty.call(PREDEFINED, ref)) return PREDEFINED[ref];
    throw malformed('an undefined entity');
  });
}

const localName = (qname: string): string => {
  const colon = qname.indexOf(':');
  return colon < 0 ? qname : qname.slice(colon + 1);
};

const NAME = /^[^\s/>!?<"'=]+/;

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

/** The attributes of a tag (after its name): one linear pass, `name = "value"` pairs separated
 *  by whitespace; anything else is a broken attribute. */
function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const n = raw.length;
  let k = 0;
  for (;;) {
    while (k < n && isSpace(raw.charCodeAt(k))) k += 1;
    if (k >= n) return attrs;
    const start = k;
    for (; k < n; k += 1) {
      const c = raw.charCodeAt(k);
      if (isSpace(c) || c === 61 /* = */ || c === 34 || c === 39 || c === 47 /* / */ || c === 62 || c === 60) break;
    }
    if (k === start) throw malformed('a broken attribute');
    const name = raw.slice(start, k);
    while (k < n && isSpace(raw.charCodeAt(k))) k += 1;
    if (raw.charCodeAt(k) !== 61) throw malformed('a broken attribute');
    k += 1;
    while (k < n && isSpace(raw.charCodeAt(k))) k += 1;
    const quote = raw[k];
    if (quote !== '"' && quote !== "'") throw malformed('a broken attribute');
    const end = raw.indexOf(quote, k + 1);
    if (end < 0) throw malformed('a broken attribute');
    attrs.set(name, decodeXmlText(raw.slice(k + 1, end)));
    k = end + 1;
  }
}

/** The value of the attribute with a namespace prefix and this local name (e.g. r:id), if any. */
export function prefixedAttr(attrs: Map<string, string>, local: string): string | undefined {
  for (const [name, value] of attrs) if (name.includes(':') && localName(name) === local) return value;
  return undefined;
}

export class XmlScanner {
  private buf = '';
  private pending: string[] = [];
  private pendingChars = 0;
  /** A character that must arrive before the unfinished token can complete ('' = none). */
  private need = '';
  private readonly stack: string[] = [];
  private rootSeen = false;
  private started = false;
  /** Where the search for the end of the unfinished token at buf[0] goes on (0 = from its start),
   *  and the attribute quote open there: a long token is never rescanned from its start. */
  private resumeAt = 0;
  private resumeQuote = 0;

  constructor(
    private readonly handler: XmlHandler, private readonly maxDepth: number, private readonly maxTokenChars = 1024 * 1024,
  ) {}

  feed(piece: string): void {
    if (this.need !== '' && !piece.includes(this.need)) {
      this.pending.push(piece);
      this.pendingChars += piece.length;
      this.checkTokenLength(this.buf.length + this.pendingChars);
      return;
    }
    if (this.pending.length > 0) {
      this.pending.push(piece);
      piece = this.pending.join('');
      this.pending = [];
      this.pendingChars = 0;
    }
    this.buf = this.buf === '' ? piece : this.buf + piece;
    this.need = '';
    this.run(false);
  }

  end(): void {
    if (this.pending.length > 0) {
      this.buf += this.pending.join('');
      this.pending = [];
    }
    this.run(true);
    if (this.buf !== '') throw malformed('an unterminated token');
    if (this.stack.length > 0) throw malformed('an unclosed element');
    if (!this.rootSeen) throw malformed('no root element');
  }

  private run(final: boolean): void {
    let buf = this.buf;
    if (!this.started && buf.length > 0) {
      this.started = true;
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
    }
    let i = 0;
    const n = buf.length;
    let resume = this.resumeAt;
    const resumeQuote = this.resumeQuote;
    this.resumeAt = 0;
    this.resumeQuote = 0;
    while (i < n) {
      const lt = buf.indexOf('<', i);
      if (lt !== i) {
        if (lt < 0 && !final) break; // the text may go on in the next piece
        this.onText(buf.slice(i, lt < 0 ? n : lt), false);
        i = lt < 0 ? n : lt;
        continue;
      }
      const next = this.token(buf, i, final, resume, resumeQuote);
      resume = 0; // only the first token can be the one carried over
      if (next < 0) break;
      i = next;
    }
    this.buf = buf.slice(i);
    this.checkTokenLength(this.buf.length);
    // An unfinished tag, comment, PI or CDATA cannot complete before a '>'; unfinished text before a '<'.
    this.need = this.buf === '' ? '' : this.buf.startsWith('<') ? '>' : '<';
  }

  /** Every token — a tag, comment, PI, CDATA section or text node — is at most maxTokenChars long,
   *  so the work on any one of them is bounded. */
  private checkTokenLength(chars: number): void {
    if (chars > this.maxTokenChars) {
      throw new OoxmlFault(`a part's XML holds a tag or text longer than ${this.maxTokenChars} characters`);
    }
  }

  /** Handles the token at `i`; returns the index after it, or -1 when it is not complete yet. */
  private token(buf: string, i: number, final: boolean, resume: number, resumeQuote: number): number {
    /** Not complete in `buf`: go on from `at` (relative to the token) with `quote` open. */
    const incomplete = (at: number, quote = 0): number => {
      if (final) throw malformed('an unterminated token');
      this.resumeAt = Math.max(0, at);
      this.resumeQuote = quote;
      return -1;
    };
    const from = (k: number): number => Math.max(i + k, i + resume);
    const delimited = (start: string, end: string): number => {
      const at = buf.indexOf(end, from(start.length));
      if (at >= 0) this.checkTokenLength(at - i);
      return at < 0 ? incomplete(buf.length - i - (end.length - 1)) : at;
    };
    if (buf.startsWith('<?', i)) {
      const end = delimited('<?', '?>');
      return end < 0 ? -1 : end + 2;
    }
    if (buf.startsWith('<!--', i)) {
      const end = delimited('<!--', '-->');
      return end < 0 ? -1 : end + 3;
    }
    if (buf.startsWith('<![CDATA[', i)) {
      const end = delimited('<![CDATA[', ']]>');
      if (end < 0) return -1;
      this.onText(buf.slice(i + 9, end), true);
      return end + 3;
    }
    if (buf.startsWith('<!', i)) {
      // Too short yet to tell a comment or CDATA from a DOCTYPE.
      const head = buf.slice(i, i + 9);
      if (!final && ('<!--'.startsWith(head) || '<![CDATA['.startsWith(head))) return -1;
      throw new OoxmlFault('a part\'s XML declares a DTD, which is not allowed');
    }
    // An element tag: find its '>' outside quoted attribute values.
    let quote = resume > 0 ? resumeQuote : 0;
    let j = from(1);
    for (; j < buf.length; j += 1) {
      const c = buf.charCodeAt(j);
      if (quote !== 0) { if (c === quote) quote = 0; } else if (c === 34 || c === 39) quote = c; else if (c === 62) break;
    }
    this.checkTokenLength(j - i);
    if (j >= buf.length) return incomplete(j - i, quote);
    const inner = buf.slice(i + 1, j);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const open = this.stack.pop();
      if (open === undefined || open !== name) throw malformed('a mismatched end tag');
      this.handler.close?.(localName(name));
      return j + 1;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = NAME.exec(body);
    if (!m) throw malformed('a broken tag');
    const qname = m[0];
    if (this.stack.length === 0) {
      if (this.rootSeen) throw malformed('more than one root element');
      this.rootSeen = true;
    }
    if (this.stack.length >= this.maxDepth) throw new OoxmlFault(`a part's XML is nested more than ${this.maxDepth} levels deep`);
    const attrs = parseAttrs(body.slice(qname.length));
    if (!selfClosing) this.stack.push(qname);
    this.handler.open?.(localName(qname), attrs, selfClosing);
    if (selfClosing) this.handler.close?.(localName(qname));
    return j + 1;
  }

  private onText(raw: string, cdata: boolean): void {
    this.checkTokenLength(raw.length);
    if (this.stack.length === 0) {
      if (cdata || raw.trim() !== '') throw malformed('text outside the root element');
      return;
    }
    if (raw === '') return;
    this.handler.text?.(cdata ? raw : decodeXmlText(raw));
  }
}

/** Scan a whole document (or its pieces) synchronously. */
export function scanXml(xml: string | Iterable<string>, handler: XmlHandler, maxDepth = 256, maxTokenChars?: number): void {
  const scanner = new XmlScanner(handler, maxDepth, maxTokenChars);
  if (typeof xml === 'string') scanner.feed(xml);
  else for (const piece of xml) scanner.feed(piece);
  scanner.end();
}
