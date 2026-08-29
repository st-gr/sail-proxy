import { HarnessAdapter, LaunchContext, LaunchPlan } from './types';
import { resolveBinary } from '../which';

export const claudeAdapter: HarnessAdapter = {
  name: 'claude',
  async locate() {
    return resolveBinary('claude', 'Install Claude Code: https://claude.com/claude-code.');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    return {
      fileEdits: [],
      env: {
        ANTHROPIC_BASE_URL: ctx.rootUrl,                 // Claude Code appends /v1/messages itself
        ANTHROPIC_AUTH_TOKEN: ctx.apiKey,                // Authorization: Bearer (matches sail-proxy sk- keys)
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',   // no telemetry/auto-update bypassing the gateway
      },
      notes: [],
      argv: [...passthrough],
    };
  },
};
