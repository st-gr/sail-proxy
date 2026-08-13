import axios from 'axios';
import * as crypto from 'crypto';
import { BlobBackend } from './blobStore';
import { buildS3AuthHeader } from './s3Signer';

const SHA_RE = /^[0-9a-f]{64}$/;

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid sha256 key: ${sha}`);
}

export interface S3BackendConfig {
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
}

function keyFor(prefix: string, sha: string): string {
  assertSha(sha);
  const trimmedPrefix = prefix.replace(/\/+$/, '');
  const shard = sha.slice(0, 2);
  return trimmedPrefix ? `${trimmedPrefix}/${shard}/${sha}` : `${shard}/${sha}`;
}

function locate(cfg: S3BackendConfig, key: string): { url: string; host: string; pathname: string } {
  if (cfg.endpoint) {
    const base = cfg.endpoint.replace(/\/+$/, '');
    const host = new URL(base).host;
    const pathname = `/${cfg.bucket}/${key}`;
    return { host, pathname, url: `${base}${pathname}` };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const pathname = `/${key}`;
  return { host, pathname, url: `https://${host}${pathname}` };
}

function credentials(): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId = process.env.FILE_SEARCH_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('FILE_SEARCH_S3_ACCESS_KEY_ID / FILE_SEARCH_S3_SECRET_ACCESS_KEY are not configured');
  }
  return { accessKeyId, secretAccessKey };
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function signedHeaders(
  method: string, cfg: S3BackendConfig, host: string, pathname: string, payload: Buffer,
): Record<string, string> {
  const { accessKeyId, secretAccessKey } = credentials();
  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const amzDate = amzDateNow();
  const authorization = buildS3AuthHeader({
    method, host, pathname, payloadSha256, accessKeyId, secretAccessKey, region: cfg.region, amzDate,
  });
  return {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadSha256,
    authorization,
  };
}

function isNotFound(e: any): boolean {
  return !!e?.response && e.response.status === 404;
}

export function createS3Backend(cfg: S3BackendConfig): BlobBackend {
  return {
    async put(sha, bytes, mime) {
      const key = keyFor(cfg.prefix, sha);
      const { url, host, pathname } = locate(cfg, key);
      const headers = {
        ...signedHeaders('PUT', cfg, host, pathname, bytes),
        'content-type': mime || 'application/octet-stream',
      };
      await axios.put(url, bytes, { headers, maxBodyLength: Infinity, maxContentLength: Infinity });
      return { location: url };
    },
    async get(sha) {
      const key = keyFor(cfg.prefix, sha);
      const { url, host, pathname } = locate(cfg, key);
      const headers = signedHeaders('GET', cfg, host, pathname, Buffer.alloc(0));
      try {
        const res = await axios.get(url, { headers, responseType: 'arraybuffer' });
        return Buffer.from(res.data);
      } catch (e: any) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async delete(sha) {
      const key = keyFor(cfg.prefix, sha);
      const { url, host, pathname } = locate(cfg, key);
      const headers = signedHeaders('DELETE', cfg, host, pathname, Buffer.alloc(0));
      try {
        await axios.delete(url, { headers });
      } catch (e: any) {
        if (isNotFound(e)) return;
        throw e;
      }
    },
    async exists(sha) {
      const key = keyFor(cfg.prefix, sha);
      const { url, host, pathname } = locate(cfg, key);
      const headers = signedHeaders('HEAD', cfg, host, pathname, Buffer.alloc(0));
      try {
        await axios.head(url, { headers });
        return true;
      } catch (e: any) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
  };
}
