/**
 * Provider adapters for Connection models (spec 2026-10-23 §5.2): one module per provider type,
 * each turning a client body into the provider's request. Mappings follow LiteLLM's (MIT)
 * behaviour; the code is written fresh.
 */
export type UpstreamRoute = 'chat' | 'responses' | 'embeddings' | 'messages';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

export type TestFailureReason = 'no_credential' | 'not_supported' | 'unauthorized' | 'forbidden' | 'not_found' | 'unreachable' | 'timeout' | 'upstream_error';

/** Never carries upstream text: a reason code, the status and the provider's error code at most. */
export type TestResult =
  | { ok: true }
  | { ok: false; error: { reason: TestFailureReason; status?: number; code?: string } };

export interface ProviderAdapter {
  /** The outbound request; `clientBody` is not mutated, its `model` is replaced by `upstreamModel`. */
  /** `clientHeaders` are the client's (lower-cased) request headers; only the Anthropic adapter reads them. */
  buildRequest(route: UpstreamRoute, clientBody: any, upstreamModel: string, clientHeaders?: Record<string, string | string[] | undefined>): Promise<UpstreamRequest>;
  listModels(): Promise<string[]>;
  testConnection(): Promise<TestResult>;
  /** Every credential value this adapter may send (secret, current Entra token), for redaction. */
  secrets(): string[];
}

/** A credential the provider (or Entra) refused; `status` is the provider's HTTP status. */
export class UpstreamAuthError extends Error {
  constructor(public readonly status: number) {
    super(`credential refused (${status})`);
    this.name = 'UpstreamAuthError';
  }
}
