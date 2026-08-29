/**
 * THE TEST THE SPEC NAMES.
 *
 * docs/superpowers/specs/2026-08-15-siem-export-design.md requires that when a sink opts
 * into `include_content`, "the payload contains masked placeholders and no raw PII,
 * asserted with canary values in the prompt". This is that assertion, run against the real
 * pseudonymization pipeline rather than a stand-in: the canary goes into a request body,
 * the plugin's own before handler masks it, and what `buildUsageEvent` captures is checked
 * for the canary and for a placeholder.
 *
 * The uncomfortable case is here too. With BOTH `include_content` and
 * `allow_unmasked_content` set on some enabled sink, and masking bypassed, the canary IS
 * shipped, verbatim. That path exists by design - an operator who has deliberately turned
 * off masking and deliberately opted a sink into unmasked content gets what they asked for
 * - and it is asserted positively here so that it is a documented, tested property rather
 * than something a reader discovers in production.
 *
 * Canaries are RFC 5737 / .invalid throughout: this repository is public and no test may
 * carry a value that reads as real.
 *
 * @see ../src/services/siemUsageEvent.ts - the gates asserted here
 * @see ../../admin/test/siem-content-shipping.test.ts - the per-sink strip at delivery
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const mockConfig: any = { api_config: { hooks: { defaults: {} }, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_endpoint: string, model: string) => model,
  },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_endpoint: string, model: string) => model,
  getTrustForwardedFor: () => false,
}));

import { EventEmitter } from 'events';
import pluginRules = require('../src/plugins/pseudonymization/index');
import {
  buildUsageEvent,
  resolveContentGates,
  DEFAULT_CONTENT_MAX_BYTES,
  ContentGates,
} from '../src/services/siemUsageEvent';
import { getStreamCapture } from '../src/services/siemStreamCapture';

const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

/** A distinctive fake identity. Both halves must be absent from any masked payload. */
const CANARY_NAME = 'Marguerite Vandersloot';
const CANARY_EMAIL = 'marguerite.vandersloot@example.invalid';
const CANARY_PROMPT = `Please email ${CANARY_NAME} at ${CANARY_EMAIL} about the invoice.`;

const PLACEHOLDER = /MASKED_[A-Z_]+_[0-9a-f]+/;

const MASKING = {
  method: 'pseudonymization',
  entities: [{ type: 'profile-person' }, { type: 'profile-email' }],
};

function requestWith(prompt: string, masking: any): any {
  return {
    headers: { 'user-agent': 'jest' },
    body: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      ...(masking === undefined ? {} : { masking }),
    },
  };
}

/** Runs the REAL masking pipeline over the request, in place, exactly as a request does. */
async function mask(req: any): Promise<void> {
  await beforeHandler({ req, res: {}, utils: { logger } });
}

const CONTEXT = { model: 'gpt-4o', statusCode: 200, requestId: 'req-canary', endpoint: '/openai/v1/chat/completions' };

const gates = (over: Partial<ContentGates> = {}): ContentGates => ({
  emit: true, includeContent: false, allowUnmasked: false, maxBytes: DEFAULT_CONTENT_MAX_BYTES, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.api_config.observability.pseudonymization = undefined;
  mockConfig.api_config.observability.siem = undefined;
});

describe('resolveContentGates reads the operator opt-ins, and defaults every one to closed', () => {
  const sink = (over: any = {}) => ({ name: 's', type: 's3', enabled: true, ...over });

  it('emits nothing at all when siem is off', () => {
    expect(resolveContentGates({ enabled: false, categories: ['usage'], sinks: [sink()] }).emit).toBe(false);
  });

  it('emits nothing when usage is not among the exported categories', () => {
    // The shipped api_config.json is exactly this case: categories ["security","audit"].
    expect(resolveContentGates({ enabled: true, categories: ['security', 'audit'], sinks: [sink()] }).emit).toBe(false);
  });

  it('emits, but carries no content, when no enabled sink asked for content', () => {
    const g = resolveContentGates({ enabled: true, categories: ['usage'], sinks: [sink()] });
    expect(g).toMatchObject({ emit: true, includeContent: false, allowUnmasked: false });
  });

  it('does not count a DISABLED sink opted into content', () => {
    const g = resolveContentGates({
      enabled: true,
      categories: ['usage'],
      sinks: [sink({ enabled: false, include_content: true, allow_unmasked_content: true })],
    });
    expect(g).toMatchObject({ includeContent: false, allowUnmasked: false });
  });

  it('needs BOTH flags on the SAME sink before unmasked content is allowed', () => {
    const g = resolveContentGates({
      enabled: true,
      categories: ['usage'],
      sinks: [
        sink({ name: 'a', include_content: true }),
        sink({ name: 'b', allow_unmasked_content: true }),
      ],
    });
    expect(g).toMatchObject({ includeContent: true, allowUnmasked: false });
  });

  it('defaults content_max_bytes to 8192 and ignores a nonsense value', () => {
    const base = { enabled: true, categories: ['usage'], sinks: [sink()] };
    expect(resolveContentGates(base).maxBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
    expect(resolveContentGates({ ...base, content_max_bytes: -1 }).maxBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
    expect(resolveContentGates({ ...base, content_max_bytes: 64 }).maxBytes).toBe(64);
  });
});

describe('content shipping, with canary values in the prompt', () => {
  // Case 1 of the spec's list.
  it('ships NO content field at all when include_content is off', async () => {
    const req = requestWith(CANARY_PROMPT, MASKING);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates())!;

    expect(event.content).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(event)).not.toContain(CANARY_EMAIL);
    // ...and the metadata that is the point of the event is still there.
    expect(event).toMatchObject({ category: 'usage', model: 'gpt-4o', statusCode: 200, requestId: 'req-canary' });
  });

  // Case 2. The spec's own sentence, asserted.
  it('ships masked placeholders and no raw PII when include_content is on', async () => {
    const req = requestWith(CANARY_PROMPT, MASKING);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true }))!;
    const shipped = JSON.stringify(event);

    expect(event.content?.masked).toBe(true);
    expect(event.content?.prompt).toBeDefined();
    // The canary is gone...
    expect(shipped).not.toContain(CANARY_NAME);
    expect(shipped).not.toContain(CANARY_EMAIL);
    expect(shipped).not.toContain('Vandersloot');
    // ...and a placeholder is there in its place, so this is masking rather than deletion.
    expect(event.content!.prompt).toMatch(PLACEHOLDER);
    // The non-PII part of the prompt survives, so the export is still worth having.
    expect(event.content!.prompt).toContain('about the invoice');
  });

  // Case 3. Masking bypassed, no sink allows unmasked content.
  it('omits content with a reason when masking never ran and no sink allows unmasked', async () => {
    const req = requestWith(CANARY_PROMPT, undefined);   // no masking block: nothing masked
    await mask(req);
    expect(req.__pseudonymization).toBeUndefined();      // the bypass is real, not assumed

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true }))!;

    expect(event.content).toEqual({ omitted: 'not-masked' });
    expect(event.content?.prompt).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(event)).not.toContain(CANARY_EMAIL);
  });

  // Case 4. THE UNCOMFORTABLE ONE: this path ships raw, and that is the point of asserting it.
  it('DOES ship the raw canary when both flags are set and masking was bypassed', async () => {
    const req = requestWith(CANARY_PROMPT, undefined);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true, allowUnmasked: true }))!;

    expect(event.content?.masked).toBe(false);
    expect(event.content?.prompt).toContain(CANARY_NAME);
    expect(event.content?.prompt).toContain(CANARY_EMAIL);
    expect(event.content?.prompt).not.toMatch(PLACEHOLDER);
  });

  // Case 5.
  it('truncates a prompt over content_max_bytes and says so, without the remainder', async () => {
    const HEAD = 'A'.repeat(64);
    const TAIL_CANARY = 'TAILCANARY-9f2b-example-invalid';
    const req = requestWith(`${HEAD}${TAIL_CANARY}`, undefined);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true, allowUnmasked: true, maxBytes: 64 }))!;

    expect(event.content?.truncated).toBe(true);
    expect(event.content?.prompt).toBe(HEAD);
    expect(JSON.stringify(event)).not.toContain(TAIL_CANARY);
  });

  it('does not flag truncation for a prompt that fits', async () => {
    const req = requestWith('short', undefined);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true, allowUnmasked: true }))!;

    expect(event.content).toMatchObject({ prompt: 'short', truncated: false, masked: false });
  });

  it('caps the response independently of the prompt, in bytes not characters', async () => {
    const req = requestWith('short', undefined);
    await mask(req);
    // What the pseudonymization after handler stashes, in its masked-form position.
    req.__siemMaskedResponse = 'é'.repeat(40);          // 80 UTF-8 bytes, 40 characters

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true, allowUnmasked: true, maxBytes: 64 }))!;

    expect(event.content?.prompt).toBe('short');
    expect(event.content?.truncated).toBe(true);
    expect(Buffer.byteLength(event.content!.response!, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('emits nothing when the configuration does not export usage events', async () => {
    const req = requestWith(CANARY_PROMPT, MASKING);
    await mask(req);

    expect(buildUsageEvent(req, CONTEXT, gates({ emit: false, includeContent: true }))).toBeNull();
  });
});

/**
 * THE SAME ASSERTION, FOR A STREAMED RESPONSE.
 *
 * A streamed response never exists as one complete string on the response path, so the
 * capture that serves the non-streaming case had nothing to read and a SIEM opted into
 * content received a masked prompt and no answer — for most of the traffic, since most LLM
 * traffic streams. services/siemStreamCapture.ts accumulates the masked deltas in memory
 * (never in Valkey: a round trip per chunk is a network hop per token) and assembles once at
 * end of stream.
 *
 * What is asserted here is the whole contract:
 *   - the canary identity is absent from the shipped event and a placeholder is in its place;
 *   - the assembled masked response, with this request's own replacement map applied back,
 *     is byte-for-byte the text the client actually received;
 *   - nothing at all is allocated when no enabled sink asked for content;
 *   - a stream that is abandoned publishes the prompt and `omitted: 'stream-incomplete'`,
 *     never half an answer presented as a whole one.
 */
describe('a STREAMED response, through the real interceptor', () => {
  /** A response an Express controller would write to: enough of one for the interceptor. */
  class FakeResponse extends EventEmitter {
    /** What actually went out on the wire, i.e. what the client received. */
    public wire: string[] = [];

    write(chunk: any, ..._args: any[]): boolean {
      this.wire.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }

    end(chunk?: any, ..._args: any[]): any {
      if (chunk !== undefined && chunk !== null) this.wire.push(String(chunk));
      // Node emits `finish` when the response completed, then `close`. The capture settles on
      // the first of the two it sees, so this ordering is the one that matters.
      this.emit('finish');
      this.emit('close');
      return this;
    }

    /** Abandoned mid-stream: `close` without a preceding `finish`. */
    hangUp(): void {
      this.emit('close');
    }

    json(body: any): any {
      return body;
    }
  }

  /** The `siem` block an operator opted into content would have. */
  const siemWithContentSink = (over: any = {}) => ({
    enabled: true,
    categories: ['usage'],
    sinks: [{ name: 's3', type: 's3', enabled: true, include_content: true }],
    ...over,
  });

  /** One Anthropic SSE block, in the framing the gateway's own sseWriter produces. */
  function sseBlock(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** The assistant text the client received, read back out of the bytes on the wire. */
  function clientText(res: FakeResponse): string {
    let text = '';
    for (const block of res.wire.join('').split('\n\n')) {
      const match = block.match(/data: (.+)$/s);
      if (!match) continue;
      let parsed: any;
      try { parsed = JSON.parse(match[1]); } catch { continue; }
      if (parsed?.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
        text += parsed.delta.text;
      }
    }
    return text;
  }

  /**
   * Runs the real before handler with a real response attached, so the SSE interceptor and
   * the content capture are both installed exactly as a streaming request installs them.
   */
  async function streamingRequest(prompt: string): Promise<{ req: any; res: FakeResponse }> {
    const req = requestWith(prompt, MASKING);
    req.body.stream = true;
    const res = new FakeResponse();
    await beforeHandler({ req, res, utils: { logger } });
    return { req, res };
  }

  /** Every placeholder this request's map produced, longest first so nesting cannot bite. */
  function tokensOf(req: any): Array<[string, string]> {
    const reverse: Map<string, string> = req.__pseudonymizationMap.reverse;
    return Array.from(reverse.entries()).sort((a, b) => b[0].length - a[0].length);
  }

  /**
   * Streams `text` as Anthropic text deltas in deliberately small pieces, so placeholders are
   * split across chunk boundaries and the interceptor's retention is exercised too.
   */
  function streamText(res: FakeResponse, text: string, size = 7): void {
    res.write(sseBlock('message_start', { type: 'message_start' }));
    res.write(sseBlock('content_block_start', { type: 'content_block_start', index: 0 }));
    for (let i = 0; i < text.length; i += size) {
      res.write(sseBlock('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(i, i + size) },
      }));
    }
    res.write(sseBlock('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sseBlock('message_stop', { type: 'message_stop' }));
  }

  it('ships the assembled masked response, and the canary never reaches the event', async () => {
    mockConfig.api_config.observability.siem = siemWithContentSink();
    const { req, res } = await streamingRequest(CANARY_PROMPT);

    // The model answers in the masked vocabulary it was given - the placeholders from this
    // request's own map, which is what an upstream provider actually sees and echoes.
    const [personToken] = tokensOf(req).map(entry => entry[0]);
    const maskedAnswer = `Done. I have emailed ${personToken} about the invoice.`;
    streamText(res, maskedAnswer);
    res.end();

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true }))!;
    const shipped = JSON.stringify(event);

    expect(event.content?.masked).toBe(true);
    expect(event.content?.response).toBeDefined();

    // The canary is absent from the whole event, prompt and response alike...
    expect(shipped).not.toContain(CANARY_NAME);
    expect(shipped).not.toContain(CANARY_EMAIL);
    expect(shipped).not.toContain('Vandersloot');
    // ...and a placeholder stands where it was, in BOTH halves.
    expect(event.content!.prompt).toMatch(PLACEHOLDER);
    expect(event.content!.response).toMatch(PLACEHOLDER);
    expect(event.content!.response).toContain('about the invoice');
    expect(event.content!.truncated).toBe(false);

    // The client got the real thing, unmasked, at the wire.
    const received = clientText(res);
    expect(received).toContain(CANARY_NAME);
    expect(received).not.toMatch(PLACEHOLDER);

    // And the assembled masked response IS that text, one substitution away: the export is
    // the same answer the caller read, not a separate reading of the stream.
    let rebuilt = event.content!.response!;
    for (const [token, original] of tokensOf(req)) rebuilt = rebuilt.split(token).join(original);
    expect(rebuilt).toBe(received);
  });

  it('allocates nothing at all when no enabled sink asked for content', async () => {
    mockConfig.api_config.observability.siem = {
      enabled: true,
      categories: ['usage'],
      sinks: [{ name: 's3', type: 's3', enabled: true }],   // no include_content
    };
    const { req, res } = await streamingRequest(CANARY_PROMPT);

    expect(getStreamCapture(req)).toBeUndefined();

    streamText(res, 'Nothing here is retained.');
    res.end();

    expect((req as any).__siemMaskedResponse).toBeUndefined();
    expect(buildUsageEvent(req, CONTEXT, gates())!.content).toBeUndefined();
  });

  it('does not capture a non-streaming request, which the after handler already covers', async () => {
    mockConfig.api_config.observability.siem = siemWithContentSink();
    const req = requestWith(CANARY_PROMPT, MASKING);       // no `stream: true`
    const res = new FakeResponse();
    await beforeHandler({ req, res, utils: { logger } });

    expect(getStreamCapture(req)).toBeUndefined();
  });

  it('stops retaining at content_max_bytes and says the result is truncated', async () => {
    mockConfig.api_config.observability.siem = siemWithContentSink({ content_max_bytes: 32 });
    const { req, res } = await streamingRequest(CANARY_PROMPT);

    const TAIL_CANARY = 'TAILCANARY-9f2b-example-invalid';
    streamText(res, `${'A'.repeat(64)}${TAIL_CANARY}`, 8);
    res.end();

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true, maxBytes: 32 }))!;

    expect(event.content?.truncated).toBe(true);
    expect(Buffer.byteLength(event.content!.response!, 'utf8')).toBeLessThanOrEqual(32);
    expect(JSON.stringify(event)).not.toContain(TAIL_CANARY);
  });

  it('publishes the prompt and a reason, never half an answer, when the client hangs up', async () => {
    mockConfig.api_config.observability.siem = siemWithContentSink();
    const { req, res } = await streamingRequest(CANARY_PROMPT);

    const capture = getStreamCapture(req)!;
    const [personToken] = tokensOf(req).map(entry => entry[0]);
    res.write(sseBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: `Done. I have emailed ${personToken}` },
    }));

    res.hangUp();                                          // `close`, and no `finish`

    expect(capture.status).toBe('aborted');
    expect((req as any).__siemMaskedResponse).toBeUndefined();

    const event = buildUsageEvent(req, CONTEXT, gates({ includeContent: true }))!;

    expect(event.content?.prompt).toMatch(PLACEHOLDER);
    expect(event.content?.response).toBeUndefined();
    expect(event.content?.omitted).toBe('stream-incomplete');
    expect(JSON.stringify(event)).not.toContain(CANARY_NAME);
  });
});

/**
 * The `pseudonymization` block (spec 2026-08-25-pseudonymization-precision, task 3).
 *
 * Counts, not content — which is why it is NOT behind the content gates: an operator who
 * exports usage events but has opted no sink into content still needs to see that a request
 * masked two hundred values. The assertions below therefore pair every count with the
 * canary check that made the content half of this file worth having.
 */
describe('the pseudonymization block travels with the usage event', () => {
  /** 41 distinct synthetic names, one per bullet: over the default bar of 40. */
  const ROSTER = Array.from({ length: 41 }, (_, i) => `- Ana Silva${i} Nakamura${i}`).join('\n');

  it('carries the counts even when NO sink asked for content', async () => {
    const req = requestWith(CANARY_PROMPT, MASKING);
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates())!;

    expect(event.content).toBeUndefined();
    expect(event.pseudonymization).toEqual({
      masked_values: 2,
      categories: { 'profile-person': 1, 'profile-email': 1 },
      saturated: false,
    });
    expect(JSON.stringify(event)).not.toContain(CANARY_NAME);
    expect(JSON.stringify(event)).not.toContain(CANARY_EMAIL);
  });

  it('says saturated: true above the bar, and still ships no value', async () => {
    const req = requestWith(ROSTER, { ...MASKING, saturation_warn: 40 });
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates())!;

    expect(event.pseudonymization).toMatchObject({ masked_values: 41, saturated: true });
    expect(event.pseudonymization!.categories['profile-person']).toBe(41);
    // The block is counts only: no masked value appears anywhere in it.
    expect(JSON.stringify(event.pseudonymization)).not.toContain('Nakamura');
  });

  it('says saturated: false when the operator raises the bar above the same request', async () => {
    const req = requestWith(ROSTER, { ...MASKING, saturation_warn: 100 });
    await mask(req);

    const event = buildUsageEvent(req, CONTEXT, gates())!;
    expect(event.pseudonymization).toMatchObject({ masked_values: 41, saturated: false });
  });

  it('is absent entirely when the pseudonymization plugin never ran', async () => {
    const req = requestWith(CANARY_PROMPT, undefined);
    await mask(req);
    expect(req.__pseudonymization).toBeUndefined();

    expect(buildUsageEvent(req, CONTEXT, gates())!.pseudonymization).toBeUndefined();
  });
});
