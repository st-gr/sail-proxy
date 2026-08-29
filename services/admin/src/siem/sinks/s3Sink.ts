import axios from 'axios';
import * as crypto from 'crypto';
import { buildS3AuthHeader } from '@libs/aws-signing/s3Signer';
import { SiemEvent } from '../siemEvent';
import { SiemSink, SinkError, resolveSecret, safeStringify } from '../sink';
import type { SecretResolver } from '../secretResolver';

/**
 * Newline-delimited JSON objects in S3 — one object per batch, one SiemEvent per line.
 *
 * Signed with the repo's existing SigV4 signer (libs/aws-signing/s3Signer.ts, already used by
 * file_search's blob store) rather than an AWS SDK: no new dependency, and the sink stays on
 * axios like its five siblings.
 *
 * S3 is an archive a SIEM ingests from, not a SIEM itself, which is why its config ships a
 * larger batch_size and longer interval_ms than the HTTP sinks — fewer, bigger objects.
 */
export interface S3SinkConfig {
  name: string;
  bucket: string;
  region: string;
  /** Key prefix objects are written under, e.g. 'sail-proxy/siem'. Defaults to no prefix. */
  prefix?: string;
  /**
   * Name of the credential slot holding the AWS access key ID. Resolved via resolveSecret
   * (sink.ts) at send time, not at construction — through the injected getSecret — so a
   * rotated key is picked up without restarting the service. Never read from
   * api_config.json, which is tracked in three synced copies in this public repo.
   */
  accessKeyIdEnv: string;
  /** Name of the credential slot holding the AWS secret access key. Same resolution rules as accessKeyIdEnv. */
  secretAccessKeyEnv: string;
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
   * Overrides the computed `https://<bucket>.s3.<region>.amazonaws.com` endpoint with a
   * path-style base (`<override>/<bucket>/<key>`). Test-only, like Datadog's
   * `endpointOverride`; never set this from api_config.json.
   */
  endpointOverride?: string;
  /** Injected secret resolver — see sink.ts's resolveSecret. No credential source if omitted. */
  getSecret?: SecretResolver;
}

const DEFAULT_TIMEOUT_MS = 5000;

function objectKey(prefix: string): string {
  const now = new Date();
  const p = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
  ].join('/');
  const trimmedPrefix = prefix.replace(/\/+$/, '');
  return `${trimmedPrefix ? `${trimmedPrefix}/` : ''}${p}/${crypto.randomUUID()}.ndjson`;
}

function locate(cfg: S3SinkConfig, key: string): { url: string; host: string; pathname: string } {
  if (cfg.endpointOverride) {
    const base = cfg.endpointOverride.replace(/\/+$/, '');
    const host = new URL(base).host;
    const pathname = `/${cfg.bucket}/${key}`;
    return { host, pathname, url: `${base}${pathname}` };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const pathname = `/${key}`;
  return { host, pathname, url: `https://${host}${pathname}` };
}

function credentials(cfg: S3SinkConfig): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: resolveSecret(cfg, cfg.accessKeyIdEnv) ?? '',
    secretAccessKey: resolveSecret(cfg, cfg.secretAccessKeyEnv) ?? '',
  };
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function toNdjson(batch: SiemEvent[]): Buffer {
  return Buffer.from(batch.map(e => safeStringify(e)).join('\n') + '\n', 'utf8');
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
 * PUTs one newline-delimited JSON object per send under a time-partitioned key. Knows
 * nothing about the queue or retries — see siem/dispatcher.ts for that.
 */
export function createS3Sink(cfg: S3SinkConfig): SiemSink {
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
      if (!cfg.bucket) {
        problems.push('bucket is required');
      }
      if (!cfg.region) {
        problems.push('region is required');
      }
      if (!cfg.accessKeyIdEnv) {
        problems.push('accessKeyIdEnv is required');
      } else if (!resolveSecret(cfg, cfg.accessKeyIdEnv)) {
        problems.push(`no credential stored for slot '${cfg.accessKeyIdEnv}'`);
      }
      if (!cfg.secretAccessKeyEnv) {
        problems.push('secretAccessKeyEnv is required');
      } else if (!resolveSecret(cfg, cfg.secretAccessKeyEnv)) {
        problems.push(`no credential stored for slot '${cfg.secretAccessKeyEnv}'`);
      }
      return problems;
    },

    async healthCheck(): Promise<boolean> {
      if (!cfg.bucket || !cfg.region) return false;
      const { accessKeyId, secretAccessKey } = credentials(cfg);
      if (!accessKeyId || !secretAccessKey) return false;
      try {
        const { url, host, pathname } = locate(cfg, '');
        const amzDate = amzDateNow();
        const payloadSha256 = crypto.createHash('sha256').update('').digest('hex');
        const authorization = buildS3AuthHeader({
          method: 'GET', host, pathname, payloadSha256, accessKeyId, secretAccessKey,
          region: cfg.region, amzDate,
        });
        await axios.get(url, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          validateStatus: () => true,
          // Never follow a redirect, consistent with send() below.
          maxRedirects: 0,
          headers: { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256, authorization },
        });
        return true;
      } catch {
        return false;
      }
    },

    async send(batch: SiemEvent[]): Promise<void> {
      const { accessKeyId, secretAccessKey } = credentials(cfg);
      const body = toNdjson(batch);
      // Sign the exact bytes being sent: compute the body once, hash it once, and use that
      // same hash for both the x-amz-content-sha256 header and the signer's payloadSha256.
      // A mismatch is accepted by a local stub but rejected by real S3.
      const payloadSha256 = crypto.createHash('sha256').update(body).digest('hex');
      const key = objectKey(cfg.prefix ?? '');
      const { url, host, pathname } = locate(cfg, key);
      const amzDate = amzDateNow();
      const authorization = buildS3AuthHeader({
        method: 'PUT', host, pathname, payloadSha256, accessKeyId, secretAccessKey,
        region: cfg.region, amzDate,
      });

      let status: number;
      try {
        const response = await axios.put(url, body, {
          timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // Handle every status ourselves so 4xx and 5xx can be told apart below, rather
          // than letting axios collapse all non-2xx into one thrown shape.
          validateStatus: () => true,
          // Never follow a redirect: the Authorization header would be replayed to
          // whatever host the Location points at, and axios does not strip credentials
          // across hosts. A redirecting bucket endpoint is a misconfiguration to fix, not
          // a hop to follow.
          maxRedirects: 0,
          headers: {
            host,
            'content-type': 'application/x-ndjson',
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadSha256,
            authorization,
          },
        });
        status = response.status;
      } catch (error: any) {
        // No HTTP response at all (DNS, connection refused, timeout) — transient.
        throw new SinkError(`S3 PutObject request failed: ${error.message}`, true);
      }

      if (status >= 200 && status < 300) {
        return;
      }
      throw mapHttpStatus('S3 PutObject', status);
    },
  };
}
