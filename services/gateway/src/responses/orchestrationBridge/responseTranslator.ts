/**
 * Orchestration response envelope → a Responses API response object.
 *
 * `sapAIService` hands back either the plain envelope or one wrapped in
 * `final_result` depending on the call, so both are unwrapped here rather than
 * making every caller remember which it has.
 *
 * Pure: no I/O. Ids are supplied by the caller so the output is deterministic
 * and testable.
 */
import * as crypto from 'crypto';
import { mapCachedTokens } from './cacheBreakpoints';

function itemId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Map a chat `finish_reason` onto a Responses status + `incomplete_details`.
 *
 * Exported and shared with `streamTranslator.ts`, deliberately: the two are
 * siblings describing the SAME turn, and they disagreed. streamTranslator read
 * no finish_reason at all, so the identical truncated turn reported
 * `incomplete` unstreamed and `completed` streamed — the status flipping on
 * `stream: true` is not a difference a client can be expected to absorb.
 *
 * `content_filter` maps to `incomplete`, not `completed`. It arrives with EMPTY
 * content and a populated usage object (observed twice in the live capture
 * recorded at test/fixtures/orchestration/cache-probe-result.md — generation
 * happened, the filter is post-hoc), so reporting `completed` hands the client
 * a successful blank answer: indistinguishable from the model having nothing to
 * say, and silently retried or accepted as an empty turn. `content_filter` is
 * one of the two reasons real OpenAI puts in `incomplete_details`, so this is
 * the API's own vocabulary rather than an invention of ours.
 */
export function statusForFinishReason(
  finishReason: string | null | undefined,
): { status: string; incomplete?: any } {
  if (finishReason === 'length') {
    return { status: 'incomplete', incomplete: { reason: 'max_output_tokens' } };
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incomplete: { reason: 'content_filter' } };
  }
  return { status: 'completed' };
}

/**
 * Raw SAP orchestration `usage` → the CLIENT-VISIBLE Responses `usage` object.
 *
 * A REGIME CONVERSION, done here because here is where the regime is known.
 *
 * What comes in is EXCLUSIVE: `prompt_tokens` counts only full-rate tokens, and
 * `prompt_tokens_details.cached_tokens` / `.cache_creation_tokens` are separate
 * counts alongside it. Measured, arm A2 of
 * test/fixtures/orchestration/bridge-cache-probe-result.md: prompt_tokens FLAT
 * at 14 across a write and a read turn while the cache field went 0 -> 17692.
 * (That was not always so. Before `requestTranslator.ts` stopped duplicating
 * the system message, the same endpoint read INCLUSIVE — arm A0, prompt_tokens
 * 15903 = 15892 cache + 11 new — and this function's predecessor could pass
 * `prompt_tokens` straight through as `input_tokens` and be right by accident.
 * See `recordOrchestrationUsage` in `responsesController.ts` for the full era
 * split.)
 *
 * What goes out is INCLUSIVE, because that is what the OpenAI Responses `usage`
 * shape MEANS to a client: `input_tokens` is the whole input and
 * `input_tokens_details.cached_tokens` is a SUBSET breakdown of it, which is
 * how codex's cost display reads it and how the hosted-tool engine's own usage
 * normalization is written. Emitting the exclusive `prompt_tokens` under an
 * inclusive field name would under-report a cached turn by the entire cached
 * prefix — 14 instead of 17706 on the A2 read turn.
 *
 * `cache_write_tokens` in the details is an ADDITION, named to match the real
 * OpenAI/ChatGPT Responses API — measured on real codex traffic
 * (`test/fixtures/codex-custom-tools/responses-api-compliance-capture.json`)
 * and on our own deployed path serving `/openai/v1/responses` natively. (This
 * function emitted `cache_creation_tokens` in that position until that
 * capture; SAP's own field, read below, keeps that name — it is a different
 * envelope.) A client that ignores the field is exactly as correct as before,
 * and one that reads it can finally tell a cache WRITE turn from a cold turn.
 *
 * `total_tokens` is RECOMPUTED as input + output rather than passed through.
 * SAP's own `total_tokens` is exclusive-shaped — 18 on the A2 read turn, i.e.
 * 14 + 4 — so forwarding it beside an inclusive `input_tokens` of 17706 would
 * ship a usage object that contradicts itself. Where there is no cache activity
 * the two agree anyway (arm A3: 18006 + 4 = 18010, SAP's own total), so the
 * recomputation only ever changes the numbers it has to.
 *
 * Shared with `streamTranslator.ts` — the two translators describe one turn and
 * their usage objects must be shape-identical, an invariant a previous review
 * established and which a second copy of this arithmetic would immediately put
 * at risk. Called with no usage at all it zero-fills, which is also the
 * streaming path's terminal-frame fallback.
 */
export function translateUsage(usage: any): any {
  const details = usage?.prompt_tokens_details || {};
  const promptTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const { cachedTokens } = mapCachedTokens(usage);
  // SAP's own field name — a different envelope from the client-visible output below,
  // unaffected by the cache_write_tokens rename (see this function's doc comment).
  const cacheWriteTokens = typeof details.cache_creation_tokens === 'number'
    ? details.cache_creation_tokens
    : 0;
  const inputTokens = promptTokens + cachedTokens + cacheWriteTokens;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cacheWriteTokens },
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

export interface TranslateOptions {
  model: string;
  responseId: string;
}

/**
 * SAP's `reasoning_content` → a Responses `reasoning` output item, or null.
 *
 * SHAPE, and why it is not the deployed route's shape. A real reasoning item
 * from the deployed route, captured verbatim from its SSE:
 *
 *   {"type":"reasoning","id":"rs_…","content":[],"encrypted_content":"gAAAAA…","summary":[]}
 *
 * `content` and `summary` are ALWAYS empty there and every reasoning token
 * lives inside the opaque `encrypted_content` blob — which is OpenAI's own
 * envelope format and cannot be manufactured. Copying that shape byte for byte
 * would therefore mean emitting an item carrying nothing at all.
 *
 * Orchestration gives us something the deployed route never exposes: the
 * reasoning in PLAINTEXT, as `[{content, signature}]` (the signature is
 * Anthropic's replay-validation token, a different thing from OpenAI's blob —
 * putting it in `encrypted_content` would be a lie about the field, so it is
 * dropped rather than smuggled). The plaintext goes in `summary`, the field the
 * Responses API uses for human-readable reasoning, so a client can display it.
 *
 * The block list is JOINED, not just the first taken: `reasoning_content` is a
 * list, and while every capture so far holds exactly one block, dropping the
 * tail of a multi-block response would silently lose reasoning.
 *
 * Returns null — never an empty item — when there is no reasoning. Absence is
 * the NORMAL case, not an error: on the adaptive shape the model decides
 * whether to think at all, and a trivial question comes back with no
 * `reasoning_content` even at `effort: "xhigh"` (measured, see
 * test/fixtures/orchestration/reasoning-probe-results.md).
 */
export function reasoningOutputItem(reasoningContent: any): any | null {
  if (!Array.isArray(reasoningContent)) return null;
  const text = reasoningContent
    .map((block) => (typeof block?.content === 'string' ? block.content : ''))
    .join('')
    .trim();
  if (text.length === 0) return null;
  return {
    type: 'reasoning',
    id: itemId('rs'),
    summary: [{ type: 'summary_text', text }],
    content: [],
  };
}

export function translateOrchestrationResponse(envelope: any, opts: TranslateOptions): any {
  const body = envelope?.final_result ?? envelope ?? {};
  const choice = body?.choices?.[0];
  const message = choice?.message ?? {};
  const output: any[] = [];

  const reasoningItem = reasoningOutputItem(message.reasoning_content);
  if (reasoningItem) output.push(reasoningItem);

  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({
      type: 'message',
      id: itemId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }

  for (const call of message.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: itemId('fc'),
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
      status: 'completed',
    });
  }

  const { status, incomplete } = statusForFinishReason(choice?.finish_reason);
  const usage = body?.usage || {};

  const response: any = {
    id: opts.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: opts.model,
    status,
    output,
    // Exclusive SAP counts in, inclusive OpenAI counts out — see translateUsage.
    usage: translateUsage(usage),
    error: null,
  };
  if (incomplete) response.incomplete_details = incomplete;

  return response;
}
