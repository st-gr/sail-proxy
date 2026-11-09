import * as http from 'http';
import * as crypto from 'crypto';
import { createGcsPubSubSink } from '../src/siem/sinks/gcsPubSubSink';
import { toSiemEvent } from '../src/siem/siemEvent';

const servers: http.Server[] = [];
afterEach(() => { servers.forEach(s => s.close()); servers.length = 0; });

function stub(handler: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<string>(resolve => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => handler(body, req, res));
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`));
  });
}

const ev = (id: string) => toSiemEvent({
  eventId: id, eventType: 'failed_auth', severity: 'high',
  timestamp: '2026-08-18T10:00:00.000Z', credentialId: 'cred-1',
  authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
} as any);

function fakeServiceAccount(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    client_email: 'siem@example-project.iam.gserviceaccount.invalid',
    private_key: privateKey,
    private_key_id: 'FAKE-KEY-ID',
  });
}

describe('gcs pub/sub sink', () => {
  it('publishes the whole batch in one request, base64-encoded', async () => {
    let publishCalls = 0; let seenBody = '';
    const tokenUrl = await stub((_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const publishUrl = await stub((body, _q, res) => {
      publishCalls++; seenBody = body;
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ messageIds: ['1', '2', '3'] }));
    });
    const gcsSa = fakeServiceAccount();

    await createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_SA',
      tokenUrlOverride: tokenUrl, publishUrlOverride: publishUrl,
      getSecret: () => gcsSa,
    }).send([ev('evt-1'), ev('evt-2'), ev('evt-3')]);

    expect(publishCalls).toBe(1);
    const parsed = JSON.parse(seenBody);
    expect(parsed.messages).toHaveLength(3);
    const decoded = JSON.parse(Buffer.from(parsed.messages[0].data, 'base64').toString('utf8'));
    expect(decoded.event_id).toBe('evt-1');
  });

  it('acquires the token once across two sends', async () => {
    let tokenCalls = 0;
    const tokenUrl = await stub((_b, _q, res) => {
      tokenCalls++;
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const publishUrl = await stub((_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messageIds: ['1'] }));
    });
    const gcsSa = fakeServiceAccount();

    const sink = createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_SA',
      tokenUrlOverride: tokenUrl, publishUrlOverride: publishUrl,
      getSecret: () => gcsSa,
    });
    await sink.send([ev('evt-1')]);
    await sink.send([ev('evt-2')]);

    expect(tokenCalls).toBe(1);
  });

  it('maps a 401 from the token exchange to non-retryable', async () => {
    const tokenUrl = await stub((_b, _q, res) => { res.writeHead(401).end('invalid_grant'); });
    const publishUrl = await stub((_b, _q, res) => { res.writeHead(200).end('{}'); });
    const gcsSa = fakeServiceAccount();

    await expect(createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_SA',
      tokenUrlOverride: tokenUrl, publishUrlOverride: publishUrl,
      getSecret: () => gcsSa,
    }).send([ev('evt-1')])).rejects.toMatchObject({ retryable: false });
  });

  it('maps a 503 from publish to retryable', async () => {
    const tokenUrl = await stub((_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ access_token: 'FAKE-TOKEN', expires_in: 3600 }));
    });
    const publishUrl = await stub((_b, _q, res) => { res.writeHead(503).end(); });
    const gcsSa = fakeServiceAccount();

    await expect(createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_SA',
      tokenUrlOverride: tokenUrl, publishUrlOverride: publishUrl,
      getSecret: () => gcsSa,
    }).send([ev('evt-1')])).rejects.toMatchObject({ retryable: true });
  });

  it('validateConfig reports a missing env var and malformed JSON without throwing', () => {
    delete process.env.TEST_GCS_MISSING;
    expect(createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_MISSING',
    }).validateConfig().length).toBeGreaterThan(0);

    // getSecret is injected so a resolved-but-malformed credential is what's under test —
    // without it, "no credential stored" alone would satisfy a bare length check and this
    // test would stay green even if resolveServiceAccount's JSON.parse problem were deleted.
    const problems = createGcsPubSubSink({
      name: 'pubsub', projectId: 'example-project', topicId: 'siem',
      serviceAccountJsonEnv: 'TEST_GCS_BAD',
      getSecret: () => '{ not json',
    }).validateConfig();
    expect(problems).toEqual([`credential stored for slot 'TEST_GCS_BAD' is not valid JSON`]);
  });
});
