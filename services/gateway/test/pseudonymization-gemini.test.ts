/**
 * PII masking must work on the Gemini route. A body shape the plugin does not
 * understand would be a silent security gap once /google is force-enabled.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { hooks: { defaults: {} }, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
}));

import pluginRules = require('../src/plugins/pseudonymization/index');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const afterHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'after').handler;

const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }, { type: 'profile-person' }] };

describe('pseudonymization on Gemini bodies', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('masks a request and unmasks the matching response round-trip', async () => {
    const req: any = {
      body: {
        model: 'gemini-2.5-pro',
        masking,
        systemInstruction: { parts: [{ text: 'Reply to john@test.com' }] },
        contents: [{ role: 'user', parts: [{ text: 'Contact john@test.com' }] }],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    expect(req.body.contents[0].parts[0].text).not.toContain('john@test.com');
    expect(req.body.contents[0].parts[0].text).toContain('MASKED_EMAIL');
    expect(req.body.systemInstruction.parts[0].text).toContain('MASKED_EMAIL');

    const token = req.__pseudonymizationMap.forward.get('john@test.com');
    expect(token).toBeDefined();

    const upstreamResponse: any = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: `I mailed ${token}` },
              { functionCall: { name: 'send', args: { to: token, retries: 2 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };
    const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

    expect(result.candidates[0].content.parts[0].text).toBe('I mailed john@test.com');
    expect(result.candidates[0].content.parts[1].functionCall.args.to).toBe('john@test.com');
    expect(result.candidates[0].content.parts[1].functionCall.args.retries).toBe(2);
  });
});

/**
 * The NATIVE /google stream is piped through byte for byte, so its only unmask site is the
 * res.write interceptor the before-handler installs. That interceptor resolves WHOLE tokens;
 * a placeholder split across two frames needs the per-candidate retention buffer.
 */
describe('installSseUnmaskInterceptor on Gemini stream frames', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  /** A res whose write/end are captured before the interceptor replaces them. */
  function captureRes(): { res: any; wire: () => string } {
    const written: string[] = [];
    const res: any = {
      write: (chunk: any) => { written.push(String(chunk)); return true; },
      end: () => res,
      json: (body: any) => body,
    };
    return { res, wire: () => written.join('') };
  }

  function geminiFrame(text: string, finishReason?: string): string {
    return `data: ${JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
        index: 0,
      }],
    })}\n\n`;
  }

  /**
   * What a Gemini client actually reads: every frame's candidate text concatenated in
   * arrival order. Retention moves text BETWEEN frames, so a raw-substring assertion on
   * the wire cannot tell a delivered tail from a lost one — this can.
   */
  function clientText(wire: string): string {
    return wire.split('\n\n').filter(Boolean).map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) return '';
      const frame = JSON.parse(line.slice(6));
      return (frame.candidates || [])
        .flatMap((c: any) => (c?.content?.parts || []).map((part: any) => part?.text || ''))
        .join('');
    }).join('');
  }

  async function maskedRequest(res: any): Promise<string> {
    const req: any = {
      body: { model: 'gemini-2.5-pro', masking, contents: [{ role: 'user', parts: [{ text: 'Contact john@test.com' }] }] },
    };
    await beforeHandler({ req, res, utils: { logger: mockLogger } });
    const token = req.__pseudonymizationMap.forward.get('john@test.com');
    expect(typeof token).toBe('string');
    return token as string;
  }

  it('reassembles a placeholder split across two frames and unmasks it', async () => {
    const { res, wire } = captureRes();
    const token = await maskedRequest(res);
    const cut = Math.ceil(token.length / 2);

    res.write(geminiFrame(`I mailed ${token.slice(0, cut)}`));
    res.write(geminiFrame(`${token.slice(cut)} this morning`, 'STOP'));

    // Both halves of the split token resolve to the real value, and no fragment of the
    // placeholder survives on the wire.
    expect(wire()).toContain('john@test.com');
    expect(wire()).not.toContain('MASKED_');
  });

  it('delivers the retained tail when the terminal frame carries no content at all', async () => {
    const { res, wire } = captureRes();
    const token = await maskedRequest(res);
    const cut = Math.ceil(token.length / 2);

    // SAP's native terminal frame omits `content` ENTIRELY — see the live SSE capture in
    // test/google-gemini-service.test.ts. The retained tail has no container to be appended
    // to unless one is materialised, and dropping it truncates the answer silently.
    res.write(geminiFrame(`I mailed ${token.slice(0, cut)}`));
    // Completes the split placeholder, then ends on a prefix-shaped fragment: the trailing
    // "M" of "5 PM" is a possible start of MASKED_*, so the buffer holds it back.
    res.write(geminiFrame(`${token.slice(cut)} at 5 PM`));
    res.write(`data: ${JSON.stringify({
      candidates: [{ finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
    })}\n\n`);

    // The split token resolved, and the held-back "M" rode out on the terminal frame the
    // fix materialised — so the client reads "5 PM", not the truncated "5 P". Exact, so a
    // duplicated tail would fail here too.
    expect(clientText(wire())).toBe('I mailed john@test.com at 5 PM');
    expect(wire()).not.toContain('MASKED_');
  });

  it('flushes a retained tail on the frame that carries finishReason', async () => {
    const { res, wire } = captureRes();
    const token = await maskedRequest(res);
    const partial = token.slice(0, Math.ceil(token.length / 2));

    // A complete token, then a SECOND fragment that ends the turn mid-placeholder. The
    // buffer retains that trailing fragment, and only the finishReason flush puts it back
    // on the wire — without the flush it is swallowed and the answer is silently truncated.
    res.write(geminiFrame(`I mailed ${token} and then ${partial}`, 'STOP'));

    expect(wire()).toContain('john@test.com');
    expect(wire()).toContain(partial);
  });
});
