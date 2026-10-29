/**
 * Live proof of the `anthropic` connection adapter against the real Anthropic API (B2a).
 * Opt-in and never in CI:
 *
 *   CONNECTIONS_LIVE=1 pnpm exec cross-env NODE_ENV=test jest --config jest.config.json test/live/anthropic-connection.live.test.ts
 *
 * Reads ANTHROPIC_API_KEY from the environment, else from GATEWAY_ENV_FILE (default ../../.env). Prints
 * statuses and token counts only, never the key or a response text. Costs a few cents' worth of
 * claude-haiku-4-5 tokens.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { describe, it, expect } from '@jest/globals';

const LIVE = process.env.CONNECTIONS_LIVE === '1';
if (LIVE && !process.env.ANTHROPIC_API_KEY) {
  dotenv.config({ path: process.env.GATEWAY_ENV_FILE || path.resolve(__dirname, '../../.env'), override: false });
}

import { adapterFor } from '../../src/upstreams';
import type { Connection } from '../../src/connections/types';

const MODEL = 'claude-haiku-4-5-20251001';
const suite = LIVE ? describe : describe.skip;
const connection = (): Connection => ({
  id: 'live-an', name: 'an', providerType: 'anthropic', isActive: true,
  settings: { baseUrl: 'https://api.anthropic.com' }, credentials: { secret: process.env.ANTHROPIC_API_KEY || '' }, models: [],
});
const post = async (body: any, stream = false) => {
  const r = await adapterFor(connection())!.buildRequest('messages', body, MODEL);
  return axios.post(r.url, r.body, { headers: r.headers, timeout: 60000, responseType: stream ? 'text' : 'json' });
};

suite('anthropic connection, live', () => {
  it('has a key', () => { expect((process.env.ANTHROPIC_API_KEY || '').length).toBeGreaterThan(20); });

  it('testConnection is ok', async () => {
    expect(await adapterFor(connection())!.testConnection()).toEqual({ ok: true });
  });

  it(`listModels contains ${MODEL}`, async () => {
    const models = await adapterFor(connection())!.listModels();
    console.log(`listModels: ${models.length} ids`);
    expect(models).toContain(MODEL);
  });

  it('a non-streaming message returns usage', async () => {
    const r = await post({ model: 'x', messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 16 });
    console.log(`messages: ${r.status} input=${r.data.usage?.input_tokens} output=${r.data.usage?.output_tokens}`);
    expect(r.status).toBe(200);
    expect(r.data.usage.input_tokens).toBeGreaterThan(0);
  });

  it('a streamed message runs from message_start to message_stop with usage', async () => {
    const r = await post({ model: 'x', stream: true, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 16 }, true);
    const text = String(r.data);
    const events = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7).trim());
    const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const usage = data.find((d) => d.type === 'message_delta')?.usage;
    console.log(`messages stream: ${r.status} events=${events.length} output=${usage?.output_tokens}`);
    expect(events[0]).toBe('message_start');
    expect(events[events.length - 1]).toBe('message_stop');
    expect(usage?.output_tokens).toBeGreaterThan(0);
  });
});
