import { describe, it, expect } from '@jest/globals';
import {
  normalizeInputToItems,
  buildFunctionCallOutput,
  buildFailedFunctionCallOutput,
} from '../src/plugins/webSearch/continuation';
import { webSearchDescriptor } from '../src/plugins/webSearch/descriptor';

const RESULTS = [
  { title: 'Node releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'LTS list', content: 'Node 22 is Active LTS', date: 'July 2026' },
] as any;

describe('normalizeInputToItems', () => {
  it('wraps a bare string prompt as a user message item', () => {
    expect(normalizeInputToItems('hello there')).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] },
    ]);
  });

  it('returns an item array unchanged', () => {
    const items = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    expect(normalizeInputToItems(items)).toEqual(items);
  });

  it('returns an empty array for null or undefined', () => {
    expect(normalizeInputToItems(undefined)).toEqual([]);
    expect(normalizeInputToItems(null)).toEqual([]);
  });
});

describe('buildFunctionCallOutput', () => {
  it('pairs the output to the call by call_id and carries the results', () => {
    const out = buildFunctionCallOutput('call_1', RESULTS);

    expect(out.type).toBe('function_call_output');
    expect(out.call_id).toBe('call_1');
    const parsed = JSON.parse(out.output);
    expect(parsed.results[0].url).toBe('https://nodejs.org/en/about/previous-releases');
    expect(parsed.results[0].title).toBe('Node releases');
  });

  it('serialises an empty result set without throwing', () => {
    expect(JSON.parse(buildFunctionCallOutput('call_1', []).output)).toEqual({ results: [] });
  });
});

describe('web_search failure output is distinguishable from an empty search', () => {
  it('renders a genuine empty search as results: []', () => {
    const out = webSearchDescriptor.renderOutput({
      call: { callId: 'call_1', rawArguments: '{}', args: { query: 'q' } },
      status: 'completed', payload: [],
    } as any);
    expect(JSON.parse(out.output)).toEqual({ results: [] });
  });

  it('renders a failed call as an error, never as results', () => {
    const out = webSearchDescriptor.renderOutput({
      call: { callId: 'call_2', rawArguments: '{}', args: { query: 'q' } },
      status: 'failed', payload: null,
    } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.results).toBeUndefined();
    expect(parsed.error.code).toBe('web_search_unavailable');
    expect(parsed.error.message).toMatch(/could not be run/i);
    expect(parsed.error.message).toMatch(/not.*returned no results/i);
    // MODEL-facing: this text is only ever read by the model (a `function_call_output`), so
    // the instruction belongs here. See fix round 4's report.
    expect(parsed.error.message).toMatch(/do not tell the user/i);
  });

  it('names the cap as the reason when that is why the call did not run', () => {
    const out = webSearchDescriptor.renderOutput({
      call: { callId: 'call_3', rawArguments: '{}', args: { query: 'q' } },
      status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.error.code).toBe('cap_reached');
    expect(parsed.error.message).toMatch(/budget/i);
    expect(parsed.error.message).toMatch(/results you already have/i);
    // MODEL-facing instruction — see fix round 4's report.
    expect(parsed.error.message).toMatch(/do not tell the user/i);
  });

  it('keeps the successful shape untouched', () => {
    const out = buildFunctionCallOutput('call_4', [
      { title: 'T', url: 'https://e.com', snippet: 's', content: 'c' } as any,
    ]);
    expect(JSON.parse(out.output).results).toHaveLength(1);
    expect(out).toMatchObject({ type: 'function_call_output', call_id: 'call_4' });
  });

  it('builds the failed shape with the same envelope as the success shape', () => {
    const out = buildFailedFunctionCallOutput('call_5', 'web_search_unavailable', 'msg');
    expect(out).toMatchObject({ type: 'function_call_output', call_id: 'call_5' });
    expect(JSON.parse(out.output)).toEqual({ error: { code: 'web_search_unavailable', message: 'msg' } });
  });
});

/**
 * Task 2 fix round 2. `renderResultMessage` is the ONLY hook a call `performCall`'s cap
 * branch reaches on the streaming path — `capReached` blocks every continuation for the
 * rest of the turn, and `renderOutput` (tested above) is exclusively a continuation-POST
 * hook, so it is never invoked for a call that branch capped. Before this fix,
 * `renderResultMessage` never looked at `r.status` at all, so a failed OR capped call fell
 * through to `buildSearchMessageItem([], query, ...)` — the exact "ran and found nothing"
 * conflation `renderOutput`'s `error` shape exists to prevent, just unreachable there.
 *
 * Fix round 4. Round 2 pointed this hook at the SAME text as `renderOutput` — which the
 * live acceptance run then showed rendered VERBATIM as the sole final message a human saw
 * in the TUI, imperatives and all ("Do not tell the user…", addressed to the model, read
 * by a person). `renderResultMessage` is a `message` item read by the USER, never the
 * model, so its text below is now a plain statement of what happened — no imperative, no
 * instruction about what to tell anyone. See `FAILURE_MESSAGES` in `descriptor.ts`.
 */
describe("web_search's renderResultMessage is distinguishable from an empty search", () => {
  it('reads as "no results found" for a search that genuinely ran and found nothing', () => {
    const message = webSearchDescriptor.renderResultMessage({
      call: { callId: 'call_1', rawArguments: '{}', args: { query: 'q' } },
      status: 'completed', payload: [],
    } as any);
    expect(message.content[0].text).toMatch(/no web search results were found/i);
  });

  it('reads as "could not run", never as an empty result, for a genuine failure', () => {
    const message = webSearchDescriptor.renderResultMessage({
      call: { callId: 'call_2', rawArguments: '{}', args: { query: 'q' } },
      status: 'failed', payload: null,
    } as any);
    expect(message.content[0].text).toMatch(/could not be run/i);
    expect(message.content[0].text).not.toMatch(/no web search results were found/i);
    // USER-facing: no instruction addressed to the model may leak into what a person reads.
    expect(message.content[0].text).not.toMatch(/do not tell the user/i);
  });

  it('names the budget as the reason, never as an empty result, when the cap is why the call did not run — addressed to the USER, not the model', () => {
    const message = webSearchDescriptor.renderResultMessage({
      call: { callId: 'call_3', rawArguments: '{}', args: { query: 'q' } },
      status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    } as any);
    expect(message.content[0].text).toMatch(/budget/i);
    expect(message.content[0].text).not.toMatch(/no web search results were found/i);
    // The cheapest robust check for the leak the live run surfaced: an instruction to the
    // MODEL ("Do not tell the user…") must never appear in text a HUMAN reads verbatim.
    expect(message.content[0].text).not.toMatch(/do not tell the user/i);
    // Nor the model-only imperative that replaces it in `renderOutput`'s text.
    expect(message.content[0].text).not.toMatch(/results you already have/i);
  });
});

describe('web_search: results we no longer hold', () => {
  const call = { callId: 'c1', rawArguments: '{}', args: { query: 'q' } };

  it('renders a not_retained failure that never implies the search found nothing', () => {
    const out = webSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null, error: { code: 'not_retained', message: '' },
    } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.results).toBeUndefined();
    expect(parsed.error.code).toBe('not_retained');
    expect(parsed.error.message).toMatch(/no longer/i);
    expect(parsed.error.message).toMatch(/search again/i);
    expect(parsed.error.message).not.toMatch(/returned nothing|no results were found/i);
  });

  it('gives the user a plain statement with no instruction addressed to the model', () => {
    const msg = webSearchDescriptor.renderResultMessage({
      call, status: 'failed', payload: null, error: { code: 'not_retained', message: '' },
    } as any);
    const text = msg.content[0].text;
    expect(text).toMatch(/earlier/i);
    expect(text).not.toMatch(/do not tell the user/i);
    expect(text).not.toMatch(/answer using/i);
  });

  it('leaves cap_reached and the generic failure unchanged', () => {
    const cap = JSON.parse(webSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    } as any).output);
    expect(cap.error.code).toBe('cap_reached');
    expect(cap.error.message).toMatch(/budget/i);
    const generic = JSON.parse(webSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null,
    } as any).output);
    expect(generic.error.code).toBe('web_search_unavailable');
  });
});
