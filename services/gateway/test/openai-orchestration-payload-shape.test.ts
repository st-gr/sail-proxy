/**
 * Pins the orchestration payload shape for an Anthropic model with array
 * content: block content lands unflattened in messages_history, and the
 * prompt_templating template carries only the system message.
 *
 * This is a regression guard on the SHAPE of the output, not evidence that
 * deleting the dead flattening (openaiController.ts, formerly lines 1033-1049)
 * was safe. It cannot be that evidence: this test only ever drives the branch
 * where isAnthropicModel && Array.isArray(content) is true, which is exactly
 * the branch whose templateMessage value is discarded — the only read of
 * templateMessage is in the `else` of the second, textually identical
 * condition a few lines down. No mutation inside the deleted block (dropping
 * the "[Image attached]" placeholder, removing .trim(), changing the role,
 * even making the block throw) would make this test fail, because the value
 * it computed was never read on this path.
 *
 * The actual safety argument for the deletion lives in source, not in a test:
 * the two `if`s test the same condition on values nothing between them
 * mutates, so they are provably mutually exclusive, and grep confirms
 * templateMessage has exactly one read site, inside the other branch. See
 * openaiController.ts around the (now six-line) templateMessage assignment
 * for that argument in comment form.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: async (m: string) => ({ id: m, model: m, owned_by: 'Anthropic' }),
    getAuthToken: async () => 'tok',
  },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getUnsupportedParams: () => [], getParamRenames: () => ({}), getTimeout: () => 1000,
    getHookConfig: () => undefined, getConfig: () => ({}), getSupportsResponsesApi: () => undefined,
  },
}));

import { transformRequestToSAPFormat } from '../src/controllers/openaiController';

describe('orchestration payload for Anthropic array content', () => {
  it('puts the original block content into messages_history and a system-only template', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'anthropic--claude-4.8-opus',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    } as any);

    // The block content survives, unflattened.
    const last = payload.messages_history[payload.messages_history.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0]).toEqual({ type: 'text', text: 'hello' });

    // And the template carries only the system message in this branch.
    const template = payload.config.modules.prompt_templating.prompt.template;
    expect(template).toHaveLength(1);
    expect(template[0].role).toBe('system');
  });
});
