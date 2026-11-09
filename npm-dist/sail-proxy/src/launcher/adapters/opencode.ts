import { join } from 'path';
import { homedir } from 'os';
import { HarnessAdapter, LaunchContext, LaunchPlan } from './types';
import { resolveBinary } from '../which';

export const opencodeAdapter: HarnessAdapter = {
  name: 'opencode',
  async locate() {
    return resolveBinary('opencode', 'Install opencode: npm i -g opencode-ai (or https://opencode.ai).');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    // Use @ai-sdk/openai (the Responses API), NOT @ai-sdk/openai-compatible
    // (chat/completions). gpt-5.6-sol serves tool-rich agent turns on the
    // gateway's /responses route; the chat/completions path routes through SAP
    // orchestration streaming and fails for opencode's requests. Verified live.
    const provider = {
      npm: '@ai-sdk/openai',
      options: { baseURL: `${ctx.rootUrl}/openai/v1`, apiKey: ctx.apiKey },
      models: { 'gpt-5.6-sol': {} },
    };
    return {
      fileEdits: [{
        file: join(homedir(), '.config', 'opencode', 'opencode.json'),
        format: 'json',
        blocks: { 'provider.sail-proxy': JSON.stringify(provider) },
      }],
      env: {},
      notes: ['opencode uses the Responses API via @ai-sdk/openai; select the model with -m sail-proxy/gpt-5.6-sol.'],
      argv: [...passthrough],
    };
  },
};
