import { S3RequestError, S3_FALLBACK_MAX_GET_BYTES } from '../../src/fileSearch/blob/s3Backend';
import { SHA_A, rejection, useS3Stub } from './s3Stub';

// A GET never returns more than the caller expects: the blob's size plus a margin, or a fixed
// fallback. A larger 2xx body (announced or streamed) fails as response_too_large; at most 64 KiB
// is ever buffered beyond the expectation, so an S3 error reply is always read and reported.

const stub = useS3Stub();

describe('s3Backend: GET body cap', () => {
  it('a body within maxBytes is returned', async () => {
    stub.handler = (_req, res) => res.end(Buffer.alloc(100, 1));
    expect((await stub.backend().get(SHA_A, null, 100))?.length).toBe(100);
  });

  it('a body over maxBytes (Content-Length) fails as response_too_large', async () => {
    stub.handler = (_req, res) => res.end(Buffer.alloc(101, 1));
    const err = await rejection(stub.backend().get(SHA_A, null, 100));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.op).toBe('GetObject');
    expect(err.code).toBe('response_too_large');
  });

  it('a streamed (chunked) body over maxBytes fails the same way', async () => {
    stub.handler = (_req, res) => {
      res.setHeader('transfer-encoding', 'chunked');
      res.write(Buffer.alloc(80, 1));
      setTimeout(() => res.end(Buffer.alloc(80, 1)), 10);
    };
    const err = await rejection(stub.backend().get(SHA_A, null, 100));
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('response_too_large');
  });

  it('without maxBytes the fallback cap is finite', () => {
    expect(Number.isFinite(S3_FALLBACK_MAX_GET_BYTES)).toBe(true);
  });

  it('an S3 error reply larger than the expected body is read in full and reported as itself', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message>`
      + `<RequestId>0123456789ABCDEF</RequestId><HostId>${'h'.repeat(120)}</HostId></Error>`;
    expect(xml.length).toBeGreaterThan(240);
    stub.handler = (req, res) => {
      if (req.method === 'PUT') { req.resume(); req.on('end', () => res.end()); return; }
      res.statusCode = 403;
      res.end(xml);
    };
    const err = await rejection(stub.backend().probe()); // the probe GET expects 44 bytes
    expect(err).toBeInstanceOf(S3RequestError);
    expect({ op: err.op, status: err.status, code: err.code }).toEqual({ op: 'GetObject', status: 403, code: 'AccessDenied' });
    const direct = await rejection(stub.backend().get(SHA_A, null, 10));
    expect({ op: direct.op, status: direct.status, code: direct.code }).toEqual({ op: 'GetObject', status: 403, code: 'AccessDenied' });
  });

  it('the probe accepts no more than its own content', async () => {
    stub.handler = (req, res) => {
      if (req.method === 'PUT') { req.resume(); req.on('end', () => res.end()); return; }
      res.end(Buffer.alloc(4096, 1));
    };
    const err = await rejection(stub.backend().probe());
    expect(err).toBeInstanceOf(S3RequestError);
    expect(err.code).toBe('response_too_large');
  });
});
