import * as crypto from 'crypto';

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Derive signing key and calculate signature — copied verbatim (unchanged) from
 * services/gateway/src/middlewares/awsSigV4Auth.ts, which implements INBOUND SigV4
 * validation for an Express middleware. Duplicated here rather than imported so this
 * shared lib has no dependency on a gateway-only, Express-based module (and the
 * gateway-only services it in turn imports).
 */
function getSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();

  let kRegion: Buffer;
  if (region === '*') {
    kRegion = kDate; // For SigV4a
  } else {
    kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  }

  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  return kSigning;
}

function calculateSignature(signingKey: Buffer, stringToSign: string): string {
  return crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

export interface S3AuthHeaderParams {
  method: string;
  host: string;
  pathname: string;
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  /** Canonical query string, already sorted/encoded. Defaults to none. */
  query?: string;
}

/**
 * Builds an outbound SigV4 `Authorization` header for a request to S3 (or an
 * S3-compatible endpoint). Reuses the signing-key/HMAC primitives already
 * used to validate inbound AWS SigV4 requests in awsSigV4Auth.ts, applied
 * here in the opposite direction to sign an outbound request.
 */
export function buildS3AuthHeader(params: S3AuthHeaderParams): string {
  const { method, host, pathname, payloadSha256, accessKeyId, secretAccessKey, region, amzDate, query } = params;
  const date = amzDate.slice(0, 8);

  const canonicalUri = pathname.split('/').map(encodeURIComponent).join('/');
  const canonicalQuery = query || '';

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadSha256,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join('\n');

  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = [ALGORITHM, amzDate, scope, hashedCanonicalRequest].join('\n');

  const signingKey = getSigningKey(secretAccessKey, date, region, SERVICE);
  const signature = calculateSignature(signingKey, stringToSign);

  return `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
