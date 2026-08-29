import axios from 'axios';
import jwt from 'jsonwebtoken';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, resolveSecret, safeStringify } from '../sink';
import type { SecretResolver } from '../secretResolver';

/**
 * Google Cloud Pub/Sub publish.
 *
 * Auth is a self-signed RS256 JWT exchanged for an access token — `jsonwebtoken` is already
 * a dependency, so no google-auth-library is needed. The token is cached and refreshed
 * lazily on use, never on a timer (the SiemSink contract has no close()).
 *
 * The reference implementation publishes one message per request; we publish the whole batch
 * in one call, which the API supports and which matches how our dispatcher batches.
 */
export interface GcsPubSubSinkConfig {
  name: string;
  projectId: string;
  topicId: string;
  /**
   * Name of the credential slot holding the service-account JSON key. Resolved via
   * resolveSecret (sink.ts) at token-acquisition time, not at construction — through the
   * injected getSecret — so a rotated key is picked up without restarting the service.
   * Parsed defensively — a missing credential or malformed/incomplete JSON surfaces as a
   * validateConfig() problem, never a throw at send time. Never read from api_config.json,
   * which is tracked in three synced copies in this public repo.
   */
  serviceAccountJsonEnv: string;
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
   * Overrides `https://oauth2.googleapis.com/token`. Test-only, like Azure's
   * `authorityHostOverride` — exists so tests can point the sink at a local token server;
   * never set this from api_config.json.
   */
  tokenUrlOverride?: string;
  /**
   * Overrides the computed `https://pubsub.googleapis.com/v1/projects/<project>/topics/<topic>:publish`
   * URL. Test-only, like Datadog's `endpointOverride`; never set this from api_config.json.
   */
  publishUrlOverride?: string;
  /** Injected secret resolver — see sink.ts's resolveSecret. No credential source if omitted. */
  getSecret?: SecretResolver;
}

const DEFAULT_TIMEOUT_MS = 5000;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const JWT_LIFETIME_SECONDS = 3600;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function tokenUrl(cfg: GcsPubSubSinkConfig): string {
  return cfg.tokenUrlOverride ?? GOOGLE_TOKEN_URL;
}

function publishUrl(cfg: GcsPubSubSinkConfig): string {
  return cfg.publishUrlOverride
    ?? `https://pubsub.googleapis.com/v1/projects/${cfg.projectId}/topics/${cfg.topicId}:publish`;
}

/**
 * Parses the service-account JSON resolved via resolveSecret (sink.ts). Never throws:
 * an unset var, malformed JSON, or JSON missing the fields we sign with is reported back as
 * a problem string for validateConfig() to surface, rather than blowing up at send time.
 */
function resolveServiceAccount(
  cfg: GcsPubSubSinkConfig,
  serviceAccountJsonEnv: string
): { account?: ServiceAccount; problem?: string } {
  const raw = resolveSecret(cfg, serviceAccountJsonEnv);
  if (!raw) {
    return { problem: `no credential stored for slot '${serviceAccountJsonEnv}'` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problem: `credential stored for slot '${serviceAccountJsonEnv}' is not valid JSON` };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.client_email !== 'string' || !parsed.client_email) {
    return { problem: `credential stored for slot '${serviceAccountJsonEnv}' is missing client_email` };
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key) {
    return { problem: `credential stored for slot '${serviceAccountJsonEnv}' is missing private_key` };
  }
  return { account: { client_email: parsed.client_email, private_key: parsed.private_key } };
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

function toPublishBody(batch: SiemEvent[]) {
  return {
    messages: batch.map(e => ({ data: Buffer.from(safeStringify(e), 'utf8').toString('base64') })),
  };
}

/**
 * Publishes a batch to a Google Cloud Pub/Sub topic. Knows nothing about the queue or
 * retries — see siem/dispatcher.ts for that.
 */
export function createGcsPubSubSink(cfg: GcsPubSubSinkConfig): SiemSink {
  let cachedToken: CachedToken | undefined;

  async function getAccessToken(account: ServiceAccount): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return cachedToken.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: account.client_email,
        sub: account.client_email,
        aud: tokenUrl(cfg),
        scope: PUBSUB_SCOPE,
        iat: now,
        exp: now + JWT_LIFETIME_SECONDS,
      },
      account.private_key,
      { algorithm: 'RS256' }
    );

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();

    let status: number;
    let data: any;
    try {
      const response = await axios.post(tokenUrl(cfg), body, {
        timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Handle every status ourselves so 401 (bad key, non-retryable) and 5xx
        // (transient) can be told apart below, rather than letting axios collapse all
        // non-2xx into one thrown shape.
        validateStatus: () => true,
        // Never follow a redirect: the signed assertion would be replayed to whatever
        // host the Location points at.
        maxRedirects: 0,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      status = response.status;
      data = response.data;
    } catch (error: any) {
      // No HTTP response at all (DNS, connection refused, timeout) — transient.
      throw new SinkError(`GCS Pub/Sub token request failed: ${error.message}`, true);
    }

    if (status < 200 || status >= 300) {
      throw mapHttpStatus('GCS Pub/Sub token endpoint', status);
    }

    const accessToken = data?.access_token;
    if (!accessToken) {
      // A 2xx with no access_token is a malformed response, not something retrying fixes.
      throw new SinkError('GCS Pub/Sub token response did not contain access_token', false, status);
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
      if (!cfg.projectId) {
        problems.push('projectId is required');
      }
      if (!cfg.topicId) {
        problems.push('topicId is required');
      }
      if (!cfg.serviceAccountJsonEnv) {
        problems.push('serviceAccountJsonEnv is required');
      } else {
        const { problem } = resolveServiceAccount(cfg, cfg.serviceAccountJsonEnv);
        if (problem) {
          problems.push(problem);
        }
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      if (!cfg.projectId || !cfg.topicId) return false;
      try {
        await axios.get(publishUrl(cfg), {
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
      const { account, problem } = resolveServiceAccount(cfg, cfg.serviceAccountJsonEnv);
      if (!account) {
        // A malformed or missing service-account key cannot be fixed by retrying.
        throw new SinkError(`GCS Pub/Sub service account is not usable: ${problem}`, false);
      }
      const accessToken = await getAccessToken(account);

      let status: number;
      try {
        const response = await axios.post(publishUrl(cfg), toPublishBody(batch), {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // Handle every status ourselves so 4xx and 5xx can be told apart below, rather
          // than letting axios collapse all non-2xx into one thrown shape.
          validateStatus: () => true,
          // Never follow a redirect: the bearer token would be replayed to whatever host
          // the Location points at, and axios does not strip credentials across hosts. A
          // redirecting publish endpoint is a misconfiguration to fix, not a hop to follow.
          maxRedirects: 0,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`GCS Pub/Sub publish request failed: ${error.message}`, true);
      }

      if (status >= 200 && status < 300) {
        return;
      }
      throw mapHttpStatus('GCS Pub/Sub publish endpoint', status);
    },
  };
}
