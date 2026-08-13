/**
 * The hosted `web_search` tool, expressed as a `HostedToolDescriptor`.
 *
 * Everything tool-specific about the Responses web-search emulation lives here; the frame
 * suppression, the injected items, the continuation loop and the caps all live in
 * `hostedTool/engine.ts` and are shared with every other hosted tool.
 *
 * The pure wire-shape helpers this composes (`RESPONSES_WEB_SEARCH_TOOL`,
 * `buildWebSearchCallItem`, `buildSearchMessageItem`, `parseQueryFromArguments`,
 * `buildFunctionCallOutput`) stay where they are, in `responsesAdapter.ts` /
 * `continuation.ts`, with their own suites pinned to those paths.
 *
 * @see ../hostedTool/descriptor.ts - the interface and what each hook owes the engine
 * @see ../responsesWebSearchPlugin.ts - where this is registered
 */
import {
  HostedToolDescriptor, ParsedCall, RenderCallItemOpts, ToolExecCtx, ToolExecResult,
} from '../hostedTool/descriptor';
import { syntheticId } from '../hostedTool/syntheticId';
import { executeWebSearch, SearchResult } from './searchExecutor';
import { buildFunctionCallOutput, buildFailedFunctionCallOutput } from './continuation';
import {
  RESPONSES_WEB_SEARCH_TOOL,
  parseQueryFromArguments,
  buildWebSearchCallItem,
  buildSearchMessageItem,
} from './responsesAdapter';
import configService from '../../services/configService';

/** The results of a call, defaulting a never-ran or failed call to the empty list. */
function resultsOf(r: ToolExecResult): SearchResult[] {
  return Array.isArray(r.payload) ? r.payload as SearchResult[] : [];
}

/** The query the CLIENT is shown — deliberately the unmasked one. See `execute` below. */
function queryOf(r: ToolExecResult): string {
  return typeof r.call?.args?.query === 'string' ? r.call.args.query : '';
}

/**
 * Why a call failed, and what each of its TWO audiences needs to hear about it — kept
 * together, per code, so a fix to the underlying fact (below, in `MODEL`) can never be
 * applied to only one audience and drift out of sync with the other, the way fix round 2's
 * single shared STRING did.
 *
 * `renderOutput` produces a `function_call_output`: only the MODEL ever reads it, so its
 * text may carry imperatives ("Do not tell the user…") — those are instructions TO the
 * model, and belong exactly there.
 *
 * `renderResultMessage` produces an assistant `message` ITEM: on the no-continuation path
 * (`performCall`'s cap branch forecloses every further continuation for the rest of the
 * turn, so this is the ONLY hook that call ever reaches) this is rendered to the HUMAN
 * verbatim, as if the assistant said it. Fix round 2 pointed this hook at the exact same
 * text as `renderOutput` — an instruction addressed to the model, appearing unparaphrased in
 * a user's transcript, reads as nonsense to a person and leaks how this tool is implemented.
 * `USER` is therefore a plain statement of what happened, addressed to a person, with no
 * imperative and no instruction about what to tell anyone.
 */
const FAILURE_MESSAGES: Record<'cap_reached' | 'not_retained' | 'default', { model: string; user: string }> = {
  cap_reached: {
    model: 'The web-search budget for this turn is used up. Answer using the results you already '
      + 'have. Do not tell the user the search returned nothing.',
    user: "This turn's web-search budget was used up, so some of the requested searches were not run.",
  },
  not_retained: {
    model: 'The results of this earlier search are no longer retained. Do not describe them as '
      + 'empty — they existed. If you need them, search again now; otherwise answer from what '
      + 'the conversation already records.',
    user: 'The results of an earlier search are no longer available in this session.',
  },
  default: {
    model: 'The web search could not be run. Tell the user you were unable to search the web. '
      + 'Do not tell the user the search returned no results.',
    user: 'The web search could not be run.',
  },
};

function reasonFor(code: string): { model: string; user: string } {
  if (code === 'cap_reached') return FAILURE_MESSAGES.cap_reached;
  if (code === 'not_retained') return FAILURE_MESSAGES.not_retained;
  return FAILURE_MESSAGES.default;
}

export const webSearchDescriptor: HostedToolDescriptor = {
  type: 'web_search',
  functionName: 'web_search',

  // A fresh copy per request: the engine hands the rewritten tool straight into
  // `body.tools`, where downstream plugins are free to mutate it.
  rewriteTool: (_hosted: any) => ({ ...RESPONSES_WEB_SEARCH_TOOL }),

  prepare: async () => undefined,

  parseCall: (callId: string, rawArguments: string): ParsedCall => ({
    callId,
    rawArguments,
    args: { query: parseQueryFromArguments(rawArguments) },
  }),

  execute: async (call: ParsedCall, ctx: ToolExecCtx): Promise<ToolExecResult> => {
    const query: string = typeof call.args?.query === 'string' ? call.args.query : '';
    // On the non-streaming path `call.rawArguments` has already been UNMASKED in place —
    // by pseudonymizationPlugin for the very first response, or by the engine's own
    // unmaskResponsesOutput call for every response after that — so re-mask before the
    // query leaves the process. The client-facing items below deliberately keep the
    // unmasked `query`; only the search provider sees `searchQuery`. On the streaming
    // path `ctx.remask` is the identity function and this is a no-op, correctly so: that
    // interceptor reads every frame while it is still masked.
    const searchQuery = ctx.remask(query);
    if (searchQuery !== query) {
      ctx.logger.info('Re-masked the web_search query before dispatching it to the search provider');
    }

    try {
      return { call, status: 'completed', payload: await executeWebSearch(searchQuery, ctx.logger) };
    } catch (error: any) {
      ctx.logger.error(`Web search failed${ctx.isStreaming ? ' mid-stream' : ''} for "${searchQuery}": ${error.message}`);
      return {
        call,
        status: 'failed',
        payload: [],
        error: { message: error.message, code: 'web_search_failed' },
      };
    }
  },

  renderOutput: (r: ToolExecResult): any => {
    if (r.status !== 'failed') return buildFunctionCallOutput(r.call.callId, resultsOf(r));
    const code = r.error?.code ?? 'web_search_unavailable';
    // The prose is load-bearing, not decoration: this session measured that models read tool
    // output text closely and over-read an empty result set as a real outcome. Each message
    // states the fact AND names the misreading to avoid — MODEL-facing wording; see
    // `FAILURE_MESSAGES`.
    return buildFailedFunctionCallOutput(r.call.callId, code, reasonFor(code).model);
  },

  renderCallItem: (r: ToolExecResult, _opts: RenderCallItemOpts) =>
    buildWebSearchCallItem(queryOf(r), syntheticId('ws'), r.status),

  renderResultMessage: (r: ToolExecResult) => {
    // A failed call never reaches buildSearchMessageItem: that path's `results: []` reads,
    // correctly, as "ran and found nothing" — the one outcome this is NOT. USER-facing
    // wording — see `FAILURE_MESSAGES` for why this is NOT the same string `renderOutput`
    // sends the model.
    if (r.status === 'failed') {
      return {
        type: 'message',
        id: syntheticId('msg'),
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: reasonFor(r.error?.code ?? 'web_search_unavailable').user,
          annotations: [],
        }],
      };
    }
    return buildSearchMessageItem(resultsOf(r), queryOf(r), syntheticId('msg'));
  },

  replayQueryFrom: (item: any): string =>
    typeof item?.action?.query === 'string' ? item.action.query : '',

  // Web results are public pages fetched from an external provider, and this tool masks
  // nothing on the way out, so storage and presentation are the same array in both
  // directions.
  cachePayloadFrom: (payload: unknown): unknown => (Array.isArray(payload) ? payload : []),

  rehydratePayload: (cachedPayload: unknown): unknown =>
    Array.isArray(cachedPayload) ? cachedPayload : [],

  maxCallsPerRequest: () => configService.getWebSearchMaxSearches(),
};
