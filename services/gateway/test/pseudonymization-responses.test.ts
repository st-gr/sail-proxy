/**
 * PII masking must work on the Responses route. Pseudonymization is
 * force-enabled for the openai endpoint with allow_user_bypass:false, so a
 * body shape the plugin does not understand would be a silent security gap.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
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

describe('pseudonymization on Responses bodies', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('masks a plain string input and instructions', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', instructions: 'Mail john@test.com', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    expect(req.body.input).not.toContain('john@test.com');
    expect(req.body.input).toContain('MASKED_EMAIL');
    expect(req.body.instructions).toContain('MASKED_EMAIL');
  });

  it('masks message items, function_call arguments and function_call_output', async () => {
    const req: any = {
      body: {
        model: 'gpt-5.3-codex--deployed', masking,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write to john@test.com' }] },
          { type: 'function_call', name: 'f', arguments: '{"to":"john@test.com"}' },
          { type: 'function_call_output', output: 'sent to john@test.com' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    const s = JSON.stringify(req.body.input);
    expect(s).not.toContain('john@test.com');
    expect(s).toContain('MASKED_EMAIL');
  });

  it('appends the copy-note to instructions, not system', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    expect(typeof req.body.instructions).toBe('string');
    expect(req.body.instructions).toContain('NEVER invent');
    expect(req.body.system).toBeUndefined();
  });

  it('unmasks a Responses output in the after handler', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    const token = req.__pseudonymizationMap.forward.get('john@test.com');
    expect(token).toBeDefined();

    const upstreamResponse: any = {
      object: 'response', status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: `I mailed ${token}` }] },
        { type: 'function_call', arguments: `{"to":"${token}"}` },
      ],
    };
    const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

    expect(result.output[0].content[0].text).toBe('I mailed john@test.com');
    expect(result.output[1].arguments).toBe('{"to":"john@test.com"}');
  });

  it('leaves chat-shaped bodies working exactly as before', async () => {
    const req: any = { body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Contact john@test.com' }], masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    expect(req.body.messages[0].content).toContain('MASKED_EMAIL');
  });
});
