// OPC package helpers shared by the PowerPoint and Excel readers: reading one XML part in slices
// (a yield to the event loop between slices), relationships, and the package's main part.

import * as path from 'path';
import { OoxmlFault, ReadContext } from './limits';
import { XmlHandler, XmlScanner } from './xml';
import { partKey, ZipFile } from './zip';

/** Inflate `name` and feed its XML to `handler` slice by slice. */
export async function scanPart(zip: ZipFile, name: string, handler: XmlHandler, ctx: ReadContext): Promise<void> {
  const bytes = await zip.read(name, ctx);
  await ctx.tick();
  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  const decoder = new TextDecoder(utf16 ? (bytes[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8');
  const scanner = new XmlScanner(handler, ctx.limits.maxXmlDepth, ctx.limits.maxTokenChars);
  const step = ctx.limits.sliceChars;
  for (let at = 0; at < bytes.length; at += step) {
    scanner.feed(decoder.decode(bytes.subarray(at, Math.min(bytes.length, at + step)), { stream: true }));
    await ctx.tick();
  }
  scanner.feed(decoder.decode());
  scanner.end();
}

export interface Relationship {
  /** The type URI's last segment (e.g. "slide", "notesSlide", "worksheet"): transitional and strict alike. */
  type: string;
  /** The target's part key, resolved against the source part; null for an external target. */
  target: string | null;
}

/** The part key `target` names, relative to the part `source` (or absolute with a leading "/"). */
export function resolveTarget(source: string, target: string): string {
  const t = target.replace(/\\/g, '/');
  const joined = t.startsWith('/') ? t : path.posix.join(path.posix.dirname(`/${partKey(source)}`), t);
  return partKey(path.posix.normalize(joined));
}

/** The relationships of `source` by Id; an empty map when the part has none. */
export async function readRels(zip: ZipFile, source: string, ctx: ReadContext): Promise<Map<string, Relationship>> {
  const key = partKey(source);
  const relsName = key === '' ? '_rels/.rels' : `${path.posix.dirname(key) === '.' ? '' : `${path.posix.dirname(key)}/`}_rels/${path.posix.basename(key)}.rels`;
  const rels = new Map<string, Relationship>();
  if (!zip.has(relsName)) return rels;
  await scanPart(zip, relsName, {
    open(name, attrs) {
      if (name !== 'Relationship') return;
      const id = attrs.get('Id');
      const type = attrs.get('Type');
      const target = attrs.get('Target');
      if (id === undefined || type === undefined || target === undefined || rels.has(id)) return;
      rels.set(id, {
        type: type.slice(type.lastIndexOf('/') + 1),
        target: attrs.get('TargetMode') === 'External' ? null : resolveTarget(key, target),
      });
    },
  }, ctx);
  return rels;
}

/** The package's main part (the officeDocument relationship), else the conventional name. */
export async function mainPart(zip: ZipFile, conventional: string, what: string, ctx: ReadContext): Promise<string> {
  const rels = await readRels(zip, '', ctx);
  for (const rel of rels.values()) {
    if (rel.type === 'officeDocument' && rel.target !== null && zip.has(rel.target)) return rel.target;
  }
  if (zip.has(conventional)) return conventional;
  throw new OoxmlFault(`the ${what} part is missing`);
}

/** Document text as Markdown-safe single-line content: control characters become spaces. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** A table cell's text with "|" escaped (the text is already cleaned). */
export const escapeCell = (text: string): string => (text.includes('|') ? text.replace(/\|/g, '\\|') : text);

/** One pipe-table row of `width` cells (already escaped); missing cells empty. */
export function pipeLine(cells: string[], width: number): string {
  let line = '|';
  for (let i = 0; i < width; i += 1) line += ` ${cells[i] ?? ''} |`;
  return line;
}

export const pipeDelimiter = (width: number): string => `|${' --- |'.repeat(width)}`;

/** One line of document text in Markdown: cleaned, and escaped where it would read as structure
 *  (an ATX heading, a code fence, a setext underline). */
export function markdownLine(text: string): string {
  const line = cleanText(text);
  return /^(#|`{3}|~{3}|[-=]+$)/.test(line) ? `\\${line}` : line;
}

/** Wraps a handler so that the content of mc:Fallback (the copy kept for older readers beside an
 *  mc:Choice) is not read twice. */
export function skippingFallback(handler: XmlHandler): XmlHandler {
  let depth = 0;
  return {
    open(name, attrs, selfClosing) {
      if (depth > 0 || name === 'Fallback') {
        depth += 1; // the scanner closes every element it opens, self-closing ones too
        return;
      }
      handler.open?.(name, attrs, selfClosing);
    },
    close(name) {
      if (depth > 0) {
        depth -= 1;
        return;
      }
      handler.close?.(name);
    },
    text(text) {
      if (depth === 0) handler.text?.(text);
    },
  };
}
