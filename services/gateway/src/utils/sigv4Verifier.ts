/**
 * AWS Signature Version 4 verification for requests the gateway authenticates itself.
 *
 * Extracted from the former, never-mounted middlewares/awsSigV4Auth.ts, keeping its request variants:
 * the Host header as received, without its port, and the original Bedrock hosts; the
 * service from the credential scope and its bedrock <-> bedrock-runtime alternative; and
 * the path with and without the /aws-bedrock mount prefix (taken from req.originalUrl).
 * Behind nginx, also the path under an allowed X-Forwarded-Prefix (default /gateway) and the
 * host from X-Forwarded-Host.
 *
 * The verifier never sees an AWS secret. It asks a SigningKeyProvider for the day-scoped
 * signing key (kSigning) of each scope it tries, so the key's source (local credential
 * store, admin service) stays outside this module. Nothing here logs a key, a signature or
 * the Authorization header.
 */
import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const EMPTY_PAYLOAD_HASH = crypto.createHash('sha256').update('').digest('hex');
// Forwarded values only add variants (a signature still has to verify), but only well-formed ones.
const FORWARDED_PREFIX = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const FORWARDED_HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
// nginx only ever sets /gateway; a well-formed but different prefix must not widen the path variants.
const ALLOWED_FORWARDED_PREFIXES = ['/gateway'];

export interface ParsedSigV4Header {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

export interface SigningScope {
  date: string;
  region: string;
  service: string;
}

export interface SigningKeyProvider {
  /** kSigning for the scope, or null when the access key id has no usable secret. */
  getSigningKey(accessKeyId: string, scope: SigningScope): Promise<Buffer | null>;
}

export interface SigV4Request {
  method: string;
  originalUrl: string;
  headers: IncomingHttpHeaders;
  rawBody?: string;
}

/** The one predicate for "this request claims SigV4 authentication". */
export function isAwsSigV4Request(header: unknown): header is string {
  return typeof header === 'string' && header.startsWith(`${ALGORITHM} `);
}

export function parseSigV4AuthHeader(authHeader: unknown): ParsedSigV4Header | null {
  if (!isAwsSigV4Request(authHeader)) {
    return null;
  }

  const authString = authHeader.substring(ALGORITHM.length + 1);
  const parts: { [key: string]: string } = {};

  // Parse Credential=..., SignedHeaders=..., Signature=...
  const regex = /(\w+)=([^,]+)/g;
  let match;
  while ((match = regex.exec(authString)) !== null) {
    if (match[1] && match[2]) {
      parts[match[1]] = match[2].trim();
    }
  }

  if (!parts.Credential || !parts.SignedHeaders || !parts.Signature) {
    return null;
  }

  // Parse credential string: accessKeyId/yyyymmdd/region/service/aws4_request
  const credentialParts = parts.Credential.split('/');
  if (credentialParts.length !== 5 || credentialParts[4] !== 'aws4_request') {
    return null;
  }

  return {
    accessKeyId: credentialParts[0]!,
    date: credentialParts[1]!,
    region: credentialParts[2]!,
    service: credentialParts[3]!,
    signedHeaders: parts.SignedHeaders.split(';'),
    signature: parts.Signature
  };
}

/**
 * The scopes the verifier tries for a request's credential scope: the scope itself and, for
 * Bedrock, its bedrock <-> bedrock-runtime alternative. The admin signing-key provider asks for
 * exactly these.
 */
export function signingScopesFor(scope: SigningScope): SigningScope[] {
  const scopes = [scope];
  if (scope.service === 'bedrock') scopes.push({ ...scope, service: 'bedrock-runtime' });
  else if (scope.service === 'bedrock-runtime') scopes.push({ ...scope, service: 'bedrock' });
  return scopes;
}

/** AWS's derivation: kDate, kRegion, kService, kSigning. */
export function deriveSigningKey(secret: string, scope: SigningScope): Buffer {
  const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(scope.date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(scope.region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(scope.service).digest();
  return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

function amzDateToMs(amzDate: unknown): number | null {
  if (typeof amzDate !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isNaN(ms) ? null : ms;
}

/** x-amz-date present, well-formed and no more than 15 minutes from now. */
export function isAmzDateFresh(amzDate: unknown, nowMs: number = Date.now()): boolean {
  const ms = amzDateToMs(amzDate);
  return ms !== null && Math.abs(nowMs - ms) <= MAX_CLOCK_SKEW_MS;
}

// RFC 3986 encoding as SigV4 requires: encodeURIComponent plus the sub-delims it leaves alone.
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Each segment of the path as received is encoded once more, as AWS does for every service
// except S3 (a model id `...v1:0` arrives as `v1%3A0` and is signed as `v1%253A0`).
function canonicalPath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

function canonicalQuery(search: string): string {
  if (!search) return '';
  return search
    .split('&')
    .filter(pair => pair.length > 0)
    .map(pair => {
      const i = pair.indexOf('=');
      const name = i < 0 ? pair : pair.slice(0, i);
      const value = i < 0 ? '' : pair.slice(i + 1);
      return [uriEncode(safeDecode(name)), uriEncode(safeDecode(value))] as [string, string];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  const joined = Array.isArray(value) ? value.join(',') : String(value);
  return joined.trim().replace(/\s+/g, ' ');
}

function canonicalRequest(
  method: string,
  path: string,
  query: string,
  headers: IncomingHttpHeaders,
  signedHeaders: string[],
  payloadHash: string
): string {
  const names = signedHeaders.map(name => name.toLowerCase()).sort();
  const canonicalHeaders = names.map(name => `${name}:${headerValue(headers[name])}`).join('\n');
  return [
    method.toUpperCase(),
    canonicalPath(path),
    query,
    canonicalHeaders,
    '', // Empty line after headers
    names.join(';'),
    payloadHash
  ].join('\n');
}

function stringToSign(amzDate: string, scope: SigningScope, request: string): string {
  return [
    ALGORITHM,
    amzDate,
    `${scope.date}/${scope.region}/${scope.service}/aws4_request`,
    crypto.createHash('sha256').update(request).digest('hex')
  ].join('\n');
}

/**
 * Payload hash to verify against, always bound to the body the gateway actually received:
 * sha256 of the captured raw body, or of the empty payload for a request without a body.
 * null (never a match) when the request carries a body the gateway did not capture, or when
 * a declared x-amz-content-sha256 is anything other than that hash — UNSIGNED-PAYLOAD and
 * STREAMING-* included — so a captured signature cannot be replayed with another body.
 */
function payloadHash(req: SigV4Request): string | null {
  let actual: string;
  if (req.rawBody !== undefined) {
    actual = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  } else if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
    return null;
  } else {
    actual = EMPTY_PAYLOAD_HASH;
  }

  const declared = req.headers['x-amz-content-sha256'];
  if (declared === undefined) {
    return actual;
  }
  // The declared value is what the client put in its canonical request.
  return typeof declared === 'string' && declared.toLowerCase() === actual ? declared : null;
}

function signaturesEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * True when the request carries a valid signature under one of the accepted variants.
 * The caller checks x-amz-date freshness first (it answers 401, this answers 403).
 */
export async function verifySigV4Request(
  req: SigV4Request,
  parsed: ParsedSigV4Header,
  provider: SigningKeyProvider
): Promise<boolean> {
  const amzDate = req.headers['x-amz-date'];
  // The key is day-scoped: the credential scope must name the day of the signed timestamp.
  if (typeof amzDate !== 'string' || amzDate.slice(0, 8) !== parsed.date) {
    return false;
  }
  // As AWS does: host must be signed, else the signature is valid on any host. HTTP/2 clients (the
  // AWS JS SDK for Bedrock Runtime) sign the :authority pseudo-header instead; nginx forwards them as
  // HTTP/1.1 with a Host header, so :authority is checked against the same host variants below.
  if (!parsed.signedHeaders.some(name => ['host', ':authority'].includes(name.toLowerCase()))) {
    return false;
  }

  const hash = payloadHash(req);
  if (hash === null) {
    return false;
  }

  const url = new URL(req.originalUrl, 'http://placeholder');
  const query = canonicalQuery(url.search.slice(1));

  const paths = [url.pathname];
  if (url.pathname.startsWith('/aws-bedrock/')) {
    paths.push(url.pathname.replace('/aws-bedrock', ''));
  }
  // nginx serves the gateway under /gateway and strips it; the client signed the full path.
  const prefix = req.headers['x-forwarded-prefix'];
  if (typeof prefix === 'string' && FORWARDED_PREFIX.test(prefix) && ALLOWED_FORWARDED_PREFIXES.includes(prefix)) {
    paths.push(prefix + url.pathname);
  }

  const receivedHost = headerValue(req.headers.host);
  const hosts = [receivedHost];
  if (receivedHost.includes(':')) {
    hosts.push(receivedHost.split(':')[0]!);
  }
  // nginx's Host drops the port the client signed; X-Forwarded-Host keeps it.
  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && FORWARDED_HOST.test(forwardedHost)) {
    hosts.push(forwardedHost);
  }
  hosts.push(`bedrock-runtime.${parsed.region}.amazonaws.com`, `bedrock.${parsed.region}.amazonaws.com`);

  let matched = false;
  for (const scope of signingScopesFor({ date: parsed.date, region: parsed.region, service: parsed.service })) {
    const signingKey = await provider.getSigningKey(parsed.accessKeyId, scope);
    if (!signingKey) continue;

    for (const host of [...new Set(hosts)]) {
      const headers = { ...req.headers, host, ':authority': host };
      for (const path of paths) {
        const request = canonicalRequest(req.method, path, query, headers, parsed.signedHeaders, hash);
        const expected = crypto.createHmac('sha256', signingKey).update(stringToSign(amzDate, scope, request)).digest('hex');
        // No early exit: every variant is compared, so timing does not reveal which one matched.
        if (signaturesEqual(expected, parsed.signature)) matched = true;
      }
    }
  }
  return matched;
}
