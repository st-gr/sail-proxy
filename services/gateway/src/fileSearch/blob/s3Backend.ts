import axios from 'axios';
import * as crypto from 'crypto';
import { BlobBackend } from './blobStore';
import { buildS3AuthHeader } from '@libs/aws-signing/s3Signer';

/**
 * S3 (or S3-compatible) blob backend.
 *
 * Safety properties, each pinned by test/fileSearch/s3Backend.{requests,confinement}.test.ts:
 * - Every request has a hard wall-clock deadline (AbortSignal.timeout). GET also
 *   has an idle timeout (axios `timeout`: time to response headers, then socket
 *   inactivity); axios `timeout` alone never stops a slowly trickling body.
 * - A connection reset (stale keep-alive socket) is retried once within the same
 *   deadline; all operations are idempotent.
 * - Redirects are never followed (`maxRedirects: 0`): the signed Authorization
 *   header would be replayed to the Location host. A 3xx is an error.
 * - Confinement: the bucket may be shared, so the backend only ever addresses
 *   object keys under `<prefix>/`. There is no bucket-level request at all: no
 *   HeadBucket, list, bucket delete, policy or lifecycle call. Reachability is
 *   checked by `probe()`, a PUT and GET of a fixed object under the prefix.
 * - Errors carry operation, HTTP status and an S3/network code only: no URL,
 *   no headers, no axios error as `cause`.
 * - `location` is the logical object key; endpoint and bucket come from the
 *   config at call time.
 */

const SHA_RE = /^[0-9a-f]{64}$/;
// AWS bucket naming rules: 3-63 chars of [a-z0-9.-], alphanumeric at both ends, no "..", ".-"
// or "-.", not an IPv4 address, and none of the reserved prefixes/suffixes.
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const BUCKET_FORBIDDEN_RE = /\.\.|\.-|-\.|^\d+\.\d+\.\d+\.\d+$|^xn--|^sthree-|^amzn-s3-demo-|-s3alias$|--ol-s3$|\.mrap$|--x-s3$|--table-s3$/;
// Plain segments only, so the request path needs no percent-encoding and the
// signed canonical URI equals the path sent.
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const ERROR_CODE_RE = /<Code>([A-Za-z0-9_.-]{1,64})<\/Code>/;
const NETWORK_CODE_RE = /^E[A-Z0-9_]{2,40}$/;

/**
 * The largest GET body accepted when the caller passes no expected size (callers pass the blob's
 * size plus a margin: see blobStore.maxGetBytes). A larger response is refused, never buffered.
 */
export const S3_FALLBACK_MAX_GET_BYTES = 1024 * 1024 * 1024;

/**
 * Every response may carry at least this much, whatever the caller expects: an S3 error reply (an
 * XML body of a few hundred bytes) must always be read in full, so a 403 or 404 is reported as
 * itself and never as an oversized body. A 2xx body is checked against the caller's own limit.
 */
export const S3_MIN_RESPONSE_BYTES = 64 * 1024;

export const S3_DEFAULT_TIMEOUTS = { metadataMs: 10_000, transferMs: 120_000, idleMs: 30_000 };
export type S3Timeouts = typeof S3_DEFAULT_TIMEOUTS;

export interface S3BackendConfig {
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
}

export type S3Operation = 'PutObject' | 'GetObject' | 'DeleteObject' | 'HeadObject';

/**
 * The fixed content of the reachability probe. It is stored like any blob, at its content-addressed
 * key under the prefix, and never deleted: a user file with identical bytes would share that key,
 * and a PUT of identical bytes is a no-op for it.
 */
export const S3_PROBE_CONTENT = Buffer.from('sail-proxy file_search connection probe v1\n', 'utf8');

export interface S3Backend extends BlobBackend {
  /**
   * `location` (optional): the stored logical key, checked against the configured prefix.
   * `maxBytes`: the largest body accepted (default S3_FALLBACK_MAX_GET_BYTES); a larger one fails
   * with S3RequestError code `response_too_large`.
   */
  get(sha256: string, location?: string | null, maxBytes?: number): Promise<Buffer | null>;
  delete(sha256: string, location?: string | null): Promise<void>;
  exists(sha256: string, location?: string | null): Promise<boolean>;
  /**
   * Reachability check with exactly the permissions file_search needs: PUT the fixed probe object
   * (S3_PROBE_CONTENT) at its content-addressed key under the prefix, GET it back and check its
   * SHA-256. Throws S3RequestError (a wrong or missing read-back: GetObject `probe_mismatch` /
   * `probe_missing`). The object is left in place.
   */
  probe(): Promise<void>;
  /** The logical key (what put returns as `location`) for a sha. */
  keyFor(sha256: string): string;
}

/** The blob_storage.s3 configuration is unusable. */
export class S3ConfigError extends Error {
  constructor(message: string) {
    super(`blob_storage.s3: ${message}`);
    this.name = 'S3ConfigError';
  }
}

/** A stored location does not address this sha under the configured prefix. */
export class S3LocationError extends Error {
  constructor() {
    super('stored S3 location is not this blob\'s key under the configured prefix');
    this.name = 'S3LocationError';
  }
}

export class S3RequestError extends Error {
  constructor(
    readonly op: S3Operation,
    readonly status: number | null,
    readonly code: string,
    /** S3's `x-amz-bucket-region` hint, sent with a wrong-region 301. */
    readonly bucketRegion?: string,
  ) {
    super(`S3 ${op} failed: ${status === null ? '' : `HTTP ${status} `}${code}`);
    this.name = 'S3RequestError';
  }
}

interface SendResult {
  status: number;
  data: unknown;
  bucketRegion?: string;
}

interface Resolved {
  bucket: string;
  prefix: string;
  region: string;
  /** Path-style base (no trailing slash), or null for AWS virtual-host addressing. */
  endpoint: string | null;
}

function resolveConfig(cfg: S3BackendConfig): Resolved {
  if (!BUCKET_RE.test(cfg.bucket ?? '') || BUCKET_FORBIDDEN_RE.test(cfg.bucket)) throw new S3ConfigError('bucket is missing or not a valid bucket name');
  if (!cfg.region) throw new S3ConfigError('region is required');
  const prefix = (cfg.prefix ?? '').replace(/\/+$/, '');
  if (!prefix) throw new S3ConfigError('prefix is required (the backend writes only under it)');
  for (const segment of prefix.split('/')) {
    if (!PREFIX_SEGMENT_RE.test(segment) || segment === '.' || segment === '..') {
      throw new S3ConfigError('prefix must be relative path segments of letters, digits, ".", "_" or "-"');
    }
  }
  let endpoint: string | null = null;
  if (cfg.endpoint) {
    let url: URL;
    try {
      url = new URL(cfg.endpoint);
    } catch {
      throw new S3ConfigError('endpoint is not a URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new S3ConfigError('endpoint must be http(s)');
    if (url.username || url.password) throw new S3ConfigError('endpoint must not contain credentials');
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new S3ConfigError('endpoint must be scheme://host[:port] without a path or query');
    }
    endpoint = `${url.protocol}//${url.host}`;
  }
  return { bucket: cfg.bucket, prefix, region: cfg.region, endpoint };
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Injected credentials win; the product env vars are read only when none were given. */
function credentials(injected?: S3Credentials): S3Credentials {
  if (injected) {
    if (!injected.accessKeyId || !injected.secretAccessKey) throw new S3ConfigError('the injected S3 credentials are incomplete');
    return injected;
  }
  const accessKeyId = process.env.FILE_SEARCH_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new S3ConfigError('FILE_SEARCH_S3_ACCESS_KEY_ID / FILE_SEARCH_S3_SECRET_ACCESS_KEY are not configured');
  }
  return { accessKeyId, secretAccessKey };
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function errorCodeFrom(data: unknown): string | null {
  if (!Buffer.isBuffer(data) && typeof data !== 'string') return null;
  const text = (Buffer.isBuffer(data) ? data : Buffer.from(data)).subarray(0, 4096).toString('utf8');
  return ERROR_CODE_RE.exec(text)?.[1] ?? null;
}

/**
 * `opts.credentials`: keys to sign with instead of FILE_SEARCH_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY.
 * Tests always inject theirs, so no test needs the product variables in its environment.
 */
export function createS3Backend(
  cfg: S3BackendConfig, opts: { timeouts?: S3Timeouts; credentials?: S3Credentials } = {},
): S3Backend {
  const c = resolveConfig(cfg);
  const timeouts = opts.timeouts ?? S3_DEFAULT_TIMEOUTS;

  function keyFor(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error('Invalid sha256 key');
    return `${c.prefix}/${sha.slice(0, 2)}/${sha}`;
  }

  /** The key to address: derived from the sha; a stored location must equal it. */
  function keyAt(sha: string, location?: string | null): string {
    const key = keyFor(sha);
    if (!location) return key;
    let stored = location;
    if (location.includes('://')) {
      // Legacy absolute URL (path- or virtual-host style): take the path only;
      // the stored host is never contacted.
      let path: string;
      try {
        path = decodeURIComponent(new URL(location).pathname).replace(/^\//, '');
      } catch {
        throw new S3LocationError();
      }
      stored = path.startsWith(`${c.bucket}/`) && path !== key ? path.slice(c.bucket.length + 1) : path;
    }
    if (stored !== key) throw new S3LocationError();
    return key;
  }

  function target(key: string): { url: string; host: string; pathname: string } {
    if (c.endpoint) {
      const pathname = `/${c.bucket}/${key}`;
      return { url: `${c.endpoint}${pathname}`, host: new URL(c.endpoint).host, pathname };
    }
    const host = `${c.bucket}.s3.${c.region}.amazonaws.com`;
    const pathname = `/${key}`;
    return { url: `https://${host}${pathname}`, host, pathname };
  }

  async function send(
    op: S3Operation, method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', key: string,
    body: Buffer | undefined, extraHeaders: Record<string, string> = {}, maxResponseBytes = S3_FALLBACK_MAX_GET_BYTES,
  ): Promise<SendResult> {
    const { url, host, pathname } = target(key);
    const { accessKeyId, secretAccessKey } = credentials(opts.credentials);
    const payload = body ?? Buffer.alloc(0);
    const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const amzDate = amzDateNow();
    const authorization = buildS3AuthHeader({
      method, host, pathname, payloadSha256, accessKeyId, secretAccessKey, region: c.region, amzDate,
    });
    const deadlineMs = op === 'PutObject' || op === 'GetObject' ? timeouts.transferMs : timeouts.metadataMs;
    // axios `timeout` (native transport, maxRedirects 0) is a wall-clock timer until response
    // headers, then socket idle. Before headers a PUT is still uploading, so it would cap the
    // upload at idleMs: only GET (download) gets the idle timer; everything else runs on the
    // deadline alone, which also makes the timer that fires deterministic.
    const idleMs = op === 'GetObject' && timeouts.idleMs < deadlineMs ? timeouts.idleMs : 0;
    const signal = AbortSignal.timeout(deadlineMs);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await axios.request({
          method, url, data: body,
          headers: { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256, authorization, ...extraHeaders },
          responseType: 'arraybuffer',
          signal,
          timeout: idleMs,
          maxRedirects: 0,
          validateStatus: () => true,
          maxBodyLength: Infinity,
          maxContentLength: Math.max(maxResponseBytes, S3_MIN_RESPONSE_BYTES),
        });
        break;
      } catch (e: any) {
        if (signal.aborted) throw new S3RequestError(op, null, 'deadline_exceeded');
        if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') throw new S3RequestError(op, null, 'idle_timeout');
        // axios refuses a body over maxContentLength (ERR_BAD_RESPONSE, "maxContentLength size of …").
        if (e?.code === 'ERR_BAD_RESPONSE' && /maxContentLength/.test(String(e?.message))) {
          throw new S3RequestError(op, null, 'response_too_large');
        }
        // A keep-alive socket the server already closed: every operation here is idempotent,
        // so one retry, still inside the same deadline.
        if (attempt === 0 && (e?.code === 'ECONNRESET' || e?.code === 'EPIPE')) continue;
        const code = typeof e?.code === 'string' && NETWORK_CODE_RE.test(e.code) ? e.code : 'network_error';
        throw new S3RequestError(op, null, code);
      }
    }
    const status = res.status;
    const region = res.headers?.['x-amz-bucket-region'];
    const bucketRegion = typeof region === 'string' && /^[a-z0-9-]{1,32}$/.test(region) ? region : undefined;
    if (status >= 300 && status < 400) throw new S3RequestError(op, status, 'redirect', bucketRegion);
    return { status, data: res.data, bucketRegion };
  }

  function fail(op: S3Operation, r: SendResult): never {
    // S3 also sends x-amz-bucket-region on a wrong-region 400/403 (a HEAD has no body).
    throw new S3RequestError(op, r.status, errorCodeFrom(r.data) ?? `http_${r.status}`, r.bucketRegion);
  }

  const ok = (status: number) => status >= 200 && status < 300;

  const backend: S3Backend = {
    keyFor,
    async put(sha, bytes, mime) {
      const key = keyFor(sha);
      const r = await send('PutObject', 'PUT', key, bytes, { 'content-type': mime || 'application/octet-stream' });
      if (!ok(r.status)) fail('PutObject', r);
      return { location: key };
    },
    async get(sha, location, maxBytes = S3_FALLBACK_MAX_GET_BYTES) {
      const r = await send('GetObject', 'GET', keyAt(sha, location), undefined, {}, maxBytes);
      if (r.status === 404) return null;
      if (!ok(r.status)) fail('GetObject', r);
      const body = Buffer.from(r.data as ArrayBuffer);
      // The transport allows S3_MIN_RESPONSE_BYTES for error replies; the object itself gets the caller's limit.
      if (body.length > maxBytes) throw new S3RequestError('GetObject', r.status, 'response_too_large');
      return body;
    },
    async delete(sha, location) {
      const r = await send('DeleteObject', 'DELETE', keyAt(sha, location), undefined);
      if (r.status === 404 || ok(r.status)) return;
      fail('DeleteObject', r);
    },
    async exists(sha, location) {
      const r = await send('HeadObject', 'HEAD', keyAt(sha, location), undefined);
      if (r.status === 404) return false;
      if (!ok(r.status)) fail('HeadObject', r);
      return true;
    },
    async probe() {
      const sha = crypto.createHash('sha256').update(S3_PROBE_CONTENT).digest('hex');
      await backend.put(sha, S3_PROBE_CONTENT, 'application/octet-stream');
      const back = await backend.get(sha, null, S3_PROBE_CONTENT.length);
      if (back === null) throw new S3RequestError('GetObject', 404, 'probe_missing');
      if (crypto.createHash('sha256').update(back).digest('hex') !== sha) {
        throw new S3RequestError('GetObject', 200, 'probe_mismatch');
      }
    },
  };
  return backend;
}
