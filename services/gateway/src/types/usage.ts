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
  responseTime: number;
  statusCode: number;
  endpoint?: string; // Add endpoint information for better granularity
  // True when inputTokens/outputTokens were derived locally (e.g. tokenizing a
  // mid-stream abort's already-streamed text) rather than read off a
  // provider-reported usage object. Absent/false means provider-reported.
  usageEstimated?: boolean;
}

export interface UsageMetrics {
  startTime: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // Separate tracking for cache creation tokens
  cacheReadInputTokens?: number; // Separate tracking for cache read tokens
  eventEmitted?: boolean; // Flag to prevent duplicate usage events
  // See UsageEvent.usageEstimated — carried on the metrics accumulator so the
  // controller can set it before emitUsageEvent copies it onto the event.
  usageEstimated?: boolean;
}