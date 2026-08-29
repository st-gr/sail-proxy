import * as http from 'http';
import { createAzureSentinelSink } from '../src/siem/sinks/azureSentinelSink';
import { toSiemEvent } from '../src/siem/siemEvent';

let tokenServer: http.Server | undefined;
let ingestServer: http.Server | undefined;
afterEach(() => {
  tokenServer?.close(); tokenServer = undefined;
  ingestServer?.close(); ingestServer = undefined;
});

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    tokenServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    tokenServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(tokenServer!.address() as any).port}`));
  });
}

function stub2(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    ingestServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    ingestServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(ingestServer!.address() as any).port}`));
  });
}

const event = () => toSiemEvent({
  eventId: 'evt-1', eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-18T10:00:00.000Z', credentialId: 'missing',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

describe('azure sentinel sink', () => {
  it('acquires a token then posts records to the DCR endpoint', async () => {
    let tokenCalls = 0; let seenAuth = ''; let seenBody = '';
    // token server
    const tokenUrl = await stub((_b, _q, res) => {
      tokenCalls++;
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    // ingestion server
    const ingestUrl = await stub2((body, req, res) => {
      seenAuth = String(req.headers.authorization || ''); seenBody = body;
      res.writeHead(204).end();
    });
    await createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: ingestUrl, dcrImmutableId: 'dcr-FAKE',
      streamName: 'Custom-SailProxy_CL', tenantId: 't-FAKE', clientId: 'c-FAKE',
      clientSecretEnv: 'TEST_AZ_SECRET', authorityHostOverride: tokenUrl,
      getSecret: () => 'FAKE-SECRET',
    }).send([event()]);

    expect(tokenCalls).toBe(1);
    expect(seenAuth).toBe('Bearer FAKE-TOKEN');
    expect(Array.isArray(JSON.parse(seenBody))).toBe(true);
  });

  it('reuses a cached token rather than acquiring one per send', async () => {
    let tokenCalls = 0;
    const tokenUrl = await stub((_b, _q, res) => {
      tokenCalls++;
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const ingestUrl = await stub2((_b, _q, res) => { res.writeHead(204).end(); });

    const sink = createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: ingestUrl, dcrImmutableId: 'dcr-FAKE',
      streamName: 'Custom-SailProxy_CL', tenantId: 't-FAKE', clientId: 'c-FAKE',
      clientSecretEnv: 'TEST_AZ_SECRET', authorityHostOverride: tokenUrl,
      getSecret: () => 'FAKE-SECRET',
    });
    await sink.send([event()]);
    await sink.send([event()]);

    expect(tokenCalls).toBe(1);
  });

  it('maps a 401 from the token endpoint to non-retryable', async () => {
    // A wrong client secret cannot be fixed by retrying, so the dispatcher must not
    // keep hammering the token endpoint until maxAttempts.
    const tokenUrl = await stub((_b, _q, res) => { res.writeHead(401).end('invalid_client'); });
    const ingestUrl = await stub2((_b, _q, res) => { res.writeHead(204).end(); });

    await expect(createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: ingestUrl, dcrImmutableId: 'dcr-FAKE',
      streamName: 'Custom-SailProxy_CL', tenantId: 't-FAKE', clientId: 'c-FAKE',
      clientSecretEnv: 'TEST_AZ_SECRET', authorityHostOverride: tokenUrl,
      getSecret: () => 'WRONG-SECRET',
    }).send([event()])).rejects.toMatchObject({ retryable: false });
  });

  it('maps a 503 from the ingestion endpoint to retryable', async () => {
    // Transient — the dispatcher must leave the batch pending, not bisect it into
    // batchSize extra requests against an endpoint that is already failing.
    const tokenUrl = await stub((_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const ingestUrl = await stub2((_b, _q, res) => { res.writeHead(503).end(); });

    await expect(createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: ingestUrl, dcrImmutableId: 'dcr-FAKE',
      streamName: 'Custom-SailProxy_CL', tenantId: 't-FAKE', clientId: 'c-FAKE',
      clientSecretEnv: 'TEST_AZ_SECRET', authorityHostOverride: tokenUrl,
      getSecret: () => 'FAKE-SECRET',
    }).send([event()])).rejects.toMatchObject({ retryable: true });
  });

  it('treats a 202 from the ingestion endpoint as success, not a failure to retry', async () => {
    // A 202 Accepted means the DCE took the batch; previously send() only accepted 200/204,
    // so this fell through to mapHttpStatus's retryable:true default and got re-sent up to
    // 10 times — duplicating a batch Azure had already delivered.
    let ingestCalls = 0;
    const tokenUrl = await stub((_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const ingestUrl = await stub2((_b, _q, res) => { ingestCalls++; res.writeHead(202).end(); });

    await expect(createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: ingestUrl, dcrImmutableId: 'dcr-FAKE',
      streamName: 'Custom-SailProxy_CL', tenantId: 't-FAKE', clientId: 'c-FAKE',
      clientSecretEnv: 'TEST_AZ_SECRET', authorityHostOverride: tokenUrl,
      getSecret: () => 'FAKE-SECRET',
    }).send([event()])).resolves.toBeUndefined();

    expect(ingestCalls).toBe(1);
  });

  it('validateConfig reports every missing required field', () => {
    const problems = createAzureSentinelSink({
      name: 'sentinel', dcrEndpoint: '', dcrImmutableId: '', streamName: '',
      tenantId: '', clientId: '', clientSecretEnv: 'TEST_AZ_MISSING',
    }).validateConfig();
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});
