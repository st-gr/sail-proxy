// Node builtins only, like s3Signer.ts: shared libs are transpiled standalone by CI scripts.
import * as crypto from 'crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SignAwsRequestParams {
  method: string;
  url: string;
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** YYYYMMDDTHHMMSSZ; defaults to now */
  amzDate?: string;
  /** sign and send x-amz-content-sha256 (default true) */
  contentSha256Header?: boolean;
}

// RFC 3986 encoding as SigV4 requires: encodeURIComponent plus the sub-delims it leaves alone.
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const sha256Hex = (data: string): string => crypto.createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: crypto.BinaryLike, data: string): Buffer => crypto.createHmac('sha256', key).update(data).digest();

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Every service except S3 encodes each decoded path segment twice (once in the URL, once for signing).
function canonicalPath(pathname: string, service: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      const decoded = safeDecode(segment);
      return service === 's3' ? uriEncode(decoded) : uriEncode(uriEncode(decoded));
    })
    .join('/');
}

function canonicalQuery(search: URLSearchParams): string {
  return [...search.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * Signs an outbound request with AWS Signature V4 for any service.
 * Returns the headers to add: authorization, x-amz-date, [x-amz-content-sha256], [x-amz-security-token].
 * Host is signed but not returned (the HTTP client sets it from the URL).
 */
export function signAwsRequest(p: SignAwsRequestParams): Record<string, string> {
  const url = new URL(p.url);
  const amzDate = p.amzDate ?? formatAmzDate(new Date());
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(p.body);
  const withContentSha = p.contentSha256Header !== false;

  const signed: Record<string, string> = { host: url.host, 'x-amz-date': amzDate };
  if (withContentSha) signed['x-amz-content-sha256'] = payloadHash;
  if (p.sessionToken) signed['x-amz-security-token'] = p.sessionToken;

  const names = Object.keys(signed).sort();
  const canonicalRequest = [
    p.method.toUpperCase(),
    canonicalPath(url.pathname, p.service),
    canonicalQuery(url.searchParams),
    names.map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${date}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + p.secretAccessKey, date);
  const kSigning = hmac(hmac(hmac(kDate, p.region), p.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers: Record<string, string> = {
    authorization: `${ALGORITHM} Credential=${p.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    'x-amz-date': amzDate,
  };
  if (withContentSha) headers['x-amz-content-sha256'] = payloadHash;
  if (p.sessionToken) headers['x-amz-security-token'] = p.sessionToken;
  return headers;
}
