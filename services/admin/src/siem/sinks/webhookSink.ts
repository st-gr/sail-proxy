import axios from 'axios';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, safeStringify } from '../sink';

export interface WebhookSinkConfig {
  name: string;
  url: string;
  /**
   * The bearer token value itself — resolved by the caller from an environment
   * variable named in the sink's config entry. Never read from api_config.json,
   * which is tracked in three synced copies in this public repo.
   */
  token?: string;
  timeoutMs?: number;
  /**
   * Per-sink opt-in for shipping the full raw value of an unresolved credential
   * (SiemEvent.actor.credential_material). Default false — see SiemSink.includeCredentialMaterial
   * and siem/dispatcher.ts, which is what actually strips the field when this is false.
   */
  includeCredentialMaterial?: boolean;
  /**
   * Per-sink opt-in for SiemEvent.content — the request's prompt and response, in masked
   * form. Default false — see SiemSink.includeContent and siem/dispatcher.ts, which is what
   * actually removes the field when this is false.
   */
  includeContent?: boolean;
  /**
   * Per-sink opt-in to receive content the pseudonymization pipeline never masked. Default
   * false, and only consulted when includeContent is also true — see
   * SiemSink.allowUnmaskedContent.
   */
  allowUnmaskedContent?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Posts `{ events: batch }` to `cfg.url`. Knows nothing about the queue or retries. */
export function createWebhookSink(cfg: WebhookSinkConfig): SiemSink {
  return {
    name: cfg.name,
    includeCredentialMaterial: cfg.includeCredentialMaterial ?? false,
    includeContent: cfg.includeContent ?? false,
    allowUnmaskedContent: cfg.allowUnmaskedContent ?? false,

    validateConfig(): string[] {
      const problems: string[] = [];
      if (!cfg.name) {
        problems.push('name is required');
      }
      if (!cfg.url) {
        problems.push('url is required');
        return problems;
      }
      let parsed: URL;
      try {
        parsed = new URL(cfg.url);
      } catch {
        problems.push(`url is not a valid URL: ${cfg.url}`);
        return problems;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`url scheme must be http or https, got ${parsed.protocol}`);
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      if (!cfg.url) return false;
      try {
        await axios.get(cfg.url, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          validateStatus: () => true,
          // Never follow a redirect: the Authorization header would be replayed to
          // whatever host the Location points at.
          maxRedirects: 0,
          headers: authHeaders(cfg.token),
        });
        return true;
      } catch {
        return false;
      }
    },

    async send(batch: SiemEvent[]): Promise<void> {
      let status: number;
      try {
        const response = await axios.post(
          cfg.url,
          // Pre-serialized via safeStringify (sink.ts), not the plain `{ events: batch }`
          // object: axios would otherwise call its own unguarded JSON.stringify internally.
          // A string body with an explicit application/json Content-Type is sent as-is by
          // axios (it only re-encodes a body it has to stringify itself) -- see
          // stringifySafely in axios's default transformRequest.
          safeStringify({ events: batch }),
          {
            timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            // Handle every status ourselves so 4xx and 5xx can be told apart below,
            // rather than letting axios collapse all non-2xx into one thrown shape.
            validateStatus: () => true,
            // Never follow a redirect: the Authorization header would be replayed to
            // whatever host the Location points at, and axios does not strip
            // credentials across hosts. A redirecting SIEM endpoint is a
            // misconfiguration to fix, not a hop to follow.
            maxRedirects: 0,
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(cfg.token),
            },
          }
        );
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`Webhook request failed: ${error.message}`, true);
      }

      if (status >= 200 && status < 300) {
        return;
      }
      // 429 (rate limited) and 408 (request timeout) are transient despite falling
      // in the 4xx range: the dispatcher should back off and retry, not give up.
      // Marking them non-retryable would silently drop events on rate limiting.
      if (status === 429 || status === 408) {
        throw new SinkError(`Webhook returned ${status}`, true, status);
      }
      if (status >= 300 && status < 400) {
        throw new SinkError(`Webhook redirected (${status}); redirects are not followed`, false, status);
      }
      if (status >= 400 && status < 500) {
        throw new SinkError(`Webhook returned ${status}`, false, status);
      }
      throw new SinkError(`Webhook returned ${status}`, true, status);
    },
  };
}
