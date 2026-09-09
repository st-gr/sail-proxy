/**
 * Orchestration response envelope → a Gemini `generateContent` response.
 *
 * The response half of the Gemini bridge (requestTranslator.ts is the other
 * half). `sapAIService` hands back either the plain envelope or one wrapped
 * in `final_result`, exactly as it does for the Responses bridge — see
 * `translateOrchestrationResponse` in
 * ../../responses/orchestrationBridge/responseTranslator.ts — so both are
 * unwrapped here the same way.
 *
 * Pure: no I/O. See spec section 6 "Translation rules (bridge)" — Response —
 * for the binding rules this file implements.
 */
import { mapCachedTokens } from '../../responses/orchestrationBridge/cacheBreakpoints';

/**
 * `finish_reason` → Gemini's `finishReason` enum.
 *
 * `hasToolCalls` is consulted only when SAP sends no finish_reason at all
 * (null/undefined): some responses close a tool-calling turn without ever
 * setting it, and a turn that produced calls stopped for a reason, not for
 * no reason — so it maps to STOP rather than to the empty-choices OTHER. An
 * explicit `'tool_calls'` string already maps to STOP on its own, and any
 * other unrecognized value stays OTHER regardless of hasToolCalls.
 */
export function geminiFinishReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'OTHER' {
  if (finishReason === 'stop' || finishReason === 'tool_calls') return 'STOP';
  if (finishReason === 'length') return 'MAX_TOKENS';
  if (finishReason === 'content_filter') return 'SAFETY';
  if (finishReason == null) return hasToolCalls ? 'STOP' : 'OTHER';
  return 'OTHER';
}

/**
 * SAP orchestration `usage` → Gemini `usageMetadata`.
 *
 * This IS a regime conversion, exactly like the Responses bridge's
 * `translateUsage` — an earlier version of this comment claimed the opposite
 * and the numbers on the wire were wrong for it.
 *
 * SAP orchestration counts EXCLUSIVE: `prompt_tokens` holds only the full-rate
 * tokens and the cache read is a separate line item beside it, never inside it
 * (measured; see `foldExclusiveUsage` in ../../utils/usageFolding.ts for the
 * captures). Gemini counts INCLUSIVE: "Number of tokens in the prompt. When
 * `cachedContent` is set, this is still the total effective prompt size meaning
 * this includes the number of tokens in the cached content."
 * (ai.google.dev/api/generate-content, GenerateContentResponse.UsageMetadata.)
 * So the cached count has to be ADDED back into `promptTokenCount` here, or a
 * Gemini client computing "how much of my prompt was cached" reads a cached
 * share larger than the prompt it is a share of.
 *
 * ALL THREE exclusive parts go into `promptTokenCount`, not just the cache read:
 * SAP reports `prompt_tokens` (full-rate), `prompt_tokens_details.cached_tokens`
 * (served from cache) and `prompt_tokens_details.cache_creation_tokens` (written
 * to cache on this turn) as disjoint slices of ONE prompt — which is why
 * `foldExclusiveUsage` bills them as three separate line items that are ADDED.
 * Gemini's "total effective prompt size" is that whole prompt, so leaving the
 * cache-creation slice out would under-report the prompt on exactly the turn
 * that pays the most for it: the one that populated the cache.
 *
 * `totalTokenCount` is DERIVED rather than taken from `usage.total_tokens`:
 * SAP's total is in its own exclusive regime, and Gemini defines the field as
 * "prompt + thoughts + response candidates" over the inclusive prompt. Mixing
 * the two regimes in one object is the bug this function had.
 *
 * `cachedContentTokenCount` is omitted, not zero-filled, when there is no cache
 * activity — that is how a real Gemini response with nothing cached shapes the
 * field.
 */
export function usageMetadataFromOrchestration(usage: any): {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
} {
  const { cachedTokens } = mapCachedTokens(usage);
  // Gemini has no field for a cache WRITE, so those tokens are reported only as part
  // of the prompt they belong to; `cachedContentTokenCount` stays the READ count,
  // which is what it means.
  const creationTokens = usage?.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const promptTokenCount = (usage?.prompt_tokens ?? 0) + cachedTokens + creationTokens;
  const candidatesTokenCount = usage?.completion_tokens ?? 0;
  const totalTokenCount = promptTokenCount + candidatesTokenCount;

  const out: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    cachedContentTokenCount?: number;
  } = { promptTokenCount, candidatesTokenCount, totalTokenCount };
  if (cachedTokens > 0) out.cachedContentTokenCount = cachedTokens;
  return out;
}

/** `message.content` (string or text-block array) → Gemini text parts. */
function textParts(content: any): Array<{ text: string }> {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : [];
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => typeof block?.text === 'string')
      .map((block: any) => ({ text: block.text }));
  }
  return [];
}

/**
 * One tool call → a Gemini `functionCall` part.
 *
 * `arguments` is a JSON-encoded string on the wire; unparseable input (or
 * none at all) becomes `{ _raw: arguments }` instead of dropping the call —
 * the client still learns a call happened and what SAP actually sent.
 *
 * Exported for streamTranslator.ts, which assembles `argumentsJson` from
 * deltas rather than reading it off a message: the two paths must not
 * disagree about what an unparseable argument string becomes.
 */
export function geminiFunctionCallPart(name: any, argumentsJson: any): { functionCall: { name: any; args: any } } {
  let args: any;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    args = { _raw: argumentsJson };
  }
  return { functionCall: { name, args } };
}

/** `tool_calls[]` → Gemini `functionCall` parts. */
function functionCallParts(toolCalls: any[]): Array<{ functionCall: { name: any; args: any } }> {
  return toolCalls.map((call) => geminiFunctionCallPart(call?.function?.name, call?.function?.arguments));
}

export function orchestrationToGeminiResponse(envelope: any, opts: { modelName: string }): any {
  const body = envelope?.final_result ?? envelope ?? {};
  const choice = body?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const parts = [...textParts(message.content), ...functionCallParts(toolCalls)];
  const finishReason = geminiFinishReason(choice?.finish_reason, toolCalls.length > 0);

  return {
    candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
    usageMetadata: usageMetadataFromOrchestration(body?.usage),
    modelVersion: opts.modelName,
  };
}
