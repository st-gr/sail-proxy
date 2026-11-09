import axios from 'axios';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, resolveSecret, safeStringify } from '../sink';
import type { SecretResolver } from '../secretResolver';

export interface OtelSinkConfig {
  name: string;
  endpoint: string;
  /**
   * Name of an environment variable holding extra headers as JSON — for a collector sitting
   * behind auth. Parsed defensively: a malformed value surfaces as a validateConfig()
   * problem, never a throw at send time.
   */
  headersEnv?: string;
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
  /** Injected secret resolver — see sink.ts's resolveSecret. No credential source if omitted. */
  getSecret?: SecretResolver;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** OTLP severity numbers: INFO=9, WARN=13, ERROR=17, FATAL=21. */
const SEVERITY_NUMBER: Record<string, number> = { low: 9, medium: 13, high: 17, critical: 21 };

/**
 * OTLP/HTTP log records. One resource, one scope, one logRecord per SiemEvent.
 * An OTel collector fans these out to Sentinel, Splunk, Elastic and most other
 * destinations, which is why this sink covers the majority of estates by itself.
 */
function toOtlp(batch: SiemEvent[]) {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sail-proxy' } }] },
      scopeLogs: [{
        scope: { name: 'sail-proxy.siem' },
        logRecords: batch.map(e => ({
          timeUnixNano: String(Date.parse(e.timestamp) * 1_000_000),
          severityNumber: SEVERITY_NUMBER[e.severity] ?? 9,
          severityText: e.severity,
          body: { stringValue: safeStringify(e) },
          attributes: [
            { key: 'siem.event_id', value: { stringValue: e.event_id } },
            { key: 'siem.category', value: { stringValue: e.category } },
            { key: 'siem.type', value: { stringValue: e.type } },
            { key: 'siem.outcome', value: { stringValue: e.outcome } },
          ],
        })),
      }],
    }],
  };
}

/**
 * Reads the credential stored for the slot `headersEnv` and parses it as a JSON object of
 * extra headers. Never throws: an absent or malformed value is reported back as a problem
 * string for validateConfig() to surface, rather than blowing up at send time.
 *
 * Configuring `headersEnv` at all is the operator saying this collector is behind auth, so an
 * absent credential is a problem, exactly as it is for the other five sinks - same
 * "no credential stored for slot 'X'" wording. Reporting nothing here (as this used to) let
 * validateConfig() return [] and the sink start unauthenticated, sending every batch with no
 * Authorization header for as long as the process ran, with no warning anywhere. Only a sink
 * with no `headersEnv` at all - a collector that wants no extra headers - resolves to an empty
 * header set without complaint.
 */
function resolveHeaders(
  cfg: { getSecret?: SecretResolver },
  headersEnv: string | undefined
): { headers: Record<string, string>; problem?: string } {
  if (!headersEnv) return { headers: {} };
  const raw = resolveSecret(cfg, headersEnv);
  if (!raw) return { headers: {}, problem: `no credential stored for slot '${headersEnv}'` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { headers: {}, problem: `credential stored for slot '${headersEnv}' is not valid JSON` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { headers: {}, problem: `credential stored for slot '${headersEnv}' must be a JSON object of headers` };
  }
  return { headers: parsed as Record<string, string> };
}

/** Posts an OTLP/HTTP log payload to `cfg.endpoint`. Knows nothing about the queue or retries. */
export function createOtelSink(cfg: OtelSinkConfig): SiemSink {
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
      if (!cfg.endpoint) {
        problems.push('endpoint is required');
        return problems;
      }
      let parsed: URL;
      try {
        parsed = new URL(cfg.endpoint);
      } catch {
        problems.push(`endpoint is not a valid URL: ${cfg.endpoint}`);
        return problems;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`endpoint scheme must be http or https, got ${parsed.protocol}`);
      }
      const { problem } = resolveHeaders(cfg, cfg.headersEnv);
      if (problem) {
        problems.push(problem);
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      if (!cfg.endpoint) return false;
      try {
        const { headers } = resolveHeaders(cfg, cfg.headersEnv);
        await axios.get(cfg.endpoint, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          validateStatus: () => true,
          // Never follow a redirect: extra headers (e.g. an Authorization value) would be
          // replayed to whatever host the Location points at.
          maxRedirects: 0,
          headers,
        });
        return true;
      } catch {
        return false;
      }
    },

    async send(batch: SiemEvent[]): Promise<void> {
      const { headers: extraHeaders } = resolveHeaders(cfg, cfg.headersEnv);
      let status: number;
      try {
        const response = await axios.post(
          cfg.endpoint,
          toOtlp(batch),
          {
            timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            // Handle every status ourselves so 4xx and 5xx can be told apart below,
            // rather than letting axios collapse all non-2xx into one thrown shape.
            validateStatus: () => true,
            // Never follow a redirect: extra headers would be replayed to whatever host the
            // Location points at, and axios does not strip credentials across hosts. A
            // redirecting collector is a misconfiguration to fix, not a hop to follow.
            maxRedirects: 0,
            headers: {
              'Content-Type': 'application/json',
              ...extraHeaders,
            },
          }
        );
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`OTel collector request failed: ${error.message}`, true);
      }

      if (status >= 200 && status < 300) {
        return;
      }
      // 429 (rate limited) and 408 (request timeout) are transient despite falling
      // in the 4xx range: the dispatcher should back off and retry, not give up.
      // Marking them non-retryable would silently drop events on rate limiting.
      if (status === 429 || status === 408) {
        throw new SinkError(`OTel collector returned ${status}`, true, status);
      }
      if (status >= 300 && status < 400) {
        throw new SinkError(`OTel collector redirected (${status}); redirects are not followed`, false, status);
      }
      if (status >= 400 && status < 500) {
        throw new SinkError(`OTel collector returned ${status}`, false, status);
      }
      throw new SinkError(`OTel collector returned ${status}`, true, status);
    },
  };
}
