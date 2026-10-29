/**
 * Where the openai/perplexity model renames are wired: directly in front of the
 * controller on /openai/v1/chat/completions and /openai/v1/responses (after auth,
 * tool governance and quota, the point at which the anthropic, aws-bedrock and
 * google controllers rename), and nowhere on the OpenRouter router, which applies
 * providers.openrouter itself (or, on /responses, no list at all).
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

// The routers construct singletons at import time that throw without a >=32-char
// secret (see test/nul-byte-guard-routers.test.ts), so set one and require lazily.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);
/* eslint-disable @typescript-eslint/no-var-requires */
const chatRoutes = require('../src/routes/chatRoutes').default;
const responsesRoutes = require('../src/routes/responsesRoutes').default;
const openRouterRoutes = require('../src/routes/openRouterRoutes').default;
const openaiController = require('../src/controllers/openaiController');
const responsesController = require('../src/controllers/responsesController');
const { substituteOpenAICompatibleModel } = require('../src/middlewares/modelSubstitution');
/* eslint-enable @typescript-eslint/no-var-requires */

/** The handler chain of the router's POST route at `path`. */
function postChain(router: any, path: string): unknown[] {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods.post);
  expect(layer).toBeDefined();
  return layer.route.stack.map((l: any) => l.handle);
}

describe('model rename wiring on the OpenAI-shaped routes', () => {
  it('chat completions: renames right before handleChatCompletion', () => {
    const chain = postChain(chatRoutes, '/');
    expect(chain.slice(-2)).toEqual([substituteOpenAICompatibleModel, openaiController.handleChatCompletion]);
  });

  it('responses: renames right before handleResponses', () => {
    const chain = postChain(responsesRoutes, '/');
    expect(chain.slice(-2)).toEqual([substituteOpenAICompatibleModel, responsesController.handleResponses]);
  });

  it('openrouter: no route applies the openai/perplexity lists', () => {
    for (const path of ['/chat/completions', '/completions', '/responses']) {
      expect(postChain(openRouterRoutes, path)).not.toContain(substituteOpenAICompatibleModel);
    }
  });
});
