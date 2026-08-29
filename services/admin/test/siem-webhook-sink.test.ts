import * as http from 'http';
import { createWebhookSink } from '../src/siem/sinks/webhookSink';
import { toSiemEvent } from '../src/siem/siemEvent';

let servers: http.Server[] = [];
afterEach(() => { servers.forEach(s => s.close()); servers = []; });

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve(`http://127.0.0.1:${addr.port}/ingest`);
    });
  });
}

const event = () => toSiemEvent({
  eventId: 'evt-1', eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-17T10:00:00.000Z', credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

describe('webhook sink', () => {
  it('POSTs the batch as JSON with the bearer token', async () => {
    let seenBody = ''; let seenAuth = '';
    const url = await stub((body, req, res) => {
      seenBody = body; seenAuth = String(req.headers.authorization || '');
      res.writeHead(202).end();
    });

    await createWebhookSink({ name: 'webhook', url, token: 's3cret' }).send([event()]);

    expect(seenAuth).toBe('Bearer s3cret');
    const parsed = JSON.parse(seenBody);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events[0].event_id).toBe('evt-1');
  });

  it('throws on 5xx so the dispatcher retries', async () => {
    const url = await stub((_b, _q, res) => { res.writeHead(503).end('unavailable'); });
    await expect(createWebhookSink({ name: 'webhook', url }).send([event()]))
      .rejects.toThrow();
  });

  // A 4xx means the payload or credential is wrong. Retrying cannot fix it and would
  // spin forever, so it must be distinguishable from a 5xx by the dispatcher.
  it('throws a non-retryable error on 4xx', async () => {
    const url = await stub((_b, _q, res) => { res.writeHead(400).end('bad request'); });
    await expect(createWebhookSink({ name: 'webhook', url }).send([event()]))
      .rejects.toMatchObject({ retryable: false });
  });

  // 429 and 408 fall in the 4xx range but are transient (rate limiting, request
  // timeout) rather than a bad payload or credential. The dispatcher's backoff
  // logic reads `retryable` directly, so misclassifying these would silently
  // drop events under rate limiting instead of retrying them.
  it('marks 429 as retryable, not a permanent failure', async () => {
    const url = await stub((_b, _q, res) => { res.writeHead(429).end('rate limited'); });
    await expect(createWebhookSink({ name: 'webhook', url }).send([event()]))
      .rejects.toMatchObject({ retryable: true });
  });

  it('marks 408 as retryable, not a permanent failure', async () => {
    const url = await stub((_b, _q, res) => { res.writeHead(408).end('request timeout'); });
    await expect(createWebhookSink({ name: 'webhook', url }).send([event()]))
      .rejects.toMatchObject({ retryable: true });
  });

  // A redirect would replay the Authorization header to whatever host the Location
  // header names. The sink must not follow it, and must treat it as a config
  // problem for an operator to fix rather than something to retry.
  it('does not follow a 3xx redirect and treats it as non-retryable', async () => {
    let redirectTargetHit = false;
    const target = await stub((_b, _q, res) => { redirectTargetHit = true; res.writeHead(200).end(); });
    const url = await stub((_b, _q, res) => { res.writeHead(302, { Location: target }).end(); });

    await expect(createWebhookSink({ name: 'webhook', url, token: 's3cret' }).send([event()]))
      .rejects.toMatchObject({ retryable: false });
    expect(redirectTargetHit).toBe(false);
  });

  it('validateConfig reports a missing url instead of throwing at send time', () => {
    expect(createWebhookSink({ name: 'webhook', url: '' }).validateConfig().length).toBeGreaterThan(0);
  });

  it('validateConfig reports a missing name', () => {
    expect(createWebhookSink({ name: '', url: 'http://example.invalid/ingest' }).validateConfig().length)
      .toBeGreaterThan(0);
  });

  it('validateConfig reports a url that does not parse, without throwing', () => {
    expect(() => createWebhookSink({ name: 'webhook', url: 'not-a-url' }).validateConfig()).not.toThrow();
    expect(createWebhookSink({ name: 'webhook', url: 'not-a-url' }).validateConfig().length).toBeGreaterThan(0);
  });

  it('validateConfig reports a non-http(s) url scheme', () => {
    expect(createWebhookSink({ name: 'webhook', url: 'ftp://example.invalid/ingest' }).validateConfig().length)
      .toBeGreaterThan(0);
    expect(createWebhookSink({ name: 'webhook', url: 'javascript:alert(1)' }).validateConfig().length)
      .toBeGreaterThan(0);
  });
});
