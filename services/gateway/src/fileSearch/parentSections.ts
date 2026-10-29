// Parent sections ("small to big"): a structured chunk that search found is
// returned as its section — or as much of it around the chunk as fits
// `file_search.parent_sections.max_tokens` — so the model reads the hit in
// context. Nothing is stored for it: a section is rebuilt from its chunks,
// which are exact substrings of it (structureChunker.ts), joined by their
// section offsets. Static and legacy chunks have no section and are returned
// as they are.
//
// Bounds: a parent never leaves its file, generation and section (the
// siblings are read by exactly those keys), never holds more than max_tokens
// tokens (cl100k, counted on the text returned) unless the hit chunk alone is
// larger — then it is the hit chunk alone — and always contains the hit chunk
// at its offset; when that cannot be shown (a sibling missing, a generation
// switched meanwhile), the hit falls back to its chunk.
//
// Pages: a parent of a paged file spans from the page of its first character to
// that of its last — counted from the hit's stored pages over the page breaks
// between the hit and the window's edges (pages.ts), so it is right however the
// window was cut.
import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../services/configService';
import { getPool } from './db';
import { driverErrorCode } from './repository';
import { countTokens } from './structureChunker';
import { PageSpan, parentPages } from './pages';

const logger = getDefaultLogger();

export type ParentScope = 'tool' | 'all' | 'off';
export interface ParentSectionSettings { maxTokens: number; scope: ParentScope }

export const PARENT_SECTION_DEFAULTS: Readonly<ParentSectionSettings> = Object.freeze({ maxTokens: 1500, scope: 'tool' });
const MIN_MAX_TOKENS = 200;
const MAX_MAX_TOKENS = 8000;

/** `file_search.parent_sections`, each key falling back to its default when invalid. */
export function parentSectionSettings(): ParentSectionSettings {
  let raw: Partial<ParentSectionSettings> | undefined;
  try {
    raw = getFileSearchConfig().parentSections;
  } catch {
    raw = undefined;
  }
  const max = raw?.maxTokens;
  const scope = raw?.scope;
  return {
    maxTokens: typeof max === 'number' && Number.isInteger(max) && max >= MIN_MAX_TOKENS && max <= MAX_MAX_TOKENS
      ? max : PARENT_SECTION_DEFAULTS.maxTokens,
    scope: scope === 'tool' || scope === 'all' || scope === 'off' ? scope : PARENT_SECTION_DEFAULTS.scope,
  };
}

/** A structured hit: where its chunk lives and what it says. */
export interface ParentHit {
  storeId: string;
  fileId: string;
  generation: number;
  section: number;
  ord: number;
  sectionOffset: number;
  text: string;
  /** The hit chunk's stored pages, when its file has pages. */
  pages?: PageSpan;
}

/** A hit's parent: its text, and its pages when the hit has pages. */
export interface ParentSection {
  text: string;
  pages?: PageSpan;
}

/** A chunk of the hit's section, as read back. */
export interface SectionChunk {
  ord: number;
  sectionOffset: number;
  text: string;
  tokens: number | null;
}

/** Chunks read on each side of a hit, at most: a parent needs at most max_tokens around the
 *  hit, and consecutive chunks of a section advance by far more than this many tokens. */
const ORDS_PER_SIDE_PER_TOKEN = 1 / 16;
/** Characters read on each side of a hit per token of the limit (text runs ~4 characters a
 *  token; the window below trims to the limit by an exact count). */
const CHARS_PER_SIDE_PER_TOKEN = 6;
/** Rounds of shrinking a window that came out over the limit. */
const SHRINK_ROUNDS = 8;
/** An edge moves to a whitespace boundary only within this share of its extension. */
const SNAP_SHARE = 0.15;

const estimate = (c: SectionChunk, chars: number): number =>
  (c.tokens && c.text.length > 0 ? (c.tokens * chars) / c.text.length : chars / 4);

/**
 * The section rebuilt from `siblings` (any order) around `hit`, cut to `maxTokens`: the
 * contiguous run of chunks holding the hit, de-overlapped by section offset; if it is longer
 * than the limit, a window centred on the hit chunk. Null when the run cannot be shown to hold
 * the hit chunk at its offset. Pure (`count` is the token counter).
 */
export function assembleParent(
  siblings: SectionChunk[], hit: { ord: number; sectionOffset: number; text: string }, maxTokens: number,
  count: (text: string) => number = countTokens,
): string | null {
  return assembleParentAt(siblings, hit, maxTokens, count)?.text ?? null;
}

/** assembleParent with the parent's pages, when the hit has pages. Pure. */
export function assembleParentSection(
  siblings: SectionChunk[], hit: { ord: number; sectionOffset: number; text: string; pages?: PageSpan }, maxTokens: number,
  count: (text: string) => number = countTokens,
): ParentSection | null {
  const parent = assembleParentAt(siblings, hit, maxTokens, count);
  if (!parent) return null;
  const pages = parentPages(parent.text, parent.hitStart, hit.text, hit.pages);
  return pages ? { text: parent.text, pages } : { text: parent.text };
}

/** assembleParent, with where the hit chunk starts in the returned text. */
function assembleParentAt(
  siblings: SectionChunk[], hit: { ord: number; sectionOffset: number; text: string }, maxTokens: number,
  count: (text: string) => number,
): { text: string; hitStart: number } | null {
  const chunks = [...siblings].sort((a, b) => a.ord - b.ord);
  const at = chunks.findIndex((c) => c.ord === hit.ord);
  if (at < 0) return null;
  let first = at;
  while (first > 0 && chunks[first - 1].ord === chunks[first].ord - 1) first -= 1;

  // Rebuild forward. A gap (a missing ord, or a chunk starting past the text so far) before
  // the hit starts the run again; one after it ends the run.
  let base = chunks[first].sectionOffset;
  let parent = chunks[first].text;
  let tokens = estimate(chunks[first], chunks[first].text.length);
  for (let j = first + 1; j < chunks.length; j += 1) {
    const c = chunks[j];
    const end = base + parent.length;
    if (c.ord !== chunks[j - 1].ord + 1 || c.sectionOffset > end || c.sectionOffset < base) {
      if (j > at) break;
      base = c.sectionOffset;
      parent = c.text;
      tokens = estimate(c, c.text.length);
      continue;
    }
    const piece = c.text.slice(end - c.sectionOffset);
    parent += piece;
    tokens += estimate(c, piece.length);
  }
  const hitStart = hit.sectionOffset - base;
  if (hitStart < 0 || parent.slice(hitStart, hitStart + hit.text.length) !== hit.text) return null;
  const hitEnd = hitStart + hit.text.length;

  if (tokens <= maxTokens * 1.25 && count(parent) <= maxTokens) return { text: parent, hitStart };

  // The hit's stored count (exact for structured chunks); counted only for a row without one.
  const hitTokens = chunks[at].tokens ?? count(hit.text);
  if (hitTokens >= maxTokens) return { text: hit.text, hitStart: 0 };
  const charsPerToken = parent.length / Math.max(1, tokens);
  let budget = maxTokens - hitTokens;
  for (let round = 0; round < SHRINK_ROUNDS && budget > 0; round += 1) {
    const chars = Math.floor(budget * charsPerToken);
    let right = Math.min(parent.length - hitEnd, Math.ceil(chars / 2));
    const left = Math.min(hitStart, chars - right);
    right = Math.min(parent.length - hitEnd, chars - left);
    let start = hitStart - left;
    let end = hitEnd + right;
    if (start > 0) {
      const limit = Math.min(hitStart, start + Math.floor(left * SNAP_SHARE));
      for (let k = start; k < limit; k += 1) {
        if (/\s/.test(parent[k])) { start = k + 1; break; }
      }
    }
    if (end < parent.length) {
      const limit = Math.max(hitEnd, end - Math.floor(right * SNAP_SHARE));
      for (let k = end - 1; k >= limit; k -= 1) {
        if (/\s/.test(parent[k])) { end = k; break; }
      }
    }
    const window = parent.slice(start, end);
    const windowTokens = count(window);
    if (windowTokens <= maxTokens) return { text: window, hitStart: hitStart - start };
    budget = Math.floor(budget * (maxTokens / windowTokens) * 0.95) - 1;
  }
  return { text: hit.text, hitStart: 0 };
}

const SIBLINGS_SQL = `SELECT h.i::int AS i, c.ord, c.section_offset, c.text, c.tokens
  FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[])
       WITH ORDINALITY AS h(store_id, file_id, generation, section, ord, lo, hi, i)
  JOIN vector_store_chunks c
    ON c.store_id = h.store_id AND c.file_id = h.file_id AND c.generation = h.generation
   AND c.ord BETWEEN h.ord - $8 AND h.ord + $8
   AND c.section = h.section AND c.section_offset BETWEEN h.lo AND h.hi
 ORDER BY h.i, c.ord`;

/**
 * Each hit's parent text and pages (index-aligned; null = return the chunk). One query for all hits,
 * reading only the hit's own file, generation and section, near the hit. A database failure
 * returns the chunks (logged): a parent is an enhancement of a result that already exists.
 */
export async function loadParentSections(hits: ParentHit[], maxTokens: number): Promise<Array<ParentSection | null>> {
  const out: Array<ParentSection | null> = hits.map(() => null);
  const pool = getPool();
  if (!pool || hits.length === 0) return out;
  const reach = CHARS_PER_SIDE_PER_TOKEN * maxTokens;
  const ords = Math.ceil(maxTokens * ORDS_PER_SIDE_PER_TOKEN) + 1;
  let rows: Array<{ i: number; ord: number; section_offset: number; text: string; tokens: number | null }>;
  try {
    ({ rows } = await pool.query(SIBLINGS_SQL, [
      hits.map((h) => h.storeId), hits.map((h) => h.fileId), hits.map((h) => h.generation),
      hits.map((h) => h.section), hits.map((h) => h.ord),
      hits.map((h) => Math.max(0, h.sectionOffset - reach)), hits.map((h) => h.sectionOffset + h.text.length + reach),
      ords,
    ]));
  } catch (error) {
    logger.warn('FileSearchParents', `Parent sections were not read; returning the chunks (${driverErrorCode(error)})`);
    return out;
  }
  const byHit = hits.map((): SectionChunk[] => []);
  for (const r of rows) {
    byHit[r.i - 1]?.push({ ord: r.ord, sectionOffset: r.section_offset, text: r.text, tokens: r.tokens });
  }
  // One exact count per parent bounds it by the limit. Measured for 50 parents: 11–21 ms at 1500
  // tokens, 50–113 ms at 8000 (English to the slowest nbsp/zwsp text), i.e. at most ~2 ms each.
  // The loop yields between parents, so no request waits behind more than one of them.
  for (let i = 0; i < hits.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (i > 0) await new Promise<void>((resolve) => { setImmediate(resolve); });
    const hit = hits[i];
    out[i] = assembleParentSection(byHit[i], hit, maxTokens);
    if (out[i] === null) {
      // Ids only, never text.
      logger.debug('FileSearchParents', 'A hit\'s section could not be rebuilt; returning its chunk',
        { storeId: hit.storeId, fileId: hit.fileId, ord: hit.ord });
    }
  }
  return out;
}
