import * as http from 'http';
import { createS3Sink } from '../src/siem/sinks/s3Sink';
import { toSiemEvent } from '../src/siem/siemEvent';

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as any).port}`));
  });
}

const ev = (id: string) => toSiemEvent({
  eventId: id, eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-18T10:00:00.000Z', credentialId: 'cred-1',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

function sink(endpoint: string) {
  const stored = new Map([
    ['TEST_S3_KEY', 'AKIA-FAKE-FAKE-FAKE-FAKE'],
    ['TEST_S3_SECRET', 'FAKE-SECRET-VALUE'],
  ]);
  return createS3Sink({
    name: 's3', bucket: 'example-siem-archive', region: 'us-east-1', prefix: 'sail-proxy/siem',
    accessKeyIdEnv: 'TEST_S3_KEY', secretAccessKeyEnv: 'TEST_S3_SECRET',
    endpointOverride: endpoint,
    getSecret: (n: string) => stored.get(n),
  });
}

describe('s3 sink', () => {
  it('PUTs one newline-delimited JSON object per send, signed', async () => {
    let puts = 0; let seenBody = ''; let seenPath = ''; let seenAuth = ''; let seenMethod = '';
    const url = await stub((body, req, res) => {
      puts++; seenBody = body; seenPath = String(req.url || '');
      seenAuth = String(req.headers.authorization || ''); seenMethod = String(req.method || '');
      res.writeHead(200).end();
    });

    await sink(url).send([ev('evt-1'), ev('evt-2'), ev('evt-3')]);

    expect(puts).toBe(1);
    expect(seenMethod).toBe('PUT');
    // Signed with the repo's existing SigV4 signer, not an SDK.
    expect(seenAuth).toContain('AWS4-HMAC-SHA256');
    expect(seenAuth).toContain('AKIA-FAKE-FAKE-FAKE-FAKE');
    const lines = seenBody.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event_id).toBe('evt-1');
    expect(JSON.parse(lines[2]).event_id).toBe('evt-3');
    expect(seenPath).toContain('/example-siem-archive/');
  });

  it('partitions the object key by UTC date and hour under the prefix', async () => {
    let seenPath = '';
    const url = await stub((_b, req, res) => { seenPath = String(req.url || ''); res.writeHead(200).end(); });
    await sink(url).send([ev('evt-1')]);
    expect(seenPath).toMatch(/sail-proxy\/siem\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[0-9a-f-]+\.ndjson/);
  });

  it('signs the exact payload it sends', async () => {
    // x-amz-content-sha256 must match sha256 of the body actually transmitted, or real S3
    // rejects the request even though a stub would accept it.
    let seenBody = ''; let seenHash = '';
    const url = await stub((body, req, res) => {
      seenBody = body; seenHash = String(req.headers['x-amz-content-sha256'] || '');
      res.writeHead(200).end();
    });
    await sink(url).send([ev('evt-1'), ev('evt-2')]);

    const crypto = await import('crypto');
    expect(seenHash).toBe(crypto.createHash('sha256').update(seenBody).digest('hex'));
  });

  it('maps 500 to retryable and 403 to non-retryable', async () => {
    const broken = await stub((_b, _q, res) => { res.writeHead(500).end(); });
    await expect(sink(broken).send([ev('evt-1')])).rejects.toMatchObject({ retryable: true });
    server?.close(); server = undefined;

    const denied = await stub((_b, _q, res) => { res.writeHead(403).end(); });
    await expect(sink(denied).send([ev('evt-1')])).rejects.toMatchObject({ retryable: false });
  });

  it('validateConfig reports missing bucket, region and credential env vars without throwing', () => {
    delete process.env.TEST_S3_MISSING;
    const problems = createS3Sink({
      name: 's3', bucket: '', region: '',
      accessKeyIdEnv: 'TEST_S3_MISSING', secretAccessKeyEnv: 'TEST_S3_MISSING',
    }).validateConfig();
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
