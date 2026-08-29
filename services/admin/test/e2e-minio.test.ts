/**
 * End-to-end SIEM delivery against a real S3 implementation (MinIO).
 *
 * This is the path nothing else covers: every sink is unit-tested at the wire against an
 * http.createServer stub, and the dispatcher is tested against fake sinks, but the two halves
 * never meet. Here a real audit event goes through the real writeToOutbox, the real dispatcher
 * and the real S3 sink, and the object is read back out of the bucket.
 *
 * It needs a running S3 implementation, so it is skipped unless SIEM_S3_TEST_ENDPOINT is set:
 * a normal run - and CI - reports it skipped, never failed.
 *
 * To run it, start MinIO and create the bucket:
 *
 *   docker run -d --name siem-minio -p 19000:9000 -p 19001:9001 \
 *     -e MINIO_ROOT_USER=<access-key> -e MINIO_ROOT_PASSWORD=<secret-key> \
 *     quay.io/minio/minio server /data --console-address ':9001'
 *   docker exec siem-minio mc alias set local http://127.0.0.1:9000 <access-key> <secret-key>
 *   docker exec siem-minio mc mb local/siem-audit
 *
 * then point the test at it:
 *
 *   SIEM_S3_TEST_ENDPOINT=http://127.0.0.1:19000 \
 *   SIEM_S3_TEST_BUCKET=siem-audit \
 *   SIEM_S3_TEST_ACCESS_KEY_ID=<access-key> \
 *   SIEM_S3_TEST_SECRET_ACCESS_KEY=<secret-key> \
 *   npx jest --config=jest.config.js test/e2e-minio.test.ts
 *
 * Endpoint, bucket, region and both keys come from the environment and have no committed
 * defaults beyond the bucket name and region: this repository is public, and a credential must
 * never be readable from a tracked file - not even a throwaway one, which reads like a real one
 * to anyone scanning.
 */
import { join } from 'path';

const cds = require('@sap/cds');

import { writeToOutbox } from '../src/siem/outbox';
import { toSiemEvent } from '../src/siem/siemEvent';
import { startDispatcher } from '../src/siem/dispatcher';
import { createS3Sink } from '../src/siem/sinks/s3Sink';
import { buildS3AuthHeader } from '@libs/aws-signing/s3Signer';

const ORIGIN = (process.env.SIEM_S3_TEST_ENDPOINT ?? '').replace(/\/+$/, '');
const BUCKET = process.env.SIEM_S3_TEST_BUCKET ?? 'siem-audit';
const REGION = process.env.SIEM_S3_TEST_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.SIEM_S3_TEST_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.SIEM_S3_TEST_SECRET_ACCESS_KEY ?? '';
const PREFIX = 'sail-proxy/siem';

/** The slot names the sink resolves through its injected resolver - names, never values. */
const ACCESS_KEY_SLOT = 'SIEM_S3_ACCESS_KEY_ID';
const SECRET_KEY_SLOT = 'SIEM_S3_SECRET_ACCESS_KEY';

const OUTBOX = 'sap.llm.gateway.admin.SiemOutbox';
const DELIVERY = 'sap.llm.gateway.admin.SiemDelivery';

/** Set the endpoint to run this; leave it unset and the suite reports the test skipped. */
const describeWithS3 = ORIGIN ? describe : describe.skip;

const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A signed GET against the test endpoint, so the read path uses the same signer as the sink. */
async function signedGet(pathname: string): Promise<string> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const authorization = buildS3AuthHeader({
    method: 'GET',
    host: new URL(ORIGIN).host,
    pathname,
    payloadSha256: SHA256_OF_EMPTY,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: REGION,
    amzDate,
  });
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: { authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': SHA256_OF_EMPTY },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${pathname} failed ${res.status}: ${body}`);
  return body;
}

async function listBucket(): Promise<string[]> {
  const xml = await signedGet(`/${BUCKET}`);
  return Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g)).map(m => m[1]);
}

describeWithS3('SIEM end-to-end delivery to a real S3 implementation', () => {
  let handle: { stop(): void } | null = null;

  beforeAll(async () => {
    if (!ACCESS_KEY || !SECRET_KEY) {
      throw new Error(
        'SIEM_S3_TEST_ENDPOINT is set but SIEM_S3_TEST_ACCESS_KEY_ID / ' +
          'SIEM_S3_TEST_SECRET_ACCESS_KEY are not. See the comment at the top of this file.',
      );
    }
    await cds.deploy(join(__dirname, '../src/db/schema')).to('sqlite::memory:');
  });

  afterAll(() => {
    if (handle) handle.stop();
  });

  it('delivers a real audit event to a real S3 bucket and marks it delivered', async () => {
    const { DELETE, SELECT } = cds.ql;
    await DELETE.from(DELIVERY);
    await DELETE.from(OUTBOX);

    const eventId = `e2e-${Date.now()}`;
    const event = toSiemEvent({
      ID: eventId,
      action: 'siem_credential.set',
      actorId: 'admin@example.invalid',
      actorType: 'admin_user',
      resourceType: 'SiemCredential',
      resourceId: ACCESS_KEY_SLOT,
      outcome: 'success',
      severity: 'high',
      clientIP: '203.0.113.9',
      createdAt: new Date().toISOString(),
    });

    await writeToOutbox(event, ['s3']);
    expect(await SELECT.from(OUTBOX)).toHaveLength(1);

    const sink = createS3Sink({
      name: 's3',
      bucket: BUCKET,
      region: REGION,
      prefix: PREFIX,
      accessKeyIdEnv: ACCESS_KEY_SLOT,
      secretAccessKeyEnv: SECRET_KEY_SLOT,
      getSecret: (name: string) =>
        name === ACCESS_KEY_SLOT ? ACCESS_KEY :
        name === SECRET_KEY_SLOT ? SECRET_KEY : undefined,
      endpointOverride: ORIGIN,
    });

    // validateConfig must pass with credentials supplied only through the store-backed resolver.
    expect(sink.validateConfig()).toEqual([]);

    // Objects this run must be told apart from anything an earlier run left in the bucket:
    // the outbox is emptied above but the bucket is not, and reading whatever key happens to
    // sort first would assert against a previous run's event.
    const before = new Set(await listBucket());
    handle = startDispatcher([sink], { batchSize: 10, intervalMs: 1000, startupDelayMs: 0 });

    // Poll the outbox for settlement rather than sleeping a fixed interval.
    const deadline = Date.now() + 30_000;
    let delivered: Array<{ status: string }> = [];
    while (Date.now() < deadline) {
      delivered = await SELECT.from(DELIVERY).where({ sinkName: 's3' });
      if (delivered.length > 0 && delivered[0].status === 'delivered') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe('delivered');

    const keys = await listBucket();
    const written = keys.filter(k => k.startsWith(`${PREFIX}/`) && !before.has(k));
    expect(written.length).toBeGreaterThan(0);

    // Key format: prefix/YYYY/MM/DD/HH/<uuid>.ndjson in UTC.
    expect(written[0]).toMatch(
      /^sail-proxy\/siem\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.ndjson$/,
    );

    const body = await signedGet(`/${BUCKET}/${written[0]}`);
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);

    const shipped = JSON.parse(lines[0]);
    expect(shipped.event_id).toBe(eventId);
    expect(shipped.category).toBe('audit');
    expect(shipped.type).toBe('siem_credential.set');

    // The credential value must never appear in what is shipped.
    expect(body).not.toContain(SECRET_KEY);
  }, 60_000);

  /**
   * The same path, with content present. The audit event above proves delivery; this proves
   * that what arrives in the bucket when a sink is opted into content is the MASKED form -
   * the canary identity that went into the prompt is absent from the object, and a
   * placeholder is there instead. Asserted against the object's bytes, not against the
   * event in memory, because the bucket is where the content actually leaves the system.
   */
  it('delivers a usage event with masked content, and the canary never reaches the bucket', async () => {
    // The previous test's dispatcher is still ticking, and reconcileOutbox would otherwise
    // backfill an 's3' delivery row for the event written below - delivering it a second
    // time, through a sink with includeContent false, into an object this test would then
    // have to tell apart from its own.
    if (handle) { handle.stop(); handle = null; }

    const { DELETE, SELECT } = cds.ql;
    await DELETE.from(DELIVERY);
    await DELETE.from(OUTBOX);

    const CANARY_NAME = 'Marguerite Vandersloot';
    const CANARY_EMAIL = 'marguerite.vandersloot@example.invalid';
    const eventId = `e2e-usage-${Date.now()}`;
    const event = toSiemEvent({
      category: 'usage',
      eventId,
      eventType: 'request_completed',
      timestamp: new Date().toISOString(),
      credentialId: 'key-row-id',
      authType: 'api_key',
      clientIP: '203.0.113.9',
      endpoint: '/openai/v1/chat/completions',
      requestId: 'req-e2e-canary',
      statusCode: 200,
      model: 'gpt-4o',
      content: {
        prompt: 'Please email MASKED_PERSON_15102538 at MASKED_EMAIL_a41b09c2 about the invoice.',
        masked: true,
        truncated: false,
      },
    } as any);

    await writeToOutbox(event, ['s3-content']);

    const sink = createS3Sink({
      name: 's3-content',
      bucket: BUCKET,
      region: REGION,
      prefix: PREFIX,
      accessKeyIdEnv: ACCESS_KEY_SLOT,
      secretAccessKeyEnv: SECRET_KEY_SLOT,
      includeContent: true,
      getSecret: (name: string) =>
        name === ACCESS_KEY_SLOT ? ACCESS_KEY :
        name === SECRET_KEY_SLOT ? SECRET_KEY : undefined,
      endpointOverride: ORIGIN,
    });

    const before = new Set(await listBucket());
    handle = startDispatcher([sink], { batchSize: 10, intervalMs: 1000, startupDelayMs: 0 });

    const deadline = Date.now() + 30_000;
    let delivered: Array<{ status: string }> = [];
    while (Date.now() < deadline) {
      delivered = await SELECT.from(DELIVERY).where({ sinkName: 's3-content' });
      if (delivered.length > 0 && delivered[0].status === 'delivered') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe('delivered');

    const written = (await listBucket()).filter(k => k.startsWith(`${PREFIX}/`) && !before.has(k));
    expect(written.length).toBeGreaterThan(0);

    const body = await signedGet(`/${BUCKET}/${written[0]}`);
    const shipped = JSON.parse(body.trim().split('\n')[0]);

    expect(shipped.event_id).toBe(eventId);
    expect(shipped.category).toBe('usage');
    expect(shipped.content.masked).toBe(true);
    expect(shipped.content.prompt).toMatch(/MASKED_[A-Z_]+_[0-9a-f]+/);
    // The whole object, byte for byte: no canary anywhere in it.
    expect(body).not.toContain(CANARY_NAME);
    expect(body).not.toContain(CANARY_EMAIL);
    expect(body).not.toContain(SECRET_KEY);
  }, 60_000);
});
