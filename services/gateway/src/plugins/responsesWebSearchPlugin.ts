/**
 * Responses API web-search plugin.
 *
 * SAP AI Core deployments reject the hosted `web_search` tool outright, and Codex CLI
 * attaches one to every request with no way to disable it — so without this plugin the
 * /openai/v1/responses route is unusable from Codex.
 *
 * This file is now a shim. Everything it used to do — the res.write interceptor that
 * suppresses the model's `function_call` frames and splices a continuation deployment call
 * into the same SSE stream, the non-streaming continuation loop, the pending back-fill, the
 * caps, the usage accounting — lives in `hostedTool/engine.ts`, which is generic over
 * `HostedToolDescriptor`. Everything specific to web search — the function tool the
 * deployment is given, how a query is parsed and re-masked, what Perplexity is asked, and
 * the `web_search_call` / result-`message` items the client is handed back — lives in
 * `webSearch/descriptor.ts`.
 *
 * The plugin id, the hook entries in `api_config.json`, the request flag the after handler
 * gates on (`__responsesWebSearchRewritten`) and the client-visible frame contract are all
 * unchanged by that extraction; `test/responses-websearch-characterization.test.ts` is the
 * byte-level gate that says so.
 *
 * Registering the descriptor here rather than inside the engine is what keeps the engine
 * free of any single tool: a second hosted tool is a second `registerDescriptor` call from
 * its own plugin file, and the engine's continuation loop then groups both tools' calls
 * into one continuation POST per turn.
 *
 * @see hostedTool/engine.ts - the transport machinery and its full frame contract
 * @see hostedTool/descriptor.ts - what a hosted tool has to implement
 * @see webSearch/descriptor.ts - the web_search implementation
 * @see api_config.json - defaultHooks.openai.responses / responses-stream
 * @see responsesWebSearchPlugin.md - documentation
 */
import { registerDescriptor } from './hostedTool/registry';
import { hostedToolBeforeHandler, hostedToolAfterHandler } from './hostedTool/engine';
import { webSearchDescriptor } from './webSearch/descriptor';

registerDescriptor(webSearchDescriptor);

const pluginRules = [
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'before', handler: hostedToolBeforeHandler },
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'after', handler: hostedToolAfterHandler },
];

export = pluginRules;
