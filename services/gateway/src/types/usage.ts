export interface UsageEvent {
  requestId: string;
  timestamp: number; // Unix timestamp for efficiency
  authType: 'api_key' | 'aws_credential';
  credentialId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // Separate tracking for cache creation tokens
  cacheReadInputTokens?: number; // Separate tracking for cache read tokens
  imageInputTokens?: number; // Separate tracking for image input tokens
  imageOutputTokens?: number; // Generated-image tokens, a subset of outputTokens, priced separately
  audioInputTokens?: number; // Realtime audio input tokens, a subset of inputTokens, priced separately
  audioOutputTokens?: number; // Realtime audio output tokens, a subset of outputTokens, priced separately
  responseTime: number;
  statusCode: number;
  endpoint?: string; // Add endpoint information for better granularity
  // True when inputTokens/outputTokens were derived locally (e.g. tokenizing a
  // mid-stream abort's already-streamed text) rather than read off a
  // provider-reported usage object. Absent/false means provider-reported.
  usageEstimated?: boolean;
  /** What inputTokens/outputTokens count: model tokens (default) or, for SAP-RPT, table cells. */
  unit?: 'tokens' | 'cells';
  /** The caller's User-Agent, trimmed: which client program made the request (tool governance shows it per tool). */
  userAgent?: string;
  /** Tools the request declared and the response invoked, with policy decisions (tool governance); absent when none. */
  tools?: ToolUsageEntry[];
}

/** One tool the request declared, the response invoked, or whose output the request carried (tool governance). */
export interface ToolUsageEntry {
  identity: string;
  /** `source`: the tool's OUTPUT was in the request (trust chain, spec 2026-09-22 §3); counted, never decided. */
  facet: 'declared' | 'invoked' | 'source';
  count: number;
  /** `detected`: the policy denies it and the gateway saw it used without having prevented it. */
  decision: 'allowed' | 'monitored' | 'stripped' | 'rejected' | 'unlisted' | 'detected';
  /** Why a denied tool was denied; absent for allowed tools and for sources. */
  reason?: 'policy' | 'trust_chain';
}

export interface UsageMetrics {
  startTime: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // Separate tracking for cache creation tokens
  cacheReadInputTokens?: number; // Separate tracking for cache read tokens
  imageInputTokens?: number; // Separate tracking for image input tokens
  imageOutputTokens?: number; // Generated-image tokens, a subset of outputTokens, priced separately
  audioInputTokens?: number; // Realtime audio input tokens, a subset of inputTokens, priced separately
  audioOutputTokens?: number; // Realtime audio output tokens, a subset of outputTokens, priced separately
  eventEmitted?: boolean; // Flag to prevent duplicate usage events
  // See UsageEvent.usageEstimated — carried on the metrics accumulator so the
  // controller can set it before emitUsageEvent copies it onto the event.
  usageEstimated?: boolean;
  /** What inputTokens/outputTokens count: model tokens (default) or, for SAP-RPT, table cells. */
  unit?: 'tokens' | 'cells';
}