import axios from 'axios';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, resolveSecret } from '../sink';
import type { SecretResolver } from '../secretResolver';

/**
 * Azure Monitor Logs Ingestion via a Data Collection Rule.
 *
 * Two calls per send when the cached token has expired: OAuth2 client-credentials against
 * the authority host, then POST to <dcrEndpoint>/dataCollectionRules/<id>/streams/<stream>.
 *
 * The token is cached and refreshed lazily on use — never on a timer. The SiemSink contract
 * has no close(), so a background timer inside a sink would leak on shutdown, and the
 * dispatcher already owns all scheduling.
 */
export interface AzureSentinelSinkConfig {
  name: string;
  /** Data Collection Endpoint host, e.g. 'https://dce.example.invalid'. */
  dcrEndpoint: string;
  dcrImmutableId: string;
  streamName: string;
  tenantId: string;
  clientId: string;
  /**
   * Name of the credential slot holding the client secret. Resolved via resolveSecret
   * (sink.ts) at token-acquisition time, not at construction — through the injected
   * getSecret — so a rotated secret is picked up without restarting the service. Never
   * read from api_config.json, which is tracked in three synced copies in this public repo.
   */
  clientSecretEnv: string;
  /**
   * Microsoft Entra authority host that issues the OAuth2 token, e.g.
   * 'https://login.microsoftonline.us' for a sovereign cloud. Defaults to
   * 'https://login.microsoftonline.com'.
   */
  authorityHost?: string;
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
   * Overrides `authorityHost` for token acquisition. Test-only, like Datadog's
   * `endpointOverride` — exists so tests can point the sink at a local token server;
   * never set this from api_config.json.
   */
  authorityHostOverride?: string;
  /** Injected secret resolver — see sink.ts's resolveSecret. No credential source if omitted. */
  getSecret?: SecretResolver;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';
const AZURE_MONITOR_SCOPE = 'https://monitor.azure.com/.default';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const INGEST_API_VERSION = '2023-01-01';

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function authorityHost(cfg: AzureSentinelSinkConfig): string {
  return cfg.authorityHostOverride ?? cfg.authorityHost ?? DEFAULT_AUTHORITY_HOST;
}

function tokenUrl(cfg: AzureSentinelSinkConfig): string {
  return `${authorityHost(cfg).replace(/\/$/, '')}/${cfg.tenantId}/oauth2/v2.0/token`;
}

function ingestUrl(cfg: AzureSentinelSinkConfig): string {
  return `${cfg.dcrEndpoint.replace(/\/$/, '')}/dataCollectionRules/${cfg.dcrImmutableId}/streams/${cfg.streamName}?api-version=${INGEST_API_VERSION}`;
}

/**
 * Maps an HTTP status to a SinkError with the standing retryable rule shared by every
 * sink: 5xx, 429, 408 transient; 3xx and other 4xx are not retrying-fixable.
 */
function mapHttpStatus(context: string, status: number): SinkError {
  if (status === 429 || status === 408) {
    return new SinkError(`${context} returned ${status}`, true, status);
  }
  if (status >= 300 && status < 400) {
    return new SinkError(`${context} redirected (${status}); redirects are not followed`, false, status);
  }
  if (status >= 400 && status < 500) {
    return new SinkError(`${context} returned ${status}`, false, status);
  }
  return new SinkError(`${context} returned ${status}`, true, status);
}

/**
 * Posts a batch to a Data Collection Rule via Azure Monitor Logs Ingestion. Knows nothing
 * about the queue or retries — see siem/dispatcher.ts for that.
 */
export function createAzureSentinelSink(cfg: AzureSentinelSinkConfig): SiemSink {
  let cachedToken: CachedToken | undefined;

  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return cachedToken.accessToken;
    }

    const clientSecret = resolveSecret(cfg, cfg.clientSecretEnv) ?? '';
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: clientSecret,
      scope: AZURE_MONITOR_SCOPE,
      grant_type: 'client_credentials',
    }).toString();

    let status: number;
    let data: any;
    try {
      const response = await axios.post(tokenUrl(cfg), body, {
        timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Handle every status ourselves so 401 (bad secret, non-retryable) and 5xx
        // (transient) can be told apart below, rather than letting axios collapse all
        // non-2xx into one thrown shape.
        validateStatus: () => true,
        // Never follow a redirect: the client secret would be replayed to whatever host
        // the Location points at.
        maxRedirects: 0,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      status = response.status;
      data = response.data;
    } catch (error: any) {
      // No HTTP response at all (DNS, connection refused, timeout) — transient.
      throw new SinkError(`Azure Sentinel token request failed: ${error.message}`, true);
    }

    if (status < 200 || status >= 300) {
      throw mapHttpStatus('Azure Sentinel token endpoint', status);
    }

    const accessToken = data?.access_token;
    if (!accessToken) {
      // A 2xx with no access_token is a malformed response, not something retrying fixes.
      throw new SinkError('Azure Sentinel token response did not contain access_token', false, status);
    }
    const expiresInSeconds = typeof data?.expires_in === 'number' ? data.expires_in : 3600;
    cachedToken = { accessToken, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
    return accessToken;
  }

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
      if (!cfg.dcrEndpoint) {
        problems.push('dcrEndpoint is required');
      } else {
        try {
          const parsed = new URL(cfg.dcrEndpoint);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            problems.push(`dcrEndpoint scheme must be http or https, got ${parsed.protocol}`);
          }
        } catch {
          problems.push(`dcrEndpoint is not a valid URL: ${cfg.dcrEndpoint}`);
        }
      }
      if (!cfg.dcrImmutableId) {
        problems.push('dcrImmutableId is required');
      }
      if (!cfg.streamName) {
        problems.push('streamName is required');
      }
      if (!cfg.tenantId) {
        problems.push('tenantId is required');
      }
      if (!cfg.clientId) {
        problems.push('clientId is required');
      }
      if (!cfg.clientSecretEnv) {
        problems.push('clientSecretEnv is required');
      } else if (!resolveSecret(cfg, cfg.clientSecretEnv)) {
        problems.push(`no credential stored for slot '${cfg.clientSecretEnv}'`);
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      if (!cfg.dcrEndpoint) return false;
      try {
        await axios.get(cfg.dcrEndpoint, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          validateStatus: () => true,
          // Never follow a redirect, consistent with send() below.
          maxRedirects: 0,
        });
        return true;
      } catch {
        return false;
      }
    },

    async send(batch: SiemEvent[]): Promise<void> {
      const accessToken = await getAccessToken();

      let status: number;
      try {
        const response = await axios.post(ingestUrl(cfg), batch, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // Handle every status ourselves so 4xx and 5xx can be told apart below, rather
          // than letting axios collapse all non-2xx into one thrown shape.
          validateStatus: () => true,
          // Never follow a redirect: the bearer token would be replayed to whatever host
          // the Location points at, and axios does not strip credentials across hosts. A
          // redirecting DCE is a misconfiguration to fix, not a hop to follow.
          maxRedirects: 0,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`Azure Sentinel ingestion request failed: ${error.message}`, true);
      }

      // The Logs Ingestion API returns 204 (No Content) on success, not 200 — some Data
      // Collection Rules return 200 instead, and the DCE may also accept with 202. Any 2xx
      // means the batch landed, matching the other five sinks' success test.
      if (status >= 200 && status < 300) {
        return;
      }
      throw mapHttpStatus('Azure Sentinel ingestion endpoint', status);
    },
  };
}
