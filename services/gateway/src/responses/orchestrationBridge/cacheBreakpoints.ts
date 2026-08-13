/**
 * Prompt-caching breakpoints for the orchestration bridge.
 *
 * codex sends no `cache_control` and expects caching to happen anyway, so the
 * bridge inserts the breakpoints. Anthropic caches on a prefix basis over
 * tools → system → messages, permits at most four breakpoints, and will not
 * cache below a minimum prefix size.
 *
 * Placement is the incremental pattern: mark the stable prefix — the system
 * message and the conversation up to but NOT including the most recent turn —
 * so each turn's cache write becomes the next turn's read. Marking the most
 * recent turn would write a cache entry that never gets read.
 *
 * The system breakpoint goes on the TEMPLATE copy
 * (config.modules.prompt_templating.prompt.template), because that is the only
 * copy there is: `requestTranslator.ts` keeps template and messages_history
 * disjoint. This function used to hunt messages_history for a system message
 * instead, back when the translator put the same object in both places — which
 * meant the wire carried one marked and one unmarked copy of the same text.
 * See the era-split note below for what that cost. The conversation-prefix
 * breakpoint still walks messages_history and is unchanged.
 *
 * This module does not add a breakpoint on
 * config.modules.prompt_templating.prompt.tools. The live capture (see below)
 * only exercised a system-prompt prefix, never a tools array, so marking
 * tools here would be guessing at a shape nobody has confirmed orchestration
 * forwards correctly — left for a future task with its own capture.
 *
 * Field names in `mapCachedTokens` come from a live capture recorded at
 * `test/fixtures/orchestration/cache-probe-result.md`. They are not guessed,
 * and must not be changed without a new capture. That capture actually shows
 * FOUR fields under usage.prompt_tokens_details: cached_tokens (tokens read
 * from an existing cache entry), cache_creation_tokens (tokens written to a
 * new cache entry), and cache_creation_token_details.{ephemeral_5m_input_tokens,
 * ephemeral_1h_input_tokens} (the TTL split of the write). mapCachedTokens
 * reports only cached_tokens. cache_creation_tokens and its TTL split
 * describe a cache WRITE, a distinct accounting event this module was not
 * asked to report on; they are captured in SapV2Usage
 * (sapOrchestrationTypes.ts) instead, typed and available to whichever
 * future module needs write-side accounting, without widening this
 * function's contract or its callers' assumptions about its return shape.
 *
 * WHETHER prompt_tokens INCLUDES cached_tokens — an era-split record, because
 * this comment has asserted three different things and only the last one is
 * still true:
 *
 * - OLD, and WRONG as a general claim: `/openai/v1/chat/completions` is
 *   EXCLUSIVE (two runs both report prompt_tokens: 14 while cached_tokens goes
 *   0 -> 32004 for the same ~32k prefix) while `/openai/v1/responses` — this
 *   bridge — is INCLUSIVE (prompt_tokens 16303 = cache_creation/cached 16292 +
 *   11 new tokens, on the write turn AND the read turn). That second
 *   measurement was real, but it was not a property of the endpoint: it was an
 *   ARTIFACT of this bridge's own payload. `requestTranslator.ts` put the same
 *   system message in `prompt.template` AND `messages_history`, and this
 *   function marked only the messages_history copy, so the wire carried one
 *   marked and one unmarked copy of the same text. That asymmetry, not the
 *   endpoint, produced the inclusive-looking numbers.
 * - NEW, measured after the de-duplication:
 *   test/fixtures/orchestration/bridge-cache-probe-result.md, 2026-08-07, all
 *   four arms on anthropic--claude-4.8-opus. Arm A0 (the duplicated payload)
 *   reproduces the inclusive shape: prompt_tokens 15903 = 15892 cache + 11 new.
 *   Arm A2 (system message in the template only, exactly what this file and
 *   requestTranslator.ts now build) reports prompt_tokens FLAT at 14 across the
 *   write and read turns while the cache field goes 0 -> 17692 — EXCLUSIVE,
 *   the same regime as chat/completions. Arm A1 (both copies marked) is also
 *   exclusive but caches BOTH copies (0 -> 34181, ~2x the write cost), which
 *   is why de-duplication and not both-marking is the fix.
 *
 * So: both SAP orchestration endpoints report EXCLUSIVE usage, and the
 * bridge's consumer adds rather than subtracts — see `recordOrchestrationUsage`
 * in `responsesController.ts`, which folds this endpoint's raw envelope with
 * `foldExclusiveUsage`. A caller holding a usage object from somewhere else
 * still has to know which regime produced it; the point of the era split above
 * is that a regime can be an artifact of the payload, not just of the endpoint.
 *
 * Pure: returns a new payload, never mutates the caller's.
 */
import { SapV2CompletionRequest } from '../../services/sapOrchestrationTypes';

/** Anthropic's hard limit. Exceeding it is a request error, not a degradation. */
const MAX_BREAKPOINTS = 4;

const BREAKPOINT = { type: 'ephemeral' as const };

function markLastBlock(message: any): boolean {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  if (!last || typeof last !== 'object') return false;
  last.cache_control = { ...BREAKPOINT };
  return true;
}

export interface CacheOptions {
  /** The caller's resolved verdict — see resolvePromptCachingSupport (promptCachingSupport.ts) for how it defaults. */
  enabled: boolean;
}

export function applyCacheBreakpoints(
  payload: SapV2CompletionRequest,
  opts: CacheOptions,
): SapV2CompletionRequest {
  if (!opts.enabled) return payload;

  const next: any = JSON.parse(JSON.stringify(payload));
  const history: any[] = next.messages_history || [];
  let used = 0;

  // 1. The system message — the largest stable block in a codex session. It
  //    lives in the TEMPLATE and only there; messages_history is disjoint from
  //    it (requestTranslator.ts). Marking the copy that exists is the whole
  //    point: hunting messages_history for one is what left the wire carrying a
  //    marked duplicate beside an unmarked original.
  const template: any[] = next.config?.modules?.prompt_templating?.prompt?.template || [];
  const system = template.find((m: any) => m?.role === 'system');
  if (system && markLastBlock(system)) used += 1;

  // 2. The conversation prefix, excluding the most recent turn. Walk backwards
  //    from the second-to-last message and mark the first one that can hold a
  //    breakpoint, so the boundary sits as late as possible while still being
  //    re-read next turn.
  for (let i = history.length - 2; i >= 0 && used < MAX_BREAKPOINTS; i--) {
    // A system message in messages_history is the start of the prefix, not part
    // of it. Post-de-duplication nothing puts one here; stopping rather than
    // marking keeps a hand-built or legacy payload from getting the second copy
    // marked behind the translator's back.
    if (history[i]?.role === 'system') break;
    if (markLastBlock(history[i])) {
      used += 1;
      break;
    }
  }

  return next;
}

/**
 * Cached-token count from an orchestration usage object.
 *
 * Returns 0 rather than undefined when absent: some downstream arithmetic
 * over this value would otherwise have to null-check it, and undefined would
 * poison a sum.
 *
 * Whether this number is "additional to prompt_tokens" or "already inside
 * prompt_tokens" is a property of the payload as much as of the endpoint —
 * see this file's header for the era split. Both SAP orchestration endpoints
 * now measure EXCLUSIVE (additional to prompt_tokens) on the de-duplicated
 * payload this module builds breakpoints for. This function only extracts the
 * raw count; it does not know or assume which regime its caller is in, and a
 * caller holding a usage object from anywhere else still has to establish that
 * for itself rather than inheriting this file's answer.
 *
 * Reports only the cache-HIT counter (prompt_tokens_details.cached_tokens).
 * See this file's header for why the sibling cache-WRITE fields
 * (cache_creation_tokens and its TTL split) are intentionally left out of
 * this return shape.
 */
export function mapCachedTokens(usage: any): { cachedTokens: number } {
  const details = usage?.prompt_tokens_details;
  const cached = details?.cached_tokens;
  return { cachedTokens: typeof cached === 'number' ? cached : 0 };
}
