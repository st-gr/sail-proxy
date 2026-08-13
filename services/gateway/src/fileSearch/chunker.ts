// Pure text chunker for file_search retrieval. No I/O, no database, no network —
// safe to call from workers or request handlers alike.

export type ChunkingStrategy =
  | { type: 'auto' }
  | { type: 'static'; static: { max_chunk_size_tokens: number; chunk_overlap_tokens: number } };

export interface Chunk {
  ord: number;
  text: string;
  tokens: number;
}

const DEFAULT_MAX_CHUNK_SIZE_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 400;
const MIN_CHUNK_SIZE_TOKENS = 100;
const MAX_CHUNK_SIZE_TOKENS = 4096;

/**
 * Words-to-tokens ratio backing the estimateTokens approximation below. Shared
 * with chunkText's word-count budgeting so the two stay mathematically in sync:
 * chunkText derives "how many words fit in N tokens" by inverting this same
 * ratio rather than hardcoding a second, potentially-drifting constant.
 */
const TOKENS_PER_WORD = 1.3;

/**
 * Approximate token count for a chunk of English text.
 *
 * Byte-identical parity with OpenAI's chunk boundaries is not achievable here:
 * it would require both OpenAI's exact tokenizer (e.g. cl100k/o200k, undisclosed
 * for some models) AND their exact splitting algorithm. The design spec for this
 * feature explicitly does not require byte-identity — only that chunking be
 * consistent and documented within this codebase. We deliberately do not pull in
 * a tokenizer dependency (tiktoken/js-tiktoken/gpt-3-encoder): the extra weight
 * buys precision this feature doesn't need, and every runtime dependency in this
 * pnpm workspace must also be mirrored into
 * services/gateway/package.docker.json.
 *
 * The approximation: whitespace-delimited word count x 1.3, a standard rule of
 * thumb for English text (~1.3 tokens per word for common BPE tokenizers). This
 * is used consistently for both the sliding-window chunker below and for any
 * caller that needs a rough token estimate of extracted document text.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(words * TOKENS_PER_WORD);
}

/**
 * Resolve a raw (possibly API-supplied) chunking strategy into a concrete static
 * strategy. `auto` — including the default when nothing is supplied — resolves
 * immediately to the OpenAI default of 800 max tokens / 400 overlap tokens, so
 * downstream code (chunkText and its callers) never has to branch on strategy type.
 */
export function resolveChunkingStrategy(raw: unknown): ChunkingStrategy {
  const input = raw as Partial<ChunkingStrategy> | undefined | null;

  let maxChunkSizeTokens = DEFAULT_MAX_CHUNK_SIZE_TOKENS;
  let chunkOverlapTokens = DEFAULT_CHUNK_OVERLAP_TOKENS;

  if (input && input.type === 'static' && input.static) {
    maxChunkSizeTokens = input.static.max_chunk_size_tokens;
    chunkOverlapTokens = input.static.chunk_overlap_tokens;
  }

  if (
    typeof maxChunkSizeTokens !== 'number' ||
    maxChunkSizeTokens < MIN_CHUNK_SIZE_TOKENS ||
    maxChunkSizeTokens > MAX_CHUNK_SIZE_TOKENS
  ) {
    throw new Error(
      `max_chunk_size_tokens must be between ${MIN_CHUNK_SIZE_TOKENS} and ${MAX_CHUNK_SIZE_TOKENS}, got ${maxChunkSizeTokens}`
    );
  }

  if (
    typeof chunkOverlapTokens !== 'number' ||
    chunkOverlapTokens < 0 ||
    chunkOverlapTokens > maxChunkSizeTokens / 2
  ) {
    throw new Error(
      `chunk_overlap_tokens must be between 0 and half of max_chunk_size_tokens (${maxChunkSizeTokens / 2}), got ${chunkOverlapTokens}`
    );
  }

  return {
    type: 'static',
    static: { max_chunk_size_tokens: maxChunkSizeTokens, chunk_overlap_tokens: chunkOverlapTokens },
  };
}

/**
 * Yields the [start, end) word-index windows of a sliding-window chunker,
 * advancing by `step = max(1, wordsPerChunk - overlapWords)` each time.
 *
 * This is pulled out of chunkText, and is a generator rather than an
 * eagerly-built array, specifically so the zero/negative-step guard is
 * independently testable: `chunkText`'s only entry point to this arithmetic is
 * gated by `resolveChunkingStrategy`, which rejects overlap > size/2 before
 * `chunkText` ever computes a step — so calling `chunkText` itself can never
 * drive `overlapWords >= wordsPerChunk` through this code, and a test that only
 * calls `chunkText` cannot tell a real clamp from a deleted one. Exporting this
 * generator lets a test construct that hostile ratio directly. Being lazy
 * matters too: with the clamp removed, `step` can be 0 or negative, which would
 * make an eagerly-computed array of windows loop forever (or run away
 * negative); a generator only computes as many windows as are pulled via
 * `.next()`, so a test can observe the non-advancing cursor in a couple of
 * calls without hanging.
 */
export function* slidingWordWindows(
  wordCount: number,
  wordsPerChunk: number,
  overlapWords: number
): Generator<{ start: number; end: number }> {
  const step = Math.max(1, wordsPerChunk - overlapWords);
  for (let start = 0; start < wordCount; start += step) {
    const end = Math.min(start + wordsPerChunk, wordCount);
    yield { start, end };
    if (end >= wordCount) return;
  }
}

/**
 * Split text into overlapping chunks using a word-based sliding window, sized by
 * estimateTokens. `resolveChunkingStrategy` already rejects overlap > size/2 at
 * the API boundary; see slidingWordWindows's doc comment for why the internal
 * step clamp is defended by a separate, more direct test rather than by
 * anything reachable through this function.
 */
export function chunkText(text: string, strategy: ChunkingStrategy): Chunk[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const resolved = resolveChunkingStrategy(strategy);
  // resolveChunkingStrategy always resolves to the 'static' shape (see its own
  // doc comment); this narrows the type rather than trusting an unsafe cast.
  if (resolved.type !== 'static') {
    throw new Error(`resolveChunkingStrategy returned an unexpected type: ${resolved.type}`);
  }
  const { max_chunk_size_tokens: maxTokens, chunk_overlap_tokens: overlapTokens } = resolved.static;

  const words = trimmed.split(/\s+/);

  // Convert token-based sizing into a word count by inverting estimateTokens's
  // ratio, so the sliding window operates on whole words while still tracking
  // the token budget the caller asked for.
  const wordsPerChunk = Math.max(1, Math.floor(maxTokens / TOKENS_PER_WORD));
  const overlapWords = Math.max(0, Math.floor(overlapTokens / TOKENS_PER_WORD));

  const chunks: Chunk[] = [];
  let ord = 0;
  for (const { start, end } of slidingWordWindows(words.length, wordsPerChunk, overlapWords)) {
    const chunkWords = words.slice(start, end);
    const chunkText = chunkWords.join(' ');
    chunks.push({ ord, text: chunkText, tokens: estimateTokens(chunkText) });
    ord += 1;
  }

  return chunks;
}
