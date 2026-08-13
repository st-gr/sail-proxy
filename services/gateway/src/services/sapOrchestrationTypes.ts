/**
 * SAP AI Core Orchestration V2 wire types.
 *
 * Single source of truth for the orchestration request/response envelope.
 * Mirrors the V2 schema fragment that the gateway actually uses.
 *
 * Endpoint: POST {url}/v2/inference/deployments/{deploymentId}/v2/completion
 *
 * @see https://sap.github.io/ai-sdk/docs/js/orchestration/chat-completion
 * @see https://help.sap.com/doc/generative-ai-hub-sdk/CLOUD/en-US/_reference/orchestration-service2.html
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

export interface SapV2Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | any[];
  [key: string]: any;
}

export interface SapV2Template {
  template: SapV2Message[];
  tools?: any[];
  response_format?: any;
  defaults?: Record<string, string>;
}

export interface SapV2Model {
  name: string;
  version?: string;
  params?: Record<string, any>;
}

export interface SapV2PromptTemplating {
  prompt: SapV2Template;
  model: SapV2Model;
}

export interface SapV2Modules {
  prompt_templating: SapV2PromptTemplating;
  // Optional V2 modules — not used by this refactor but reserved here so
  // future enablement (native masking, grounding, translation) lives in the
  // same type without breaking changes.
  masking?: any;
  grounding?: any;
  translation?: any;
  filtering?: any;
}

export interface SapV2GlobalStreamOptions {
  enabled?: boolean;
  chunk_size?: number;
  delimiters?: string[];
}

export interface SapV2Config {
  modules: SapV2Modules;
  stream?: SapV2GlobalStreamOptions;
}

export interface SapV2CompletionRequest {
  config: SapV2Config;
  placeholder_values?: Record<string, any>;
  messages_history?: any[];
  /**
   * Internal-only: if present, sapAIService writes payload snapshots under
   * this id via payloadLogger. Stripped before HTTP POST so it never goes
   * over the wire.
   */
  debugRequestId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response (and streaming chunks share the same envelope)
// ─────────────────────────────────────────────────────────────────────────────

export interface SapV2Choice {
  index?: number;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: any[];
    refusal?: string;
  };
  delta?: {
    content?: string;
    tool_calls?: any[];
  };
  finish_reason?: string | null;
  logprobs?: any;
}

/**
 * TTL split of a cache-creation event. Anthropic bills 5-minute and 1-hour
 * cache writes at different rates; orchestration passes both counters
 * through under prompt_tokens_details.cache_creation_token_details.
 */
export interface SapV2CacheCreationTokenDetails {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  [key: string]: any;
}

/**
 * Cache accounting for a single completion, present only for providers that
 * support prompt caching. Field names captured live against
 * anthropic--claude-4.8-opus via Bedrock — see
 * test/fixtures/orchestration/cache-probe-result.md.
 *
 * WHETHER prompt_tokens/total_tokens on SapV2Usage INCLUDE these fields — an
 * era split, because two live captures disagreed and the disagreement turned
 * out to be about the PAYLOAD, not the endpoint:
 *
 * - Both captures against `/openai/v1/chat/completions` read EXCLUSIVE:
 *   prompt_tokens flat at 14 on both runs while cached_tokens went 0 -> 32004
 *   for the same prefix. A full accounting is prompt_tokens + cached_tokens (+
 *   cache_creation_tokens on a write turn).
 * - OLD, and no longer true: a capture against `/openai/v1/responses` (the
 *   orchestration bridge, `responsesController.ts`'s
 *   `recordOrchestrationUsage`) on the SAME model measured prompt_tokens 16303
 *   = cached/cache_creation 16292 + 11 new tokens on BOTH the write and read
 *   turn — INCLUSIVE, the opposite. That was an ARTIFACT of the bridge sending
 *   the system message twice, once marked with a cache breakpoint and once
 *   not; it was never a property of this shape or of that endpoint.
 * - NEW: with the bridge's payload de-duplicated, `/openai/v1/responses`
 *   measures EXCLUSIVE too — prompt_tokens FLAT at 14 across a write and a read
 *   turn while the cache field goes 0 -> 17692 (arm A2,
 *   test/fixtures/orchestration/bridge-cache-probe-result.md, 2026-08-07;
 *   arm A0 in the same fixture reproduces the old inclusive shape from the
 *   duplicated payload, 15903 = 15892 + 11).
 *
 * So both endpoints are EXCLUSIVE today. Still do not assume a regime for a
 * SapV2Usage object from a path neither capture covers — the lesson of the era
 * split is that the payload can decide it. See `cacheBreakpoints.ts`'s file
 * header and `recordOrchestrationUsage` for the full numbers and the reasoning
 * each consumer applies.
 */
export interface SapV2PromptTokensDetails {
  /** Non-zero on a cache HIT — tokens read from an existing cache entry. */
  cached_tokens?: number;
  /**
   * Non-zero on a cache WRITE — tokens written to a new cache entry.
   *
   * `cache_creation_tokens` is SAP's own orchestration wire-format name (this
   * whole file mirrors what the V2 schema actually sends, live-captured — see
   * this interface's header). It is NOT the same field as the real OpenAI/
   * ChatGPT Responses API's `cache_write_tokens`, which lives in a different
   * envelope entirely (`input_tokens_details` on a native deployment's own
   * `usage`, read via `readCacheWriteTokens` in `usageFolding.ts`). Do not
   * rename this one to match — SAP genuinely calls it `cache_creation_tokens`,
   * and this type would then misdescribe the wire.
   */
  cache_creation_tokens?: number;
  cache_creation_token_details?: SapV2CacheCreationTokenDetails;
  [key: string]: any;
}

export interface SapV2Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: SapV2PromptTokensDetails;
}

export interface SapV2Citation {
  ref_id?: number;
  title?: string;
  url: string;
}

export interface SapV2LlmModuleResult {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: SapV2Choice[];
  usage?: SapV2Usage;
  citations?: Array<SapV2Citation | string>;
  [key: string]: any;
}

export interface SapV2ModuleResults {
  templating?: any;
  llm?: SapV2LlmModuleResult;
  masking?: any;
  grounding?: any;
  translation?: any;
  filtering?: any;
  [key: string]: any;
}

export interface SapV2IntermediateFailure {
  message?: string;
  code?: string;
  location?: string;
}

export interface SapV2CompletionResponse {
  request_id?: string;
  intermediate_results?: SapV2ModuleResults;
  final_result?: SapV2LlmModuleResult;
  intermediate_failures?: SapV2IntermediateFailure[];
  [key: string]: any;
}
