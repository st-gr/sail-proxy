/**
 * The delivery half of the spec's content requirement: what each sink actually receives.
 *
 * The emission half - canary in, masked placeholders out of the real pseudonymization
 * pipeline - is asserted in services/gateway/test/siem-usage-content.test.ts. This file
 * asserts what happens AFTER the event is in the outbox, where one row is read once and
 * handed to every sink: that the two per-sink flags are honoured on the copy sent to each
 * sink, and that a sink which did not opt in cannot see content because another one did.
 *
 * Canaries are the same shape as the gateway's, and are checked for by substring against
 * the whole serialized payload rather than field by field: a strip that moved the text
 * somewhere else instead of removing it would pass a field-level check.
 *
 * @see ../src/siem/siemEvent.ts - contentForSink / redactForSink
 * @see ./siem-dispatcher.test.ts - the credential_material strip this follows
 */
import { join } from 'path';

const cds = require('@sap/cds');

import { startDispatcher } from '../src/siem/dispatcher';
import { writeToOutbox } from '../src/siem/outbox';
import { toSiemEvent, contentForSink, SiemEvent } from '../src/siem/siemEvent';
import { SiemSink } from '../src/siem/sink';

const CANARY_NAME = 'Marguerite Vandersloot';
const CANARY_EMAIL = 'marguerite.vandersloot@example.invalid';
const RAW_PROMPT = `Please email ${CANARY_NAME} at ${CANARY_EMAIL} about the invoice.`;
const MASKED_PROMPT = 'Please email MASKED_PERSON_15102538 at MASKED_EMAIL_a41b09c2 about the invoice.';
const PLACEHOLDER = /MASKED_[A-Z_]+_[0-9a-f]+/;

type SinkFlags = { includeContent?: boolean; allowUnmaskedContent?: boolean; includeCredentialMaterial?: boolean };

const collectingSink = (name: string, seen: any[], flags: SinkFlags = {}): SiemSink => ({
  name,
  includeCredentialMaterial: flags.includeCredentialMaterial === true,
  includeContent: flags.includeContent === true,
  allowUnmaskedContent: flags.allowUnmaskedContent === true,
  validateConfig: () => [],
  healthCheck: async () => true,
  send: async batch => { seen.push(...batch); },
});

/** A usage event as the gateway publishes one, through the real normalizer. */
const usageEvent = (content: any): SiemEvent => toSiemEvent({
  category: 'usage',
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  eventType: 'request_completed',
  timestamp: '2026-08-22T10:00:00.000Z',
  credentialId: 'key-row-id',
  authType: 'api_key',
  clientIP: '203.0.113.9',
  endpoint: '/openai/v1/chat/completions?stream=true',
  requestId: 'req-canary',
  statusCode: 200,
  model: 'gpt-4o',
  content,
} as any);

const MASKED_CONTENT = { prompt: MASKED_PROMPT, masked: true, truncated: false };
const UNMASKED_CONTENT = { prompt: RAW_PROMPT, masked: false, truncated: false };

describe('toSiemEvent maps a usage-shaped input', () => {
  it('takes the usage branch and carries the content block through', () => {
    const event = usageEvent(MASKED_CONTENT);

    expect(event.category).toBe('usage');
    expect(event.type).toBe('request_completed');
    expect(event.outcome).toBe('success');
    expect(event.resource.model).toBe('gpt-4o');
    // The query string is dropped here as it is for every other category.
    expect(event.resource.endpoint).toBe('/openai/v1/chat/completions');
    expect(event.request).toEqual({ request_id: 'req-canary', status: 200 });
    expect(event.content).toEqual({
      prompt: MASKED_PROMPT, response: undefined, truncated: false, masked: true, omitted: undefined,
    });
  });

  it('records a failed request as a failure without changing anything else', () => {
    const event = toSiemEvent({ category: 'usage', eventId: 'e', statusCode: 500 } as any);
    expect(event.outcome).toBe('failure');
    expect(event.category).toBe('usage');
  });

  it('does not let an unknown key on the wire become part of the content block', () => {
    const event = usageEvent({ prompt: 'p', masked: true, smuggled: RAW_PROMPT });
    expect(JSON.stringify(event)).not.toContain(CANARY_NAME);
    expect((event.content as any).smuggled).toBeUndefined();
  });

  it('drops an omission reason it does not recognise rather than passing it through', () => {
    const event = usageEvent({ masked: true, omitted: 'because-i-said-so' });
    expect(event.content?.omitted).toBeUndefined();
  });

  it('leaves a security event with no content field at all', () => {
    const event = toSiemEvent({ eventId: 'e', eventType: 'failed_auth', severity: 'high' } as any);
    expect(event.category).toBe('security');
    expect(event.content).toBeUndefined();
  });
});

describe('contentForSink applies the two flags', () => {
  const policy = (over: Partial<Record<string, boolean>> = {}) => ({
    includeCredentialMaterial: false, includeContent: false, allowUnmaskedContent: false, ...over,
  } as any);

  // Case 1.
  it('removes content entirely for a sink without include_content', () => {
    const out = contentForSink(usageEvent(MASKED_CONTENT), policy());
    expect('content' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('MASKED_PERSON');
  });

  // Case 2.
  it('passes masked content through for a sink with include_content', () => {
    const out = contentForSink(usageEvent(MASKED_CONTENT), policy({ includeContent: true }));
    expect(out.content?.prompt).toMatch(PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(out)).not.toContain(CANARY_EMAIL);
  });

  // Case 3.
  it('replaces unmasked content with the reason it was withheld', () => {
    const out = contentForSink(usageEvent(UNMASKED_CONTENT), policy({ includeContent: true }));
    expect(out.content).toEqual({ omitted: 'not-masked' });
    expect(JSON.stringify(out)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(out)).not.toContain(CANARY_EMAIL);
  });

  // Case 4: the path that ships raw, asserted so it is deliberate.
  it('DOES pass unmasked content to a sink with allow_unmasked_content', () => {
    const out = contentForSink(usageEvent(UNMASKED_CONTENT), policy({ includeContent: true, allowUnmaskedContent: true }));
    expect(out.content?.prompt).toContain(CANARY_NAME);
    expect(out.content?.masked).toBe(false);
  });

  it('allow_unmasked_content alone, without include_content, ships nothing', () => {
    const out = contentForSink(usageEvent(UNMASKED_CONTENT), policy({ allowUnmaskedContent: true }));
    expect('content' in out).toBe(false);
  });

  it('never mutates the event it was given', () => {
    const event = usageEvent(UNMASKED_CONTENT);
    contentForSink(event, policy());
    contentForSink(event, policy({ includeContent: true }));
    expect(event.content?.prompt).toBe(RAW_PROMPT);
  });

  /**
   * The pseudonymization counts are NOT content and must survive the strip that removes
   * content. Asserted at this gate rather than only at emission, because this is the gate
   * that would quietly take it away: `contentForSink` deletes the whole `content` field for
   * a sink that did not opt in, and the counts sit beside it precisely so a metadata-only
   * sink can still see that a request masked forty values.
   */
  it('keeps the pseudonymization counts on a sink that gets no content at all', () => {
    const event = toSiemEvent({
      category: 'usage', eventId: 'evt-sat', statusCode: 200,
      content: UNMASKED_CONTENT,
      pseudonymization: { masked_values: 41, categories: { 'profile-person': 41 }, saturated: true },
    } as any);

    const out = contentForSink(event, policy());

    expect('content' in out).toBe(false);
    expect(out.pseudonymization).toEqual({
      masked_values: 41, categories: { 'profile-person': 41 }, saturated: true,
    });
    expect(JSON.stringify(out)).not.toContain(CANARY_NAME);
  });
});

describe('dispatcher delivery', () => {
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  // Case 6: the property that makes the whole per-sink design work. Six sinks read the same
  // batch rows; stripping the shared batch would either leak content to a sink that never
  // opted in, or take it from one that did, depending only on dispatch order.
  it('gives each sink in one batch the payload its own flags allow', async () => {
    const event = usageEvent(MASKED_CONTENT);
    const seenPlain: any[] = [], seenContent: any[] = [];

    await writeToOutbox(event, ['plain-sink', 'content-sink']);
    const handle = startDispatcher(
      [
        collectingSink('plain-sink', seenPlain),
        collectingSink('content-sink', seenContent, { includeContent: true }),
      ],
      { batchSize: 10, intervalMs: 20 },
    );
    await new Promise(r => setTimeout(r, 300));
    handle.stop();

    const plain = seenPlain.find(e => e.event_id === event.event_id);
    const withContent = seenContent.find(e => e.event_id === event.event_id);
    expect(plain).toBeDefined();
    expect(withContent).toBeDefined();

    expect(plain.content).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain('MASKED_PERSON');
    expect(withContent.content.prompt).toBe(MASKED_PROMPT);
    // Neither copy carries raw PII: the event never held any.
    expect(JSON.stringify(seenPlain.concat(seenContent))).not.toContain(CANARY_NAME);
  });

  it('withholds unmasked content from one sink while delivering it to the other', async () => {
    const event = usageEvent(UNMASKED_CONTENT);
    const seenMaskedOnly: any[] = [], seenRaw: any[] = [];

    await writeToOutbox(event, ['masked-only-sink', 'raw-sink']);
    const handle = startDispatcher(
      [
        collectingSink('masked-only-sink', seenMaskedOnly, { includeContent: true }),
        collectingSink('raw-sink', seenRaw, { includeContent: true, allowUnmaskedContent: true }),
      ],
      { batchSize: 10, intervalMs: 20 },
    );
    await new Promise(r => setTimeout(r, 300));
    handle.stop();

    const maskedOnly = seenMaskedOnly.find(e => e.event_id === event.event_id);
    const raw = seenRaw.find(e => e.event_id === event.event_id);
    expect(maskedOnly).toBeDefined();
    expect(raw).toBeDefined();

    expect(maskedOnly.content).toEqual({ omitted: 'not-masked' });
    expect(JSON.stringify(maskedOnly)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(maskedOnly)).not.toContain(CANARY_EMAIL);
    // And the sink that asked for it, and only that one, gets the whole thing.
    expect(raw.content.prompt).toBe(RAW_PROMPT);
  });
});
