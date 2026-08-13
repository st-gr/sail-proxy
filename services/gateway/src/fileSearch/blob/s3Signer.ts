import * as crypto from 'crypto';
import { getSigningKey, calculateSignature } from '../../middlewares/awsSigV4Auth';

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

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
