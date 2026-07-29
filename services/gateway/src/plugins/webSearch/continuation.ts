/**
 * Building blocks for the follow-up request that lets the model answer from the search
 * results.
 *
 * A native hosted `web_search` runs inside the turn: the model calls it, the provider
 * executes it, and the SAME model turn then writes the answer. Emulating it by handing
 * the client a formatted result list ends the turn early — the model never sees what
 * was found. So after a search the gateway extends the conversation and calls the
 * deployment again.
 *
 * The route runs with `store: false`, so the deployment holds no state: a continuation
 * has to carry the whole conversation — the original input, everything the model just
 * produced (reasoning included, or it loses its chain of thought), every function_call,
 * and one function_call_output per call.
 *
 * `responsesWebSearchPlugin.ts`'s continuation loop composes these two directly rather
 * than through a single "build the whole continuation input" helper: Codex CLI defaults
 * `parallel_tool_calls` to true, so one turn can carry more than one web_search call,
 * and the loop accumulates a `history` array across iterations (an earlier iteration's
 * output must not be re-derived away — see that file's fix-5 notes) — both of which need
 * `buildFunctionCallOutput` called once per call rather than a single-call composition.
 *
 * Pure: no I/O, no config, no logging.
 */
import { SearchResult } from './searchExecutor';

/**
 * Responses accepts `input` as either a bare string or an item array. A continuation
 * always needs the array form, so a string prompt is wrapped as the user message it
 * stands for.
 */
export function normalizeInputToItems(input: any): any[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  }
  return [];
}

/** The tool result item the model reads, paired to its call by `call_id`. */
export function buildFunctionCallOutput(callId: string, results: SearchResult[]): any {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({
      results: (results || []).map(r => ({
        title: r.title, url: r.url, snippet: r.snippet, content: r.content, date: r.date,
      })),
    }),
  };
}

