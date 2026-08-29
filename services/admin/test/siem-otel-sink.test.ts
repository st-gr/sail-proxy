import * as http from 'http';
import { createOtelSink } from '../src/siem/sinks/otelSink';
import { toSiemEvent } from '../src/siem/siemEvent';
import { resolveSiemDispatch } from '../src/siem/siemConfigResolver';

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as any).port}/v1/logs`));
  });
}

const event = () => toSiemEvent({
  eventId: 'evt-1', eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-18T10:00:00.000Z', credentialId: 'cred-1',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

describe('otel sink', () => {
  it('POSTs OTLP log records with resourceLogs structure', async () => {
    let seen = '';
    const url = await stub((body, _q, res) => { seen = body; res.writeHead(200).end('{}'); });
    await createOtelSink({ name: 'otel', endpoint: url }).send([event()]);

    const parsed = JSON.parse(seen);
    expect(Array.isArray(parsed.resourceLogs)).toBe(true);
    const records = parsed.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    expect(records[0].body.stringValue).toContain('evt-1');
  });

  it('maps severity onto OTLP severityNumber', async () => {
    let seen = '';
    const url = await stub((body, _q, res) => { seen = body; res.writeHead(200).end('{}'); });
    await createOtelSink({ name: 'otel', endpoint: url }).send([event()]);
    const rec = JSON.parse(seen).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.severityNumber).toBeGreaterThan(0);
    expect(rec.severityText).toBe('high');
  });

  it('throws retryable on 503 and non-retryable on 400', async () => {
    const bad = await stub((_b, _q, res) => { res.writeHead(503).end(); });
    await expect(createOtelSink({ name: 'otel', endpoint: bad }).send([event()]))
      .rejects.toMatchObject({ retryable: true });
    server?.close(); server = undefined;

    const worse = await stub((_b, _q, res) => { res.writeHead(400).end(); });
    await expect(createOtelSink({ name: 'otel', endpoint: worse }).send([event()]))
      .rejects.toMatchObject({ retryable: false });
  });

  it('validateConfig reports a missing or non-http endpoint', () => {
    expect(createOtelSink({ name: 'otel', endpoint: '' }).validateConfig().length).toBeGreaterThan(0);
    expect(createOtelSink({ name: 'otel', endpoint: 'ftp://x.example.invalid' }).validateConfig().length)
      .toBeGreaterThan(0);
    expect(createOtelSink({ name: 'otel', endpoint: 'https://x.example.invalid/v1/logs' }).validateConfig())
      .toEqual([]);
  });

  it('validateConfig reports a configured headers slot with no stored credential, like every other sink', () => {
    // Regression: this returned [] and the sink was accepted, then ran unauthenticated for the
    // life of the process - no Authorization header, no warning. Configuring headers_env is the
    // operator saying the collector is behind auth, so an absent credential must drop the sink
    // the same way it does for datadog, s3, azure_sentinel, gcs_pubsub and webhook.
    delete process.env.SIEM_OTEL_HEADERS_MISSING;
    expect(createOtelSink({
      name: 'otel', endpoint: 'https://x.example.invalid/v1/logs',
      headersEnv: 'SIEM_OTEL_HEADERS_MISSING',
    }).validateConfig()).toEqual([`no credential stored for slot 'SIEM_OTEL_HEADERS_MISSING'`]);

    // An env var by that name is NOT a credential source - there is no environment fallback.
    process.env.SIEM_OTEL_HEADERS_MISSING = '{"authorization":"Bearer from-env"}';
    try {
      expect(createOtelSink({
        name: 'otel', endpoint: 'https://x.example.invalid/v1/logs',
        headersEnv: 'SIEM_OTEL_HEADERS_MISSING',
      }).validateConfig()).toEqual([`no credential stored for slot 'SIEM_OTEL_HEADERS_MISSING'`]);
    } finally {
      delete process.env.SIEM_OTEL_HEADERS_MISSING;
    }

    // A stored credential clears it; so does configuring no slot at all.
    expect(createOtelSink({
      name: 'otel', endpoint: 'https://x.example.invalid/v1/logs',
      headersEnv: 'SIEM_OTEL_HEADERS_MISSING',
      getSecret: () => '{"authorization":"Bearer stored"}',
    }).validateConfig()).toEqual([]);
  });

  it('a sink whose headers slot is empty is dropped by resolveSiemDispatch with a warning', () => {
    const resolved = resolveSiemDispatch({
      enabled: true,
      sinks: [{
        name: 'otel', type: 'otel', enabled: true,
        endpoint: 'https://collector.example.invalid/v1/logs',
        headers_env: 'SIEM_OTEL_HEADERS_MISSING',
      }],
    }, () => undefined);

    expect(resolved).toBeNull();
  });
});
