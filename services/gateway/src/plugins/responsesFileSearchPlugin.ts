/**
 * Responses API file-search plugin — the point at which `file_search` becomes reachable.
 *
 * SAP AI Core deployments reject the hosted `file_search` tool type outright, the same way
 * they reject `web_search`. This plugin registers the `file_search` descriptor onto the
 * shared hosted-tool engine, which rewrites the hosted entry into a plain function tool the
 * deployment accepts, runs the retrieval against this gateway's own vector stores, and
 * hands the client back the `file_search_call` shape it expects.
 *
 * A SHIM, and deliberately identical in shape to `responsesWebSearchPlugin.ts`: both export
 * the SAME two engine handlers under different plugin ids. That is what a second hosted
 * tool costs — one `registerDescriptor` call and two hook entries — and it is the whole
 * reason `hostedTool/engine.ts` was extracted.
 *
 * WHY TWO PLUGIN IDS FOR ONE ENGINE. The hook `match` arrays are the gate, and they differ:
 * this one is gated on `tools:hasFileSearch`, the web-search one on `tools:hasWebSearch`.
 * A request carrying only `file_search` matches only this entry — which is precisely why it
 * has to exist rather than widening the web-search entry's match.
 *
 * RUNNING TWICE IS SAFE, and a turn carrying BOTH hosted tools does exactly that (both hook
 * entries match, both call the same handlers). The engine is idempotent per request by
 * construction, not by accident:
 *   - `hostedToolBeforeHandler` returns immediately unless `body.tools` still holds a
 *     HOSTED tool entry, and the first pass rewrote every one of them into function tools.
 *   - `installHostedToolInterceptor` is guarded by its own flag on `res`.
 *   - `hostedToolAfterHandler` returns `upstreamResponse` untouched unless the output still
 *     holds a hosted-tool `function_call`, and the first pass replaced every one of them.
 * So the FIRST matching entry does the work for both tools in one pass — one continuation
 * POST carrying every tool's outputs — and the second is a no-op.
 *
 * @see hostedTool/engine.ts - the transport machinery and its full frame contract
 * @see fileSearch/descriptor.ts - the file_search implementation
 * @see responsesWebSearchPlugin.ts - the twin, and the first user of the engine
 * @see api_config.json - defaultHooks.openai.responses / responses-stream
 * @see test/responses-tool-plugin-layering.test.ts - why the two hook arrays disagree
 */
import { registerDescriptor } from './hostedTool/registry';
import { hostedToolBeforeHandler, hostedToolAfterHandler } from './hostedTool/engine';
import { fileSearchDescriptor } from './fileSearch/descriptor';

registerDescriptor(fileSearchDescriptor);

const pluginRules = [
  { id: 'responsesFileSearchPlugin', match: [], strategy: 'before', handler: hostedToolBeforeHandler },
  { id: 'responsesFileSearchPlugin', match: [], strategy: 'after', handler: hostedToolAfterHandler },
];

export = pluginRules;
