/**
 * The internal orchestration completion helper (fileSearch/orchestrationCompletion.ts):
 * payload layout, cache breakpoints per family, the sampling drop, the usage fold per
 * family, the per-call timeout and the error reasons. axios and configService mocked;
 * no network.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const getDeploymentIdMock = jest.fn<(...args: any[]) => Promise<string | null>>();
let mockCachingFlags: { model?: boolean; provider?: Record<string, boolean> } = {};
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getDeploymentId: (...a: any[]) => getDeploymentIdMock(...(a as [])),
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'rg-1' }),
    getAccessToken: async () => 'test-token',
    getSupportsPromptCaching: (provider?: string, model?: string) => (model
      ? mockCachingFlags.model
      : (provider ? mockCachingFlags.provider?.[provider] : undefined)),
  },
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

import {
  orchestrationComplete, buildCompletionPayload, foldCompletionUsage, promptCachingFor, CompletionError,
} from '../../src/fileSearch/orchestrationCompletion';

function reply(content: any, usage?: any): any {
  return { data: { final_result: { choices: [{ message: { content } }], ...(usage ? { usage } : {}) } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCachingFlags = {};
  getDeploymentIdMock.mockResolvedValue('dep-1');
});

describe('payload layout', () => {
  it('the template holds only the fixed instruction; every message goes in messages_history, in order', () => {
    const p = buildCompletionPayload({
      model: 'gemini-3.5-flash-lite',
      system: 'INSTRUCTION',
      messages: [{ text: '<document>D</document>' }, { text: '<chunk>C</chunk>' }],
      params: { temperature: 0, max_tokens: 100 },
    }, { caching: false });
    const tpl = p.config.modules.prompt_templating;
    expect(tpl.prompt.template).toEqual([{ role: 'system', content: [{ type: 'text', text: 'INSTRUCTION' }] }]);
    expect(p.messages_history).toEqual([
      { role: 'user', content: [{ type: 'text', text: '<document>D</document>' }] },
      { role: 'user', content: [{ type: 'text', text: '<chunk>C</chunk>' }] },
    ]);
    expect(tpl.model).toEqual({ name: 'gemini-3.5-flash-lite', params: { temperature: 0, max_tokens: 100 } });
    // A placeholder-looking text in a message is never parsed: it is not in the template.
    expect(JSON.stringify(tpl.prompt.template)).not.toContain('<document>');
  });

  it('with caching on, the cache breakpoint sits on the message before the newest (the document)', () => {
    const p = buildCompletionPayload({
      model: 'anthropic--claude-4.5-haiku', system: 'S',
      messages: [{ text: 'DOC' }, { text: 'CHUNK' }],
    }, { caching: true });
    const [doc, chunk] = p.messages_history as any[];
    expect(doc.content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(chunk.content[0].cache_control).toBeUndefined();
  });

  it('with caching off, no cache_control anywhere', () => {
    const p = buildCompletionPayload({
      model: 'gemini-3.5-flash-lite', system: 'S', messages: [{ text: 'DOC' }, { text: 'CHUNK' }],
    }, { caching: false });
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('drops the sampling parameters the model refuses and never mutates the caller params', () => {
    const params = { temperature: 0, top_p: 1, max_tokens: 50 };
    const gpt5 = buildCompletionPayload({ model: 'gpt-5-mini', system: 'S', messages: [{ text: 'q' }], params }, { caching: false });
    expect(gpt5.config.modules.prompt_templating.model.params).toEqual({ max_tokens: 50 });
    const claude = buildCompletionPayload({ model: 'anthropic--claude-4.5-haiku', system: 'S', messages: [{ text: 'q' }], params }, { caching: false });
    expect(claude.config.modules.prompt_templating.model.params).toEqual({ temperature: 0, max_tokens: 50 });
    const gemini = buildCompletionPayload({ model: 'gemini-3.5-flash-lite', system: 'S', messages: [{ text: 'q' }], params }, { caching: false });
    expect(gemini.config.modules.prompt_templating.model.params).toEqual({ temperature: 0, top_p: 1, max_tokens: 50 });
    expect(params).toEqual({ temperature: 0, top_p: 1, max_tokens: 50 });
  });
});

describe('image parts', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

  it('images go in messages_history as image_url data-URL parts, before the message text; never in the template', () => {
    const p = buildCompletionPayload({
      model: 'gemini-3.8-flash', system: 'TRANSCRIBE {{?x}}',
      messages: [{ text: 'Page 3.', images: [PNG, JPEG] }],
      params: { temperature: 0, max_tokens: 4096 },
    }, { caching: false });
    expect(p.messages_history).toEqual([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'image_url', image_url: { url: JPEG } },
        { type: 'text', text: 'Page 3.' },
      ],
    }]);
    const template = JSON.stringify(p.config.modules.prompt_templating.prompt.template);
    expect(template).not.toContain('image_url');
    expect(template).not.toContain('base64');
    expect(p.config.modules.prompt_templating.prompt.template).toEqual([{ role: 'system', content: [{ type: 'text', text: 'TRANSCRIBE {{?x}}' }] }]);
  });

  it('a message without images keeps its text-only shape', () => {
    const p = buildCompletionPayload({ model: 'gemini-3.8-flash', system: 'S', messages: [{ text: 'q', images: [] }] }, { caching: false });
    expect(p.messages_history).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
  });

  it('with caching on, the breakpoint lands on a text block, never on an image part', () => {
    const p = buildCompletionPayload({
      model: 'anthropic--claude-4.5-haiku', system: 'S',
      messages: [{ text: 'first', images: [PNG] }, { text: 'second', images: [PNG] }],
    }, { caching: true });
    const [first, second] = p.messages_history as any[];
    expect(first.content[0].cache_control).toBeUndefined();
    expect(first.content[1]).toEqual({ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(second)).not.toContain('cache_control');
  });

  it('refuses anything but a base64 PNG/JPEG/WebP/GIF data URL (no remote URL, no other data)', () => {
    for (const bad of ['https://example.test/a.png', 'data:text/plain;base64,aGk=', 'data:image/png,raw', 'data:image/svg+xml;base64,PHN2Zz4=', '']) {
      expect(() => buildCompletionPayload({ model: 'm', system: 'S', messages: [{ text: 't', images: [bad] }] }, { caching: false }))
        .toThrow(/data URL/);
    }
  });

  it('orchestrationComplete sends the image parts and never puts them in the template', async () => {
    mockPost.mockResolvedValue(reply('# Title'));
    await orchestrationComplete({ model: 'gemini-3.8-flash', system: 'S', messages: [{ text: 'Page 1.', images: [PNG] }], timeoutMs: 1000 });
    const body = mockPost.mock.calls[0][1] as any;
    expect(body.messages_history[0].content[0]).toEqual({ type: 'image_url', image_url: { url: PNG } });
    expect(JSON.stringify(body.config)).not.toContain('base64');
  });
});

describe('promptCachingFor (resolvePromptCachingSupport)', () => {
  it('Claude on by default, Gemini and OpenAI off by default', () => {
    expect(promptCachingFor('anthropic--claude-4.5-haiku')).toBe(true);
    expect(promptCachingFor('anthropic--claude-4.5-haiku--deployed')).toBe(true);
    expect(promptCachingFor('gemini-3.5-flash-lite')).toBe(false);
    expect(promptCachingFor('gpt-5-mini')).toBe(false);
    expect(promptCachingFor('amazon--nova-lite')).toBe(false);
  });

  it('config overrides win: a model flag, then a provider flag', () => {
    mockCachingFlags = { model: false };
    expect(promptCachingFor('anthropic--claude-4.5-haiku')).toBe(false);
    mockCachingFlags = { provider: { 'aws-bedrock': true } };
    expect(promptCachingFor('amazon--nova-lite')).toBe(true);
    mockCachingFlags = { provider: { google: true } };
    expect(promptCachingFor('gemini-3.5-flash-lite')).toBe(true);
  });
});

describe('foldCompletionUsage: {input (uncached incl. cache writes), cacheWrite, cachedRead, output}', () => {
  it('Claude (EXCLUSIVE): prompt_tokens is the uncached tail; writes and reads come on top', () => {
    // Write turn, measured shape 2026-09-30: prompt 13, creation 11266.
    expect(foldCompletionUsage('anthropic--claude-4.5-haiku', {
      prompt_tokens: 13, completion_tokens: 40, prompt_tokens_details: { cache_creation_tokens: 11266 },
    })).toEqual({ input: 11279, cacheWrite: 11266, cachedRead: 0, output: 40 });
    // Read turn: prompt 13, cached 11266.
    expect(foldCompletionUsage('anthropic--claude-4.5-haiku', {
      prompt_tokens: 13, completion_tokens: 38, prompt_tokens_details: { cached_tokens: 11266 },
    })).toEqual({ input: 13, cacheWrite: 0, cachedRead: 11266, output: 38 });
  });

  it('Gemini (INCLUSIVE): prompt_tokens contains the cached read', () => {
    expect(foldCompletionUsage('gemini-3.5-flash-lite', {
      prompt_tokens: 2062, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 2034 },
    })).toEqual({ input: 28, cacheWrite: 0, cachedRead: 2034, output: 30 });
  });

  it('OpenAI family (INCLUSIVE): same rule; no cache details → everything is input', () => {
    expect(foldCompletionUsage('gpt-5-mini', {
      prompt_tokens: 1982, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 1920 },
    })).toEqual({ input: 62, cacheWrite: 0, cachedRead: 1920, output: 12 });
    expect(foldCompletionUsage('gpt-4.1-mini', { prompt_tokens: 100, completion_tokens: 5 }))
      .toEqual({ input: 100, cacheWrite: 0, cachedRead: 0, output: 5 });
  });

  it('input + cachedRead is always the whole prompt, under both regimes', () => {
    const claude = foldCompletionUsage('anthropic--claude-4.5-haiku', {
      prompt_tokens: 20, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 500, cache_creation_tokens: 300 },
    });
    expect(claude.input + claude.cachedRead).toBe(820);
    const gemini = foldCompletionUsage('gemini-3.5-flash-lite', {
      prompt_tokens: 820, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 500, cache_creation_tokens: 300 },
    });
    expect(gemini.input + gemini.cachedRead).toBe(820);
    expect(gemini.cacheWrite).toBe(300);
  });

  it('missing or malformed usage folds to zeros', () => {
    expect(foldCompletionUsage('gemini-3.5-flash-lite', undefined)).toEqual({ input: 0, cacheWrite: 0, cachedRead: 0, output: 0 });
    expect(foldCompletionUsage('gemini-3.5-flash-lite', { prompt_tokens: 'x' })).toEqual({ input: 0, cacheWrite: 0, cachedRead: 0, output: 0 });
  });
});

describe('orchestrationComplete', () => {
  it('posts to the discovered deployment with the resource group, returns trimmed text and folded usage', async () => {
    mockPost.mockResolvedValueOnce(reply('  the answer  ', { prompt_tokens: 10, completion_tokens: 3 }));
    const r = await orchestrationComplete({ model: 'gemini-3.5-flash-lite', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 });
    expect(r.text).toBe('the answer');
    expect(r.usage).toEqual({ input: 10, cacheWrite: 0, cachedRead: 0, output: 3 });
    expect(typeof r.elapsedMs).toBe('number');
    const [url, , cfg] = mockPost.mock.calls[0];
    expect(url).toBe('https://sap.example/v2/inference/deployments/dep-1/v2/completion');
    expect(cfg.headers).toMatchObject({ 'Authorization': 'Bearer test-token', 'AI-Resource-Group': 'rg-1' });
    expect(cfg.signal).toBeDefined();
  });

  it('applies breakpoints for Claude without being asked', async () => {
    mockPost.mockResolvedValueOnce(reply('x'));
    await orchestrationComplete({ model: 'anthropic--claude-4.5-haiku', system: 'S', messages: [{ text: 'D' }, { text: 'C' }], timeoutMs: 5000 });
    expect(mockPost.mock.calls[0][1].messages_history[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('no deployment → CompletionError no_deployment, no request', async () => {
    getDeploymentIdMock.mockResolvedValue(null);
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 }))
      .rejects.toMatchObject({ reason: 'no_deployment' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('an HTTP error → request_failed with the status', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { status: 400 };
    mockPost.mockRejectedValueOnce(err);
    const p = orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 });
    await expect(p).rejects.toBeInstanceOf(CompletionError);
    await expect(p).rejects.toMatchObject({ reason: 'request_failed', status: 400 });
  });

  it('an empty or non-string reply → empty_response, carrying the usage that was spent', async () => {
    mockPost.mockResolvedValueOnce(reply('   ', { prompt_tokens: 7, completion_tokens: 0 }));
    await expect(orchestrationComplete({ model: 'gemini-3.5-flash-lite', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 }))
      .rejects.toMatchObject({ reason: 'empty_response', usage: { input: 7, cacheWrite: 0, cachedRead: 0, output: 0 } });
    mockPost.mockResolvedValueOnce(reply(42));
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 }))
      .rejects.toMatchObject({ reason: 'empty_response' });
  });

  it("finish_reason 'length' → truncated, carrying the usage; the cut text is not returned", async () => {
    mockPost.mockResolvedValueOnce({ data: { final_result: {
      choices: [{ message: { content: 'This chunk is about the inst' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 200 },
    } } });
    await expect(orchestrationComplete({ model: 'gemini-3.5-flash-lite', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 }))
      .rejects.toMatchObject({ reason: 'truncated', usage: { input: 900, cacheWrite: 0, cachedRead: 0, output: 200 } });
    mockPost.mockResolvedValueOnce({ data: { final_result: { choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }] } } });
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000 }))
      .resolves.toMatchObject({ text: 'Done.' });
  });

  it('a signal aborted while the deployment is being discovered sends nothing', async () => {
    const ac = new AbortController();
    getDeploymentIdMock.mockImplementationOnce(async () => { ac.abort(); return 'dep-1'; });
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000, signal: ac.signal }))
      .rejects.toMatchObject({ reason: 'aborted' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('the per-call timeout aborts the request → timeout', async () => {
    mockPost.mockImplementationOnce((_u: any, _b: any, cfg: any) => new Promise((_res, rej) => {
      cfg.signal.addEventListener('abort', () => rej(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    }));
    const t0 = Date.now();
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 50 }))
      .rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('an outer AbortSignal aborts the request → aborted', async () => {
    mockPost.mockImplementationOnce((_u: any, _b: any, cfg: any) => new Promise((_res, rej) => {
      cfg.signal.addEventListener('abort', () => rej(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    }));
    const ac = new AbortController();
    const p = orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 60000, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('an already-aborted signal sends nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(orchestrationComplete({ model: 'm', system: 'S', messages: [{ text: 'q' }], timeoutMs: 5000, signal: ac.signal }))
      .rejects.toMatchObject({ reason: 'aborted' });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
