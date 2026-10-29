/**
 * Shared harness for the forced-pseudonymization route suites
 * (pseudonymization-forced-no-hooks, pseudonymization-gemini-embed-exempt): request/response
 * doubles, a model catalogue, one runner per plugin-running route and configuration builders.
 *
 * The suites mock configService, modelService and the upstream seams themselves (jest.mock must
 * sit in the test file); this module only drives the real controllers.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { handleChatCompletion } from '../src/controllers/openaiController';
import { handleGemini } from '../src/controllers/googleController';
import { handleChatCompletions as handleOpenRouterChat } from '../src/controllers/openRouterController';
import { handleResponses } from '../src/controllers/responsesController';
import { handleMessages } from '../src/controllers/anthropicController';
import { handleBedrockRequest } from '../src/controllers/awsBedrockController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

export const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

export const EMAIL = 'jane.roe@example.org';
export const TEXT = `Please email ${EMAIL} about the invoice.`;
export const PSEUDONYMIZATION_HOOK = { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } };
export const ENDPOINTS = ['openai', 'anthropic', 'aws-bedrock', 'google'];

const ORCHESTRATION = [{ scenarioId: 'orchestration' }];

/** The catalogue the suites' modelService mock answers from. */
export function catalogueDetails(m: string): any {
  if (m === 'gemini-embedding') return { id: m, model: m, owned_by: 'Google', allowedScenarios: ORCHESTRATION, versions: [{ capabilities: ['embedding'] }] };
  if (m === 'bedrock-claude--deployed') return { id: m, owned_by: 'anthropic', executableId: 'aws-bedrock', accessType: 'deployment', deploymentUrl: 'https://deployed.example.com/bedrock' };
  if (m === 'bedrock-claude') return { id: m, owned_by: 'anthropic', executableId: 'aws-bedrock' };
  if (m === 'claude-sonnet-4--deployed') return { id: m, owned_by: 'anthropic', provider: 'anthropic', accessType: 'deployment', deploymentUrl: 'https://deployed.example.com/claude' };
  if (m.startsWith('claude')) return { id: m, owned_by: 'anthropic', provider: 'anthropic' };
  if (m.endsWith('--deployed')) return { id: m, owned_by: 'openai', provider: 'openai', deploymentUrl: 'https://deployed.example.com/v1', model: m.replace(/--deployed$/, '') };
  if (m === 'gpt-4o') return { id: m, model: m, owned_by: 'openai', provider: 'openai', allowedScenarios: ORCHESTRATION };
  return null;
}

export function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[],
    writable: true, writableEnded: false, headersSent: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.getHeader = (k: string) => r.headers[k];
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.writes.push(s); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

export function mockReq(body: any, url: string, params: Record<string, string> = {}) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = { 'content-type': 'application/json' };
  r.query = {};
  r.params = params;
  r.originalUrl = url;
  r.path = url;
  r.method = 'POST';
  return r;
}

export async function run(handler: (req: any, res: any, next: any) => Promise<any>, req: any) {
  const res = mockRes();
  const next = jest.fn((err?: any) => { if (err && !res.headersSent) res.status(err.status || 500).json({ error: { message: String(err.message) } }); });
  await handler(req, res, next);
  return res;
}

const chatBody = (model: string, extra: any = {}) => ({ model, messages: [{ role: 'user', content: TEXT }], ...extra });
const geminiBody = () => ({ contents: [{ role: 'user', parts: [{ text: TEXT }] }] });
const anthropicBody = (model: string) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: TEXT }] });
const converseBody = () => ({ messages: [{ role: 'user', content: [{ text: TEXT }] }] });
const invokeBody = () => ({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [{ role: 'user', content: TEXT }] });
const gemini = (model: string, method: string) => run(handleGemini,
  mockReq(geminiBody(), `/google/v1beta/models/${model}:${method}`, { modelAndMethod: `${model}:${method}` }));
const bedrock = (model: string, subpath: string, body: any) => run(handleBedrockRequest,
  mockReq(body, `/aws-bedrock/model/${model}/${subpath}`, { modelId: model, subpath }));

/** Every route that runs the plugin chain, with the endpoint whose force flag is its own. */
export interface ForcedRoute { name: string; endpoint: string; run: () => Promise<any> }
export const ROUTES: ForcedRoute[] = [
  { name: 'orchestration chat', endpoint: 'openai', run: () => run(handleChatCompletion, mockReq(chatBody('gpt-4o'), '/openai/v1/chat/completions')) },
  { name: 'orchestration chat, streaming', endpoint: 'openai', run: () => run(handleChatCompletion, mockReq(chatBody('gpt-4o', { stream: true }), '/openai/v1/chat/completions')) },
  { name: 'OpenRouter chat', endpoint: 'openai', run: () => run(handleOpenRouterChat, mockReq(chatBody('openai/gpt-4o'), '/openrouter/api/v1/chat/completions')) },
  { name: 'deployed chat', endpoint: 'openai', run: () => run(handleChatCompletion, mockReq(chatBody('gpt-4o--deployed'), '/openai/v1/chat/completions')) },
  { name: '/responses', endpoint: 'openai', run: () => run(handleResponses, mockReq({ model: 'gpt-5--deployed', input: TEXT }, '/openai/v1/responses')) },
  { name: 'Anthropic messages', endpoint: 'anthropic', run: () => run(handleMessages, mockReq(anthropicBody('claude-sonnet-4'), '/anthropic/v1/messages')) },
  { name: 'Anthropic messages, deployed', endpoint: 'anthropic', run: () => run(handleMessages, mockReq(anthropicBody('claude-sonnet-4--deployed'), '/anthropic/v1/messages')) },
  { name: 'Gemini generateContent', endpoint: 'google', run: () => gemini('gpt-4o', 'generateContent') },
  { name: 'Gemini streamGenerateContent', endpoint: 'google', run: () => gemini('gpt-4o', 'streamGenerateContent') },
  { name: 'Bedrock invoke, deployed', endpoint: 'aws-bedrock', run: () => bedrock('bedrock-claude--deployed', 'invoke', invokeBody()) },
  { name: 'Bedrock converse, deployed', endpoint: 'aws-bedrock', run: () => bedrock('bedrock-claude--deployed', 'converse', converseBody()) },
  { name: 'Bedrock converse, through orchestration', endpoint: 'aws-bedrock', run: () => bedrock('bedrock-claude', 'converse', converseBody()) },
  { name: 'Bedrock invoke, through orchestration', endpoint: 'aws-bedrock', run: () => bedrock('bedrock-claude', 'invoke', invokeBody()) },
];
export const route = (name: string) => ROUTES.find((r) => r.name === name)!;

/**
 * A configuration forcing exactly `forced` endpoints, with the given hook chains
 * (`{ endpoint: { subpath: chain } }`) and no others.
 */
export function configFor(forced: string[], chains: Record<string, Record<string, any[]>> = {}) {
  const defaults = Object.fromEntries(ENDPOINTS.map((e) => [e, {
    pseudonymization: { enabled: forced.includes(e), method: 'pseudonymization', allow_user_bypass: false },
    ...(chains[e] || {}),
  }]));
  return { hooks: { definitions: shippedHooks.definitions, defaults }, models: { overrides: {} as Record<string, any> }, observability: {} };
}

/** Register the real pseudonymization rules, plus any test plugins (`{ id: handler }`). */
export function registerPlugins(extra: Record<string, (ctx: any) => Promise<any>> = {}) {
  (global as any).pluginRegistry = {};
  (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
    (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
  });
  for (const [id, handler] of Object.entries(extra)) {
    (global as any).pluginRegistry[`${id}_before_x`] = { id, strategy: 'before', match: [], handler };
  }
}
