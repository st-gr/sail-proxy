import * as http from 'http';
import { AddressInfo } from 'net';
import { createS3Backend, S3BackendConfig } from '../../src/fileSearch/blob/s3Backend';

// Shared by the s3Backend.*.test.ts suites: a local stub S3 on 127.0.0.1:0 —
// never the network.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export const SHA_A = 'a'.repeat(64);
export const SHA_0 = '0'.repeat(64);
export const SHA_F = 'f'.repeat(64);
export const SHA_MIX = '0123456789abcdef'.repeat(4);

export const FAST = { metadataMs: 400, transferMs: 600, idleMs: 250 };

/** Injected, never through the FILE_SEARCH_S3_* env (test/setupTests.ts scrubs those). */
export const STUB_CREDENTIALS = { accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'test-secret-only' };

export interface Stub {
  endpoint: string;
  handler: Handler;
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  cfg(over?: Partial<S3BackendConfig>): S3BackendConfig;
  backend(over?: Partial<S3BackendConfig>): ReturnType<typeof createS3Backend>;
}

export async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const defaultHandler: Handler = (req, res) => {
  req.resume();
  req.on('end', () => res.end());
};

/** Registers the jest hooks and returns the live stub state. */
export function useS3Stub(): Stub {
  let server: http.Server;
  const stub: Stub = {
    endpoint: '',
    handler: defaultHandler,
    seen: [],
    cfg: (over = {}) => ({
      bucket: 'test-bucket', prefix: 'grounding-test', endpoint: stub.endpoint, region: 'us-east-1', ...over,
    }),
    backend: (over = {}) => createS3Backend(stub.cfg(over), { timeouts: FAST, credentials: STUB_CREDENTIALS }),
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      stub.seen.push({ method: req.method!, url: req.url!, headers: req.headers });
      // No keep-alive: afterEach drops connections, and a reused dead socket would ECONNRESET.
      res.setHeader('connection', 'close');
      stub.handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    stub.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    stub.seen = [];
    stub.handler = defaultHandler;
  });

  afterEach(() => {
    server.closeAllConnections();
  });

  return stub;
}
