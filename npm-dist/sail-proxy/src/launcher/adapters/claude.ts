import axios from 'axios';
import { HarnessAdapter, LaunchContext, LaunchPlan } from './types';
import { resolveBinary } from '../which';

// Claude Code's built-in default model follows Anthropic's newest release (claude-opus-5-5 in 2.1.312),
// which SAP AI Core does not serve, so a plain launch failed on its first prompt. The launcher pins
// Claude Code's main and opus/sonnet/haiku default models to the newest Claude models the tenant lists.
const FAMILIES = ['opus', 'sonnet', 'haiku'] as const;
type Family = typeof FAMILIES[number];
const DEPLOYED = '--deployed';

function versionOf(id: string): number[] | null {
  const m = /^anthropic--claude-(\d+(?:\.\d+)*)-([a-z]+)(?:--deployed)?$/.exec(id);
  return m ? m[1].split('.').map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest model of each Claude family in the gateway's list (`anthropic--claude-<version>-<family>`),
 * preferring its `--deployed` twin: the deployment path keeps Anthropic's native behaviour, such as
 * cache_control. Ids of another shape are ignored; a family the tenant lacks is left out.
 */
export function pickClaudeModels(ids: string[]): Partial<Record<Family, string>> {
  const best: Partial<Record<Family, { version: number[]; id: string }>> = {};
  for (const id of ids) {
    const version = versionOf(id);
    const family = /-([a-z]+)(?:--deployed)?$/.exec(id)?.[1] as Family;
    if (!version || !FAMILIES.includes(family)) continue;
    const cur = best[family];
    const cmp = cur ? compareVersions(version, cur.version) : 1;
    if (cmp > 0 || (cmp === 0 && id.endsWith(DEPLOYED) && cur && !cur.id.endsWith(DEPLOYED))) best[family] = { version, id };
  }
  const out: Partial<Record<Family, string>> = {};
  for (const f of FAMILIES) if (best[f]) out[f] = best[f]!.id;
  return out;
}

function hasModelFlag(argv: string[]): boolean {
  return argv.some(a => a === '--model' || a.startsWith('--model='));
}

export const claudeAdapter: HarnessAdapter = {
  name: 'claude',
  async locate() {
    return resolveBinary('claude', 'Install Claude Code: https://claude.com/claude-code.');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: `${ctx.rootUrl}/anthropic`,  // Claude Code appends /v1/messages itself
      ANTHROPIC_AUTH_TOKEN: ctx.apiKey,                // Authorization: Bearer (matches sail-proxy sk- keys)
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',   // no telemetry/auto-update bypassing the gateway
    };
    const notes: string[] = [];
    if (ctx.dryRun) {
      notes.push('Dry run: the real launch pins Claude Code\'s models to the newest Claude models the gateway lists.');
      return { fileEdits: [], env, notes, argv: [...passthrough] };
    }
    let picked: Partial<Record<Family, string>> = {};
    try {
      const res = await axios.get(`${ctx.rootUrl}/anthropic/v1/models`, {
        headers: { Authorization: `Bearer ${ctx.apiKey}` }, timeout: 4000,
      });
      picked = pickClaudeModels((res.data?.data || []).map((m: { id: string }) => m.id));
    } catch (e: any) {
      notes.push(`Could not read the gateway's Claude models (${e.message}); pass --model with a model the gateway serves.`);
    }
    // A model the user chose (--model, or a variable they exported) wins over the pinned one.
    const pin = (name: string, value: string | undefined) => {
      if (value && process.env[name] === undefined) env[name] = value;
    };
    if (!hasModelFlag(passthrough)) pin('ANTHROPIC_MODEL', picked.opus || picked.sonnet);
    pin('ANTHROPIC_DEFAULT_OPUS_MODEL', picked.opus);
    pin('ANTHROPIC_DEFAULT_SONNET_MODEL', picked.sonnet);
    pin('ANTHROPIC_DEFAULT_HAIKU_MODEL', picked.haiku);
    pin('ANTHROPIC_SMALL_FAST_MODEL', picked.haiku);
    if (!notes.length && !Object.keys(picked).length) {
      notes.push('The gateway lists no Claude models for this key; pass --model with a model the gateway serves.');
    }
    return { fileEdits: [], env, notes, argv: [...passthrough] };
  },
};
