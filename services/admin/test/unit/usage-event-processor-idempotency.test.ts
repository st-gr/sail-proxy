/**
 * UsageEventProcessor: DB-level idempotency across separate persist calls (real sqlite,
 * un-mocked) — Task 10.
 *
 * Valkey pub/sub broadcasts each usage event to EVERY admin subscriber, so N admin replicas
 * fan out to N `persistUsageEvents` calls for the same event, each from its own process with
 * its own in-memory `processedRequestIds` Set. The already-shipped intra-batch content-signature
 * dedup inside `persistUsageEvents` only collapses duplicates within ONE call's batch array — it
 * does nothing across two separate calls (two "subscribers"), which is exactly the multi-replica
 * scenario. This suite calls `persistUsageEvents` directly (bypassing `processBatch` and its
 * `processedRequestIds` guard entirely) twice with the same event, simulating two independent
 * subscriber processes, and asserts the database — not the in-memory guard — is what prevents
 * the second copy from landing.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';

const API_KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';

describe('UsageEventProcessor: DB idempotency across separate persist calls (real sqlite, un-mocked)', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });

  function makeProcessor(): UsageEventProcessor {
    return new UsageEventProcessor({ enableCostCalculation: false });
  }

  function baseEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
    return {
      requestId: uuidv4(),
      timestamp: Math.floor(Date.now() / 1000),
      authType: 'api_key',
      credentialId: uuidv4(),
      provider: 'anthropic',
      model: 'claude-idempotency-test-model',
      inputTokens: 100,
      outputTokens: 50,
      responseTime: 250,
      statusCode: 200,
      ...overrides
    };
  }

  it('persists one ApiKeyUsage row when the same event is persisted twice (two subscribers)', async () => {
    const evt = baseEvent();

    const processorA = makeProcessor();
    const processorB = makeProcessor();

    // "Subscriber A" and "Subscriber B" — two independent processes/instances, each unaware of
    // the other's in-memory processedRequestIds Set (calling the private method directly skips
    // that guard entirely, isolating exactly what the DB unique signature must stop on its own).
    await (processorA as any).persistUsageEvents([evt]);
    await (processorB as any).persistUsageEvents([evt]);

    const rows = await db.run(cds.ql.SELECT.from(API_KEY_USAGE).where({ requestId: evt.requestId }));
    expect(rows.length).toBe(1);

    await processorA.shutdown();
    await processorB.shutdown();
  });

  it('persists one AwsCredentialUsage row when the same event is persisted twice (two subscribers)', async () => {
    const evt = baseEvent({
      authType: 'aws_credential',
      requestId: 'unknown', // AWS Bedrock's fallback requestId — verified: 193 rows share it on Kyma
      model: 'aws-idempotency-test-model',
      inputTokens: 321,
      outputTokens: 654
    });

    const processorA = makeProcessor();
    const processorB = makeProcessor();

    await (processorA as any).persistUsageEvents([evt]);
    await (processorB as any).persistUsageEvents([evt]);

    const rows = await db.run(cds.ql.SELECT.from(AWS_USAGE).where({ modelId: evt.model }));
    expect(rows.length).toBe(1);

    await processorA.shutdown();
    await processorB.shutdown();
  });

  it('persists BOTH rows for two genuinely distinct AWS events that share the fallback requestId "unknown"', async () => {
    // Guards against a requestId-only unique key regression: a requestId-alone unique index
    // would wrongly reject the second of these as a "duplicate" even though every other field
    // differs — exactly the defect the content-signature (not requestId alone) is chosen to avoid.
    const evtA = baseEvent({
      authType: 'aws_credential',
      requestId: 'unknown',
      model: 'aws-distinct-signature-model',
      inputTokens: 111,
      outputTokens: 222
    });
    const evtB = baseEvent({
      authType: 'aws_credential',
      requestId: 'unknown',
      model: 'aws-distinct-signature-model',
      inputTokens: 333,
      outputTokens: 444
    });

    const processor = makeProcessor();
    await (processor as any).persistUsageEvents([evtA, evtB]);

    const rows = await db.run(cds.ql.SELECT.from(AWS_USAGE).where({ modelId: 'aws-distinct-signature-model' }));
    expect(rows.length).toBe(2);

    await processor.shutdown();
  });

  it('stores a hashed (fixed-length) usageSignature, not the raw concatenation', async () => {
    const evt = baseEvent();

    const processor = makeProcessor();
    await (processor as any).persistUsageEvents([evt]);

    const rows = await db.run(cds.ql.SELECT.from(API_KEY_USAGE).where({ requestId: evt.requestId }));
    expect(rows.length).toBe(1);
    // sha256 hex digest is always 64 chars — proves the column holds a hash, not the raw
    // pipe-joined signature (which has no fixed length and can exceed the String(200) column).
    expect(rows[0].usageSignature).toMatch(/^[0-9a-f]{64}$/);

    await processor.shutdown();
  });

  it('persists exactly one row for an event whose RAW signature would overflow String(200) (long AWS modelId/ARN)', async () => {
    // A real AWS Bedrock inference-profile ARN can run this long. modelId is itself
    // String(200); concatenated into the raw signature with requestId/authType/credentialId/
    // etc., the raw pipe-joined string comfortably exceeds 200 chars — which SQLite silently
    // truncates-or-ignores (no length enforcement) but PostgreSQL's VARCHAR(200) rejects
    // outright on INSERT. Hashing the signature before writing it (see hashUsageSignature)
    // sidesteps this: the stored value is always exactly 64 hex chars regardless of input size.
    const longArnModel = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/' +
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0-with-a-very-long-suffix-to-push-this-over-two-hundred-characters-total-length';
    expect(longArnModel.length).toBeGreaterThan(120); // sanity: this alone is a big chunk of 200

    const evt = baseEvent({
      authType: 'aws_credential',
      requestId: 'unknown',
      credentialId: uuidv4(),
      model: longArnModel,
      inputTokens: 999,
      outputTokens: 888
    });
    // Confirm the premise: the raw (unhashed) signature this event would produce is indeed
    // longer than the usageSignature column's String(200) limit.
    const rawSignature = [
      evt.requestId, evt.authType, evt.credentialId, evt.model, evt.statusCode,
      evt.inputTokens, evt.outputTokens, '', '', evt.responseTime, evt.timestamp
    ].join('|');
    expect(rawSignature.length).toBeGreaterThan(200);

    const processorA = makeProcessor();
    const processorB = makeProcessor();

    await (processorA as any).persistUsageEvents([evt]);
    await (processorB as any).persistUsageEvents([evt]);

    const rows = await db.run(cds.ql.SELECT.from(AWS_USAGE).where({ modelId: longArnModel }));
    expect(rows.length).toBe(1);
    expect(rows[0].usageSignature).toMatch(/^[0-9a-f]{64}$/);

    await processorA.shutdown();
    await processorB.shutdown();
  });
});
