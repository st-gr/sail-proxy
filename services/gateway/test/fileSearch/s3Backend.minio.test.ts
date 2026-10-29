import * as crypto from 'crypto';
import { createS3Backend, S3RequestError, S3_PROBE_CONTENT } from '../../src/fileSearch/blob/s3Backend';

// End to end against a real S3 implementation (MinIO): SigV4 with path-style addressing,
// which the stub-based suites cannot prove. Skipped unless FILE_SEARCH_TEST_S3_ENDPOINT is set;
// `ci/scripts/file-search-test-s3.js start` provides it (the pipeline does that itself).
// The gate reads FILE_SEARCH_TEST_S3_* only and refuses any endpoint off this machine, and the
// MinIO keys are injected into the backend: this suite never touches FILE_SEARCH_S3_*.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { s3TestConfigFromEnv } = require('../../../../ci/scripts/file-search-test-s3.js');

const S3 = s3TestConfigFromEnv(process.env);
const describeS3 = S3 ? describe : describe.skip;

describeS3('s3Backend against MinIO (requires FILE_SEARCH_TEST_S3_*)', () => {
  const prefix = `fs-smoke-${crypto.randomBytes(4).toString('hex')}`;
  const backend = (secretAccessKey: string = S3.secretAccessKey) => createS3Backend(
    { bucket: S3.bucket, prefix, endpoint: S3.endpoint, region: S3.region },
    { credentials: { accessKeyId: S3.accessKeyId, secretAccessKey } },
  );

  it('probe, put, exists, get, delete round trip', async () => {
    const s3 = backend();
    const bytes = crypto.randomBytes(1024);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');

    await expect(s3.probe()).resolves.toBeUndefined();
    const probeSha = crypto.createHash('sha256').update(S3_PROBE_CONTENT).digest('hex');
    expect(await s3.exists(probeSha)).toBe(true); // left in place by the product; removed here by exact key
    await s3.delete(probeSha);
    expect(await s3.exists(sha)).toBe(false);
    const { location } = await s3.put(sha, bytes, 'application/octet-stream');
    expect(location).toBe(`${prefix}/${sha.slice(0, 2)}/${sha}`);
    expect(await s3.exists(sha, location)).toBe(true);
    expect((await s3.get(sha, location))?.equals(bytes)).toBe(true);
    await s3.delete(sha, location);
    expect(await s3.exists(sha)).toBe(false);
    expect(await s3.get(sha)).toBeNull();
    await expect(s3.delete(sha)).resolves.toBeUndefined();
  });

  it('MinIO verifies the signature: a wrong secret is refused', async () => {
    const wrong = `${S3.secretAccessKey}x`;
    const error = await backend(wrong).probe().catch((e) => e);
    expect(error).toBeInstanceOf(S3RequestError);
    expect(error.status).toBe(403);
    const sha = crypto.createHash('sha256').update('refused').digest('hex');
    await expect(backend(wrong).put(sha, Buffer.from('refused'), 'text/plain'))
      .rejects.toMatchObject({ op: 'PutObject', status: 403, code: 'SignatureDoesNotMatch' });
  });
});
