// OPT-IN live probe: prompt caching for /anthropic/v1/messages on the SAP orchestration path
// (anthropicCacheBreakpoints.ts). Two identical calls per arm on liveModels.claude, straight to
// orchestration through sapAIService.completeChat (no gateway server, no Valkey, no admin):
//   A  the real builder (transformRequestToSAPFormat) with a marked system prompt: call 2 must
//      read the cache. This is the required live check.
//   B  a hand-built payload whose `tool` message content is [{type:'text', text, cache_control}]:
//      prints status + usage so the tool_result shape can be decided (no assertion).
//   C  arm A's payload with cache_control {type:'ephemeral', ttl:'1h'}: prints status +
//      cache_creation_token_details so the ttl handling can be decided (no assertion).
// Verdicts go to test/fixtures/orchestration/anthropic-cache-live-result.md.
//
// Skipped unless ANTHROPIC_CACHE_LIVE_PROBE=1. It spends real tokens: 3 arms × 2 calls × about
// 5.5k input tokens on a Haiku-class model — a few cents — and is never run by CI.
//
// RUNNING IT (from services/gateway):
//   ANTHROPIC_CACHE_LIVE_PROBE=1 GATEWAY_ENV_FILE=/path/to/services/gateway/.env \
//     pnpm exec cross-env NODE_ENV=test jest --config jest.config.json test/anthropic-cache-live.test.ts
// GATEWAY_ENV_FILE defaults to ../.env (this checkout's). Do NOT source it in the shell; this file
// loads it. VALKEY_URL and ADMIN_SERVICE_URL are blanked first so nothing here talks to a shared
// Valkey or admin. It prints usage objects and statuses, never credentials.
import * as path from 'path';
import * as dotenv from 'dotenv';

const LIVE = process.env.ANTHROPIC_CACHE_LIVE_PROBE === '1';
if (LIVE) {
  process.env.VALKEY_URL = '';
  process.env.ADMIN_SERVICE_URL = '';
  process.env.GATEWAY_STANDALONE = 'true';
  dotenv.config({ path: process.env.GATEWAY_ENV_FILE || path.resolve(__dirname, '../.env'), override: false });
}

import { describe, it, expect } from '@jest/globals';
import { liveModels } from '@libs/test-utils';
import { completeChat } from '../src/services/sapAIService';
import { transformRequestToSAPFormat } from '../src/services/anthropicService';
import { mapSapCacheUsageToAnthropic } from '../src/services/anthropicResponseService';

const live = LIVE ? describe : describe.skip;
const MODEL = liveModels.claude;
const EPHEMERAL = { type: 'ephemeral' };

/** ≥ 5k tokens, unique per arm and run so no earlier cache entry answers. */
function prefix(arm: string): string {
  const nonce = `${arm}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `Probe ${nonce}. ` + `Arm ${arm}: the lighthouse keeper logs tide, wind and visibility every hour without fail. `.repeat(400);
}

async function twice(payload: any): Promise<Array<{ status: number | string; usage: any }>> {
  const out = [];
  for (let i = 0; i < 2; i++) {
    try {
      const res = await completeChat(JSON.parse(JSON.stringify(payload)));
      out.push({ status: 200, usage: res?.final_result?.usage ?? res?.orchestration_result?.usage });
    } catch (e: any) {
      out.push({ status: e?.response?.status ?? e?.code ?? 'error', usage: JSON.stringify(e?.response?.data ?? e?.message).slice(0, 600) });
    }
  }
  return out;
}

live('anthropic → orchestration prompt caching (live)', () => {
  it('A: marked system prompt through the real builder — call 2 reads the cache', async () => {
    const payload = await transformRequestToSAPFormat({
      model: MODEL, max_tokens: 16,
      system: [{ type: 'text', text: prefix('A'), cache_control: EPHEMERAL }],
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    } as any);
    const runs = await twice(payload);
    console.log('ARM A', JSON.stringify(runs, null, 2));
    expect(runs[1].status).toBe(200);
    expect(mapSapCacheUsageToAnthropic(runs[1].usage).cache_read_input_tokens).toBeGreaterThan(0);
  }, 120000);

  const toolPayload = (toolContent: any) => ({
      config: { modules: { prompt_templating: {
        prompt: {
          template: [
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'Read the log with the read_log tool.' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_log', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: toolContent },
            { role: 'user', content: 'Reply with the single word OK.' },
          ],
          tools: [{ type: 'function', function: { name: 'read_log', description: 'Reads the log', parameters: { type: 'object', properties: {} } } }],
        },
        model: { name: MODEL, version: 'latest', params: { max_tokens: 16 } },
      } } },
      placeholder_values: {},
      messages_history: [],
    });

  it('B0: control — the same tool turn with plain string content (probe)', async () => {
    console.log('ARM B0', JSON.stringify(await twice(toolPayload(prefix('B0'))), null, 2));
  }, 120000);

  it('B: tool message content as marked text blocks (probe)', async () => {
    console.log('ARM B', JSON.stringify(await twice(toolPayload([{ type: 'text', text: prefix('B'), cache_control: EPHEMERAL }])), null, 2));
  }, 120000);

  it('B2: tool message content as unmarked text blocks (probe)', async () => {
    console.log('ARM B2', JSON.stringify(await twice(toolPayload([{ type: 'text', text: prefix('B2') }])), null, 2));
  }, 120000);

  it('D: assistant turn as marked text blocks, through the real builder (probe)', async () => {
    const payload = await transformRequestToSAPFormat({
      model: MODEL, max_tokens: 16,
      messages: [
        { role: 'user', content: 'Recite the log.' },
        { role: 'assistant', content: [{ type: 'text', text: prefix('D'), cache_control: EPHEMERAL }] },
        { role: 'user', content: 'Reply with the single word OK.' },
      ],
    } as any);
    console.log('ARM D', JSON.stringify(await twice(payload), null, 2));
  }, 120000);

  it('E: assistant tool_calls turn with marked text blocks (probe)', async () => {
    const payload = toolPayload('sunny');
    payload.config.modules.prompt_templating.prompt.template[2].content = [{ type: 'text', text: prefix('E'), cache_control: EPHEMERAL }] as any;
    console.log('ARM E', JSON.stringify(await twice(payload), null, 2));
  }, 120000);

  it('C: ttl 1h on the system breakpoint (probe)', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: MODEL, max_tokens: 16,
      system: [{ type: 'text', text: prefix('C'), cache_control: EPHEMERAL }],
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    } as any);
    payload.config.modules.prompt_templating.prompt.template[0].content[0].cache_control = { type: 'ephemeral', ttl: '1h' };
    console.log('ARM C', JSON.stringify(await twice(payload), null, 2));
  }, 120000);
});
