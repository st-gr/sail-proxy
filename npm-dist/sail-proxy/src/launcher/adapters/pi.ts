import { join } from 'path';
import { homedir } from 'os';
import axios from 'axios';
import { HarnessAdapter, LaunchContext, LaunchPlan, NamespacedEdit } from './types';
import { resolveBinary } from '../which';

// pi keeps custom providers in ~/.pi/agent/models.json. The launcher writes ONE provider,
// `sail-proxy`, on the Responses API (`/openai/v1/responses`): the route Codex and opencode
// already use, which serves a deployed GPT model natively and bridges every other model
// (Claude, Gemini, Mistral, …) through SAP orchestration itself. Every other key in the
// file is left alone (config-writer edits only the named JSON path).
const KEY_ENV = 'SAILPROXY_KEY';
export const PROVIDER = 'sail-proxy';
export const DEFAULT_MODEL = 'gpt-5.6-sol';   // /responses resolves it to gpt-5.6-sol--deployed, as for codex/opencode
const DEPLOYED = '--deployed';

export interface PiModel {
  id: string; name: string; reasoning: boolean; input: string[]; contextWindow: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** The built-in entries used when the gateway's list is not available (dry runs, gateway down). */
export const FALLBACK_MODELS: PiModel[] = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, input: ['text', 'image'], contextWindow: 1050000 },
  { id: 'anthropic--claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1000000 },
];

/**
 * Map the gateway's /v1/models list (OpenAI list shape with SAP extended attributes) to pi model
 * entries: chat models only, one entry per model (a `--deployed` id is dropped when its base id is
 * listed — the Responses route resolves the base id to its deployment itself), metadata from the
 * latest catalog version.
 */
export function toPiModels(list: any): PiModel[] {
  const items: any[] = Array.isArray(list?.data) ? list.data : [];
  const ids = new Set<string>(items.map(m => m?.id).filter((id: any) => typeof id === 'string'));
  const out: PiModel[] = [];
  for (const m of items) {
    if (typeof m?.id !== 'string') continue;
    if (m.id.endsWith(DEPLOYED) && ids.has(m.id.slice(0, -DEPLOYED.length))) continue;
    const versions: any[] = Array.isArray(m.versions) ? m.versions : [];
    const v = versions.find(x => x?.isLatest) || versions[0] || {};
    const caps: string[] = Array.isArray(v.capabilities) ? v.capabilities : [];
    if (versions.length && !caps.includes('text-generation')) continue;   // embeddings, rerankers, image generation
    const inputTypes: string[] = Array.isArray(v.inputTypes) ? v.inputTypes : ['text'];
    const model: PiModel = {
      id: m.id,
      name: typeof m.displayName === 'string' && m.displayName ? m.displayName : m.id,
      reasoning: caps.includes('reasoning'),
      input: inputTypes.filter(t => t === 'text' || t === 'image'),
      contextWindow: Number(v.contextLength) > 0 ? Number(v.contextLength) : 128000,
    };
    if (!model.input.length) model.input = ['text'];
    const cost = Array.isArray(v.cost) ? Object.assign({}, ...v.cost) : null;   // SAP lists $ per 1k tokens
    if (cost && cost.inputCost !== undefined && cost.outputCost !== undefined) {
      const perMillion = (x: any) => Math.round(Number(x || 0) * 1000 * 1e6) / 1e6;
      model.cost = { input: perMillion(cost.inputCost), output: perMillion(cost.outputCost),
        cacheRead: perMillion(cost.cacheReadInputCost), cacheWrite: perMillion(cost.cacheCreationInputCost) };
    }
    out.push(model);
  }
  return out;
}

/** The models.json edit: the one `sail-proxy` provider block with every listed model. */
export function modelsEdit(rootUrl: string, models: PiModel[]): NamespacedEdit {
  const provider = { baseUrl: `${rootUrl}/openai/v1`, api: 'openai-responses', apiKey: KEY_ENV, models };
  return {
    file: join(homedir(), '.pi', 'agent', 'models.json'),
    format: 'json',
    blocks: { [`providers.${PROVIDER}`]: JSON.stringify(provider) },
  };
}

/** True when the caller already chose a model or provider (`--model x`, `--model=x`, `--provider x`). */
export function hasModelFlag(argv: string[]): boolean {
  return argv.some(a => a === '--model' || a.startsWith('--model=') || a === '--provider' || a.startsWith('--provider='));
}

/** `sail-proxy/<id>` for the default model, or the first listed model when the default is not in the list. */
export function defaultModelArg(models: PiModel[]): string | null {
  const pick = models.find(m => m.id === DEFAULT_MODEL) || models[0];
  return pick ? `${PROVIDER}/${pick.id}` : null;
}

async function fetchModels(ctx: LaunchContext): Promise<{ models: PiModel[]; note?: string }> {
  try {
    const res = await axios.get(`${ctx.rootUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${ctx.apiKey}` }, timeout: 4000,
    });
    const models = toPiModels(res.data);
    if (models.length) return { models };
    return { models: FALLBACK_MODELS, note: `The gateway listed no chat models; wrote the built-in defaults.` };
  } catch (e: any) {
    return { models: FALLBACK_MODELS,
      note: `Could not read the gateway's model list (${e.message}); wrote the built-in defaults. Rerun once the gateway answers to list every model.` };
  }
}

export const piAdapter: HarnessAdapter = {
  name: 'pi',
  async locate() {
    return resolveBinary('pi', 'Install pi: npm i -g @mariozechner/pi-coding-agent (https://pi.dev).');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    // A dry run stays offline: it previews the built-in models. A real launch lists the gateway's
    // models so pi's /model picker shows exactly what the tenant can call.
    const { models, note } = ctx.dryRun
      ? { models: FALLBACK_MODELS, note: 'Dry run: the real launch replaces these defaults with the gateway\'s model list.' }
      : await fetchModels(ctx);
    const notes = [
      `pi reads the key from ${KEY_ENV}; run plain "pi" with that variable exported, or launch through sail-proxy.`,
      `Every model is under the ${PROVIDER} provider in ~/.pi/agent/models.json (Responses API); pick one with --model ${PROVIDER}/<id> or from /model.`,
    ];
    if (note) notes.unshift(note);
    const def = defaultModelArg(models);
    const argv = hasModelFlag(passthrough) || !def ? [...passthrough] : ['--model', def, ...passthrough];
    return { fileEdits: [modelsEdit(ctx.rootUrl, models)], env: { [KEY_ENV]: ctx.apiKey }, notes, argv };
  },
};
