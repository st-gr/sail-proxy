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
}

export interface UsageMetrics {
  startTime: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // Separate tracking for cache creation tokens
  cacheReadInputTokens?: number; // Separate tracking for cache read tokens
  eventEmitted?: boolean; // Flag to prevent duplicate usage events
}