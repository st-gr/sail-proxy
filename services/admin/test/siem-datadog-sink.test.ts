import * as http from 'http';
import { createDatadogSink } from '../src/siem/sinks/datadogSink';
import { toSiemEvent } from '../src/siem/siemEvent';

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as any).port}/api/v2/logs`));
  });
}

const event = () => toSiemEvent({
  eventId: 'evt-1', eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-18T10:00:00.000Z', credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

describe('datadog sink', () => {
  it('sends a JSON array with the DD-API-KEY header and accepts 202', async () => {
    let seenBody = ''; let seenKey = '';
    const url = await stub((body, req, res) => {
      seenBody = body; seenKey = String(req.headers['dd-api-key'] || '');
      res.writeHead(202).end();
    });
    await createDatadogSink({
      name: 'dd', apiKeyEnv: 'TEST_DD_KEY', endpointOverride: url,
      getSecret: () => 'dd-FAKE-KEY',
    }).send([event()]);

    expect(seenKey).toBe('dd-FAKE-KEY');
    const parsed = JSON.parse(seenBody);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].ddsource).toBe('sail-proxy');
    expect(parsed[0].message).toContain('evt-1');
  });

  it('maps 403 to non-retryable and 500 to retryable', async () => {
    const getSecret = () => 'dd-FAKE-KEY';
    const denied = await stub((_b, _q, res) => { res.writeHead(403).end(); });
    await expect(createDatadogSink({ name: 'dd', apiKeyEnv: 'TEST_DD_KEY', endpointOverride: denied, getSecret }).send([event()]))
      .rejects.toMatchObject({ retryable: false });
    server?.close(); server = undefined;

    const broken = await stub((_b, _q, res) => { res.writeHead(500).end(); });
    await expect(createDatadogSink({ name: 'dd', apiKeyEnv: 'TEST_DD_KEY', endpointOverride: broken, getSecret }).send([event()]))
      .rejects.toMatchObject({ retryable: true });
  });

  it('validateConfig reports a missing api key env var and an unknown site', () => {
    delete process.env.TEST_DD_MISSING;
    expect(createDatadogSink({ name: 'dd', apiKeyEnv: 'TEST_DD_MISSING' }).validateConfig().length)
      .toBeGreaterThan(0);

    // getSecret is injected so a resolved credential cannot mask the site problem below —
    // without it, "no credential stored" alone would satisfy a bare length check and this
    // test would stay green even if the DATADOG_SITES check were deleted entirely.
    const problems = createDatadogSink({
      name: 'dd', apiKeyEnv: 'TEST_DD_KEY', site: 'not-a-site',
      getSecret: () => 'dd-FAKE-KEY',
    }).validateConfig();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("site 'not-a-site' is not a known Datadog site");
  });
});
