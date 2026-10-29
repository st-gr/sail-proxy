/**
 * Live proof of the `openai` connection adapter against the real OpenAI API (spec 2026-10-23 §9, B1).
 * Opt-in and never in CI:
 *
 *   CONNECTIONS_LIVE=1 pnpm exec cross-env NODE_ENV=test jest --config jest.config.json test/live/openai-connection.live.test.ts
 *
 * Reads OPENAI_API_KEY from the environment, else from GATEWAY_ENV_FILE (default ../../.env). Prints
 * statuses and token counts only, never the key or a response text. Costs a few cents' worth of
 * gpt-4o-mini and text-embedding-3-small tokens.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { describe, it, expect } from '@jest/globals';

const LIVE = process.env.CONNECTIONS_LIVE === '1';
if (LIVE && !process.env.OPENAI_API_KEY) {
  dotenv.config({ path: process.env.GATEWAY_ENV_FILE || path.resolve(__dirname, '../../.env'), override: false });
}

import { adapterFor } from '../../src/upstreams';
import type { Connection } from '../../src/connections/types';

const suite = LIVE ? describe : describe.skip;
const connection = (): Connection => ({
  id: 'live-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: 'https://api.openai.com/v1' }, credentials: { secret: process.env.OPENAI_API_KEY || '' }, models: [],
});
const post = async (route: 'chat' | 'responses' | 'embeddings', body: any, upstream: string, stream = false) => {
  const r = await adapterFor(connection())!.buildRequest(route, body, upstream);
  return axios.post(r.url, r.body, { headers: r.headers, timeout: 60000, responseType: stream ? 'text' : 'json' });
};

suite('openai connection, live', () => {
  it('has a key', () => { expect((process.env.OPENAI_API_KEY || '').length).toBeGreaterThan(20); });

  it('testConnection is ok', async () => {
    expect(await adapterFor(connection())!.testConnection()).toEqual({ ok: true });
  });

  it('listModels contains gpt-4o-mini', async () => {
    const models = await adapterFor(connection())!.listModels();
    console.log(`listModels: ${models.length} ids`);
    expect(models).toContain('gpt-4o-mini');
  });

  it('a non-streaming chat returns usage', async () => {
    const r = await post('chat', { model: 'gpt-4o-mini--oa', messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }, 'gpt-4o-mini');
    console.log(`chat: ${r.status} prompt=${r.data.usage?.prompt_tokens} completion=${r.data.usage?.completion_tokens}`);
    expect(r.status).toBe(200);
    expect(r.data.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('a streaming chat ends with a usage frame', async () => {
    const r = await post('chat', { model: 'x', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }, 'gpt-4o-mini', true);
    const frames = String(r.data).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
    const usage = frames.find((f) => f.usage)?.usage;
    console.log(`chat stream: ${r.status} frames=${frames.length} prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens}`);
    expect(usage?.prompt_tokens).toBeGreaterThan(0);
    expect(String(r.data)).toContain('data: [DONE]');
  });

  it('a Responses call returns output text', async () => {
    const r = await post('responses', { model: 'x', input: 'Say OK.', max_output_tokens: 16 }, 'gpt-4o-mini');
    console.log(`responses: ${r.status} input=${r.data.usage?.input_tokens} output=${r.data.usage?.output_tokens}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.output)).toBe(true);
  });

  it('one embedding call of 2 inputs returns 2 vectors', async () => {
    const r = await post('embeddings', { model: 'x', input: ['alpha', 'beta'] }, 'text-embedding-3-small');
    console.log(`embeddings: ${r.status} vectors=${r.data.data?.length} prompt=${r.data.usage?.prompt_tokens}`);
    expect(r.data.data).toHaveLength(2);
  });
});
