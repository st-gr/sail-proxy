import { buildS3AuthHeader } from '../../src/fileSearch/blob/s3Signer';

describe('buildS3AuthHeader', () => {
  it('produces a deterministic SigV4 header for a fixed time and key', () => {
    const header = buildS3AuthHeader({
      method: 'PUT', host: 'bucket.s3.eu-central-1.amazonaws.com', pathname: '/blobs/abc',
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRET', region: 'eu-central-1',
      amzDate: '20260730T000000Z',
    });
    expect(header).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260730\/eu-central-1\/s3\/aws4_request/);
    expect(header).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });

  it('is a pure function of its inputs, not wall-clock time', () => {
    const params = {
      method: 'GET', host: 'bucket.s3.eu-central-1.amazonaws.com', pathname: '/blobs/abc',
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRET', region: 'eu-central-1',
      amzDate: '20260730T000000Z',
    };
    expect(buildS3AuthHeader(params)).toBe(buildS3AuthHeader(params));
  });

  it('changes the signature when the secret changes', () => {
    const base = {
      method: 'GET', host: 'bucket.s3.eu-central-1.amazonaws.com', pathname: '/blobs/abc',
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIDEXAMPLE', region: 'eu-central-1', amzDate: '20260730T000000Z',
    };
    const a = buildS3AuthHeader({ ...base, secretAccessKey: 'SECRET' });
    const b = buildS3AuthHeader({ ...base, secretAccessKey: 'OTHER_SECRET' });
    expect(a).not.toBe(b);
  });
});
