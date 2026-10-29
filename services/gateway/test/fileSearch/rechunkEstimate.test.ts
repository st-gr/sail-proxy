// One file's re-chunk estimate (rechunk.ts estimateFileRechunk): the text once from the stored
// chunks, the new chunk count by the target setting, the embedding input with overlap and context.
import {
  estimateFileRechunk, estimateFileVision, HEADING_CONTEXT_TOKENS, SENTENCE_CONTEXT_TOKENS, STRUCTURE_FILL,
} from '../../src/fileSearch/rechunk';
import type { ChunkingSetting } from '../../src/fileSearch/chunkingSetting';
import { VISION_DEFAULTS } from '../../src/fileSearch/visionTranscriber';

const STATIC_800: ChunkingSetting = { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false };
const STATIC_400: ChunkingSetting = { type: 'static', max_tokens: 400, overlap_tokens: 0, contextual: false };
const STRUCT_400: ChunkingSetting = { type: 'structure', max_tokens: 400, overlap_tokens: 50, contextual: false };

describe('estimateFileRechunk', () => {
  it('a file without embedded chunks costs nothing', () => {
    expect(estimateFileRechunk({ chunks: 0, tokens: 0, continuations: 0 }, STATIC_800, STRUCT_400))
      .toEqual({ documentTokens: 0, chunks: 0, embeddingTokens: 0 });
  });

  it('static 800/400 → static 400/0: the overlap is taken out once, then cut into plain windows', () => {
    // 5 chunks of 800 with 400 overlap: 800 + 4 × 400 = 2,400 tokens of text
    const stats = { chunks: 5, tokens: 4000, continuations: 4 };
    expect(estimateFileRechunk(stats, STATIC_800, STATIC_400)).toEqual({ documentTokens: 2400, chunks: 6, embeddingTokens: 2400 });
  });

  it('→ structure: at least the windows, at least the text over half-filled chunks; heading context per chunk', () => {
    const stats = { chunks: 5, tokens: 4000, continuations: 4 };
    const chunks = Math.ceil(2400 / (STRUCTURE_FILL * 400));
    expect(estimateFileRechunk(stats, STATIC_800, STRUCT_400)).toEqual({
      documentTokens: 2400, chunks, embeddingTokens: 2400 + (chunks - 1) * 50 + chunks * HEADING_CONTEXT_TOKENS,
    });
    expect(estimateFileRechunk(stats, STATIC_800, { ...STRUCT_400, contextual: true }).embeddingTokens)
      .toBe(2400 + (chunks - 1) * 50 + chunks * (HEADING_CONTEXT_TOKENS + SENTENCE_CONTEXT_TOKENS));
  });

  it('only contextual changes: the same cuts, counted exactly', () => {
    const stats = { chunks: 7, tokens: 2100, continuations: 2 };
    expect(estimateFileRechunk(stats, STRUCT_400, { ...STRUCT_400, contextual: true })).toEqual({
      documentTokens: 2000, chunks: 7, embeddingTokens: 2100 + 7 * (HEADING_CONTEXT_TOKENS + SENTENCE_CONTEXT_TOKENS),
    });
  });

  it('never assumes less text than one average chunk', () => {
    // tokens far below continuations × overlap (stored counts under the overlap): one chunk's worth stays
    expect(estimateFileRechunk({ chunks: 4, tokens: 400, continuations: 3 }, STATIC_800, STATIC_400).documentTokens).toBe(100);
  });
});

describe('estimateFileVision (W3): one file\'s vision pages and tokens by the setting it is read by', () => {
  const SETTINGS = { ...VISION_DEFAULTS, maxPagesPerFile: 50 };
  const AUTO: ChunkingSetting = { ...STRUCT_400, vision: 'auto' };

  it('a PDF with a vision mode counts at the per-file cap: an honest upper bound (no page count is stored)', () => {
    const cap = { pages: 50, input: 50 * 1250, outputUpperBound: Math.min(50 * 4096, 120_000 + 2 * 4096) };
    expect(estimateFileVision('scan.pdf', AUTO, SETTINGS)).toEqual(cap);
    expect(estimateFileVision('Scan.PDF', { ...STATIC_400, vision: 'no_text' }, SETTINGS)).toEqual(cap);
    expect(estimateFileVision('old.pdf', AUTO, { ...SETTINGS, maxPagesPerFile: 7 })!.pages).toBe(7);
  });

  it('nothing for a setting without vision or a file that is not a PDF', () => {
    expect(estimateFileVision('scan.pdf', STRUCT_400, SETTINGS)).toBeNull();
    expect(estimateFileVision('slides.pptx', AUTO, SETTINGS)).toBeNull();
    expect(estimateFileVision('notes.md', AUTO, SETTINGS)).toBeNull();
  });
});
