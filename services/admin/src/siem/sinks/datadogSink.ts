import axios from 'axios';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, resolveSecret, safeStringify } from '../sink';
import type { SecretResolver } from '../secretResolver';

export interface DatadogSinkConfig {
  name: string;
  /**
   * Datadog regional site the org is hosted on, e.g. 'datadoghq.com', 'datadoghq.eu'.
   * Defaults to 'datadoghq.com'. An EU-hosted org sending to the US intake gets a
   * confusing 403 that looks like a bad API key.
   */
  site?: string;
  /**
   * Name of the credential slot holding the Datadog API key. Resolved via resolveSecret
   * (sink.ts) at send time, not at construction — through the injected getSecret — so a
   * rotated key is picked up without restarting the service. Never read from
   * api_config.json, which is tracked in three synced copies in this public repo.
   */
  apiKeyEnv: string;
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
  /**
   * Overrides the computed `https://http-intake.logs.<site>/api/v2/logs` URL. Exists
   * only so tests can point the sink at a local server; never set this from
   * api_config.json.
   */
  endpointOverride?: string;
  /** Injected secret resolver — see sink.ts's resolveSecret. No credential source if omitted. */
  getSecret?: SecretResolver;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SITE = 'datadoghq.com';

/** Datadog regional sites. An EU-hosted org sending to the US intake gets a confusing 403. */
const DATADOG_SITES = ['datadoghq.com', 'datadoghq.eu', 'us3.datadoghq.com', 'us5.datadoghq.com', 'ddog-gov.com'];

function intakeUrl(cfg: DatadogSinkConfig): string {
  if (cfg.endpointOverride) return cfg.endpointOverride;
  return `https://http-intake.logs.${cfg.site ?? DEFAULT_SITE}/api/v2/logs`;
}

function toDatadogRecords(batch: SiemEvent[]) {
  return batch.map(e => ({
    ddsource: 'sail-proxy',
    ddtags: `category:${e.category},type:${e.type},outcome:${e.outcome}`,
    service: 'sail-proxy',
    // Datadog indexes `message`; the structured event travels alongside it so both
    // full-text search and attribute queries work.
    message: safeStringify(e),
    status: e.severity,
    siem: e,
  }));
}

/** Posts a JSON array of log records to Datadog's logs intake. Knows nothing about the queue or retries. */
export function createDatadogSink(cfg: DatadogSinkConfig): SiemSink {
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
      if (!cfg.apiKeyEnv) {
        problems.push('apiKeyEnv is required');
      } else if (!resolveSecret(cfg, cfg.apiKeyEnv)) {
        problems.push(`no credential stored for slot '${cfg.apiKeyEnv}'`);
      }
      const site = cfg.site ?? DEFAULT_SITE;
      if (!DATADOG_SITES.includes(site)) {
        problems.push(`site '${site}' is not a known Datadog site (expected one of ${DATADOG_SITES.join(', ')})`);
      }
      let parsed: URL;
      try {
        parsed = new URL(intakeUrl(cfg));
      } catch {
        problems.push(`endpointOverride is not a valid URL: ${cfg.endpointOverride}`);
        return problems;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`endpoint scheme must be http or https, got ${parsed.protocol}`);
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      try {
        await axios.get(intakeUrl(cfg), {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          validateStatus: () => true,
          // Never follow a redirect: the DD-API-KEY header would be replayed to
          // whatever host the Location points at.
          maxRedirects: 0,
          headers: { 'DD-API-KEY': resolveSecret(cfg, cfg.apiKeyEnv) ?? '' },
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
          intakeUrl(cfg),
          toDatadogRecords(batch),
          {
            timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            // Handle every status ourselves so 4xx and 5xx can be told apart below,
            // rather than letting axios collapse all non-2xx into one thrown shape.
            validateStatus: () => true,
            // Never follow a redirect: the DD-API-KEY header would be replayed to
            // whatever host the Location points at, and axios does not strip
            // credentials across hosts. A redirecting intake is a misconfiguration
            // to fix, not a hop to follow.
            maxRedirects: 0,
            headers: {
              'Content-Type': 'application/json',
              'DD-API-KEY': resolveSecret(cfg, cfg.apiKeyEnv) ?? '',
            },
          }
        );
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`Datadog request failed: ${error.message}`, true);
      }

      // Success is 202 (Accepted), not 200 — the intake queues the batch rather than
      // indexing it synchronously. Treating only 200 as success would report every
      // successful send as a failure and cause the dispatcher to retry events that
      // already landed.
      if (status >= 200 && status < 300) {
        return;
      }
      // 429 (rate limited) and 408 (request timeout) are transient despite falling
      // in the 4xx range: the dispatcher should back off and retry, not give up.
      // Marking them non-retryable would silently drop events on rate limiting.
      if (status === 429 || status === 408) {
        throw new SinkError(`Datadog returned ${status}`, true, status);
      }
      if (status >= 300 && status < 400) {
        throw new SinkError(`Datadog redirected (${status}); redirects are not followed`, false, status);
      }
      if (status >= 400 && status < 500) {
        throw new SinkError(`Datadog returned ${status}`, false, status);
      }
      throw new SinkError(`Datadog returned ${status}`, true, status);
    },
  };
}
