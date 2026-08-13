/**
 * Orchestration stream chunks -> Responses SSE frames.
 *
 * The client is codex, which reads the Responses event stream. It needs a
 * response.created to open, output_item/content_part frames around the text,
 * and exactly one response.completed to close.
 */
import { describe, it, expect } from '@jest/globals';
import { createResponsesStreamTranslator } from '../src/responses/orchestrationBridge/streamTranslator';

const OPTS = { model: 'anthropic--claude-4.8-opus', responseId: 'resp_1' };

/** Parse the SSE blocks a translator returned into frame objects. */
function frames(blocks: string[]): any[] {
  return blocks
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l: any) => JSON.parse(l.slice(6)));
}

function textChunk(text: string) {
  return { final_result: { choices: [{ delta: { content: text } }] } };
}

describe('createResponsesStreamTranslator', () => {
  it('opens with response.created before any content', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const f = frames(t.onChunk(textChunk('a')));
    expect(f[0].type).toBe('response.created');
    expect(f[0].response.id).toBe('resp_1');
    expect(f[0].response.model).toBe('anthropic--claude-4.8-opus');
  });

  it('opens the message item and content part exactly once, then streams deltas', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const first = frames(t.onChunk(textChunk('he')));
    const second = frames(t.onChunk(textChunk('llo')));

    const types1 = first.map((x) => x.type);
    expect(types1).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta',
    ]);
    // The second chunk adds only a delta — no repeated item/part frames.
    expect(second.map((x) => x.type)).toEqual(['response.output_text.delta']);
    expect(second[0].delta).toBe('llo');
  });

  it('closes the text, the part, the item and the response exactly once', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('hi'));
    const f = frames(t.finish());
    expect(f.map((x) => x.type)).toEqual([
      'response.output_text.done', 'response.content_part.done',
      'response.output_item.done', 'response.completed',
    ]);
    expect(f[0].text).toBe('hi');
    expect(f[3].response.status).toBe('completed');
  });

  it('emits a well-formed empty response when no chunk ever arrives', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const f = frames(t.finish());
    expect(f.map((x) => x.type)).toEqual(['response.created', 'response.in_progress', 'response.completed']);
    expect(f[2].response.output).toEqual([]);
  });

  it('accumulates streamed tool_calls into one function_call item', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk({ final_result: { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c1', function: { name: 'ls', arguments: '{"p' } }] } }] } });
    t.onChunk({ final_result: { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: 'ath":"/"}' } }] } }] } });

    const f = frames(t.finish());
    const item = f.find((x) => x.type === 'response.output_item.done')?.item;
    expect(item).toEqual({
      type: 'function_call', id: expect.any(String), call_id: 'c1',
      name: 'ls', arguments: '{"path":"/"}', status: 'completed',
    });
  });

  it('carries usage from the final chunk onto response.completed', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('x'));
    t.onChunk({ final_result: { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } } });
    const f = frames(t.finish());
    const done = f.find((x) => x.type === 'response.completed');
    expect(done.response.usage.input_tokens).toBe(7);
    expect(done.response.usage.output_tokens).toBe(3);
  });

  it('normalizes an EXCLUSIVE cache-READ turn to OpenAI-INCLUSIVE client usage — agreeing with responseTranslator.ts', () => {
    // THE SAME FIXTURE orchestration-response-translator.test.ts asserts against:
    // arm A2 run 2 of test/fixtures/orchestration/bridge-cache-probe-result.md,
    // SAP reporting prompt_tokens 14 with cached_tokens 17692 alongside it. The
    // two translators describe one turn and their usage objects must be
    // shape-identical AND number-identical, so both suites pin the same input to
    // the same output. A client rendering a cache-hit indicator reads
    // usage.input_tokens_details.cached_tokens as a subset of usage.input_tokens,
    // which is only true after this conversion.
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('x'));
    t.onChunk({
      final_result: {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 17692, cache_creation_tokens: 0 },
        },
      },
    });
    const f = frames(t.finish());
    const done = f.find((x) => x.type === 'response.completed');
    expect(done.response.usage).toEqual({
      input_tokens: 17706,                                            // 14 + 17692
      input_tokens_details: { cached_tokens: 17692, cache_write_tokens: 0 },
      output_tokens: 4,
      total_tokens: 17710,                                            // recomputed, not SAP's 18
    });
  });

  it('normalizes an EXCLUSIVE cache-WRITE turn the same way, reporting cache_write_tokens', () => {
    // Arm A2 run 1, again the blocking sibling's fixture exactly. SAP's own field stays
    // prompt_tokens_details.cache_creation_tokens (a different envelope); the client-visible
    // output names it cache_write_tokens, matching the real Responses API.
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('x'));
    t.onChunk({
      final_result: {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 14, completion_tokens: 4, total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 17692 },
        },
      },
    });
    const f = frames(t.finish());
    const done = f.find((x) => x.type === 'response.completed');
    expect(done.response.usage).toEqual({
      input_tokens: 17706,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 17692 },
      output_tokens: 4,
      total_tokens: 17710,
    });
  });

  it('numbers sequence_number monotonically from 0 across the whole turn', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const all = [...frames(t.onChunk(textChunk('a'))), ...frames(t.onChunk(textChunk('b'))), ...frames(t.finish())];
    expect(all.map((x) => x.sequence_number)).toEqual(all.map((_, i) => i));
  });

  it('fills response.completed usage with zeros, not an absent key, when no chunk ever carried usage', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const f = frames(t.finish());
    const done = f.find((x) => x.type === 'response.completed');
    expect(done.response).toHaveProperty('usage');
    // Still zero-filled rather than absent — the behaviour this test was written
    // for. `cache_write_tokens: 0` joins it because the zero-fill is now the
    // same translateUsage call the populated path uses, which is what keeps the
    // two translators' usage objects shape-identical on EVERY path, empty turn
    // included. A client that only reads cached_tokens is unaffected.
    expect(done.response.usage).toEqual({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      total_tokens: 0,
    });
  });

  it('assigns contiguous output_index across a message and two parallel tool calls', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('hi'));
    t.onChunk({ final_result: { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] } }] } });
    t.onChunk({ final_result: { choices: [{ delta: { tool_calls: [
      { index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } }] } }] } });

    const f = frames(t.finish());
    const doneItems = f.filter((x) => x.type === 'response.output_item.done');
    expect(doneItems.map((x) => [x.output_index, x.item.type, x.item.call_id ?? null])).toEqual([
      [0, 'message', null],
      [1, 'function_call', 'c1'],
      [2, 'function_call', 'c2'],
    ]);

    // added and done must agree on output_index for each item.
    const addedItems = f.filter((x) => x.type === 'response.output_item.added' && x.item.type === 'function_call');
    expect(addedItems.map((x) => x.output_index)).toEqual([1, 2]);
  });
  // Reconciled with responseTranslator.ts: the two siblings describe the SAME turn and
  // disagreed. This one read no finish_reason at all, so an identical truncated turn
  // reported `incomplete` unstreamed and `completed` streamed — a status that flips on
  // `stream: true` is not a difference a client can absorb.
  it('ends a truncated turn with response.incomplete, exactly as the blocking sibling does', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('trunc'));
    t.onChunk({ final_result: { choices: [{ delta: {}, finish_reason: 'length' }] } });

    const f = frames(t.finish());
    const terminal = f[f.length - 1];
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.status).toBe('incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    // The text the model DID produce still reaches the client.
    expect(terminal.response.output[0].content[0].text).toBe('trunc');
  });

  it('ends a FILTERED turn with response.incomplete, not a successful blank answer', () => {
    // content_filter came back twice in the live capture with empty content and non-zero
    // completion_tokens. Reported as `completed` it is a successful empty turn, which the
    // client has no way to tell from the model having nothing to say.
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk({ final_result: { choices: [{ delta: {}, finish_reason: 'content_filter' }] } });

    const f = frames(t.finish());
    const terminal = f[f.length - 1];
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.status).toBe('incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it('leaves an ordinary turn completed, with no incomplete_details', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('hi'));
    t.onChunk({ final_result: { choices: [{ delta: {}, finish_reason: 'stop' }] } });

    const f = frames(t.finish());
    const terminal = f[f.length - 1];
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.status).toBe('completed');
    expect(terminal.response).not.toHaveProperty('incomplete_details');
  });
});

describe('reasoning output item', () => {
  /** A reasoning delta as SAP actually sends it — text incremental, signature empty. */
  const reasoningChunk = (text: string, signature = '') => ({
    choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: [{ content: text, signature }] } }],
  });
  const textChunk = (text: string) => ({ choices: [{ index: 0, delta: { content: text } }] });

  it('opens a reasoning item at index 0 and closes it with the joined summary', () => {
    const t = createResponsesStreamTranslator(OPTS);
    // Three deltas, exactly the incremental shape measured on the wire: the
    // signature only lands on the last one, and is deliberately not emitted.
    const opened = frames(t.onChunk(reasoningChunk('The user is asking ')));
    t.onChunk(reasoningChunk('which city needs '));
    t.onChunk(reasoningChunk('a warmer coat.', 'EroCCnEIEBABGAIqQJz6rK5Y'));
    const done = frames(t.finish());

    const added = opened.find((f) => f.type === 'response.output_item.added');
    expect(added.output_index).toBe(0);
    expect(added.item.type).toBe('reasoning');
    expect(added.item.summary).toEqual([]);          // still streaming
    expect(added.item.content).toEqual([]);

    const closed = done.find((f) => f.type === 'response.output_item.done' && f.item.type === 'reasoning');
    expect(closed.output_index).toBe(0);
    expect(closed.item.id).toBe(added.item.id);       // same item, not a second one
    expect(closed.item.summary).toEqual([
      { type: 'summary_text', text: 'The user is asking which city needs a warmer coat.' },
    ]);
    // The Anthropic signature is NOT smuggled into encrypted_content.
    expect(closed.item).not.toHaveProperty('encrypted_content');
  });

  it('pushes the message to output_index 1 when reasoning came first', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(reasoningChunk('thinking'));
    const mid = frames(t.onChunk(textChunk('Berlin.')));
    const end = frames(t.finish());

    const msgAdded = mid.find((f) => f.type === 'response.output_item.added' && f.item.type === 'message');
    expect(msgAdded.output_index).toBe(1);
    // Every later message frame must agree with that index, not just the first.
    for (const f of [...mid, ...end]) {
      if (f.item_id && f.item_id === msgAdded.item.id) expect(f.output_index).toBe(1);
    }
    const msgDone = end.find((f) => f.type === 'response.output_item.done' && f.item.type === 'message');
    expect(msgDone.output_index).toBe(1);

    const completed = end.find((f) => f.type === 'response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['reasoning', 'message']);
  });

  it('streams reasoning_summary frames, which are what codex renders from', () => {
    // Emitting only the ITEM (added/done) delivers the reasoning but shows
    // nothing: measured against codex 0.147.0, which ingested our item and
    // replayed our own summary_text back, yet drew no thinking section. Its
    // TUI is driven by these incremental frames -- the binary carries the
    // matching variants reasoning_summary_part_added / _delta / _done.
    const t = createResponsesStreamTranslator(OPTS);
    const a = frames(t.onChunk(reasoningChunk('Two trains ')));
    const b = frames(t.onChunk(reasoningChunk('leave a station.')));
    const c = frames(t.finish());
    const all = [...a, ...b, ...c];

    const partAdded = all.filter((f) => f.type === 'response.reasoning_summary_part.added');
    expect(partAdded).toHaveLength(1);                      // opened once, not per delta
    expect(partAdded[0].part).toEqual({ type: 'summary_text', text: '' });
    expect(partAdded[0].summary_index).toBe(0);

    const deltas = all.filter((f) => f.type === 'response.reasoning_summary_text.delta');
    expect(deltas.map((f) => f.delta)).toEqual(['Two trains ', 'leave a station.']);
    for (const d of deltas) {
      expect(d.item_id).toBe(partAdded[0].item_id);
      expect(d.output_index).toBe(0);
    }

    const textDone = all.find((f) => f.type === 'response.reasoning_summary_text.done');
    expect(textDone.text).toBe('Two trains leave a station.');

    // Ordering: the summary closes before the item that owns it, exactly as the
    // message path closes its content part before its own item.
    const order = all.map((f) => f.type).filter((t2) => t2.startsWith('response.reasoning_summary') ||
      (t2 === 'response.output_item.done'));
    expect(order).toEqual([
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
    ]);
  });

  it('emits no reasoning_summary frames when the model did not think', () => {
    const t = createResponsesStreamTranslator(OPTS);
    const all = [...frames(t.onChunk(textChunk('Hi.'))), ...frames(t.finish())];
    expect(all.filter((f) => f.type.startsWith('response.reasoning_summary'))).toHaveLength(0);
  });

  it('closes reasoning BEFORE opening the message, as the deployed route does', () => {
    // Captured deployed frame run: reasoning added(0), reasoning done(0),
    // message added(1). Holding reasoning open until finish() instead produced
    // added(0), added(1), done(0), done(1) -- an interleaving no real server
    // emits, and one every assertion in this file passed happily under.
    const t = createResponsesStreamTranslator(OPTS);
    const a = frames(t.onChunk(reasoningChunk('thinking hard')));
    const b = frames(t.onChunk(textChunk('Berlin.')));
    const c = frames(t.finish());
    const order = [...a, ...b, ...c]
      .filter((f) => f.type === 'response.output_item.added' || f.type === 'response.output_item.done')
      .map((f) => `${f.item.type}:${f.type.endsWith('added') ? 'added' : 'done'}@${f.output_index}`);
    expect(order).toEqual([
      'reasoning:added@0', 'reasoning:done@0', 'message:added@1', 'message:done@1',
    ]);
  });

  it('leaves the message at output_index 0 when the model did not think', () => {
    // The common case — adaptive declines to think on easy turns — and the
    // regression guard for the index shift above.
    const t = createResponsesStreamTranslator(OPTS);
    const mid = frames(t.onChunk(textChunk('Berlin.')));
    const end = frames(t.finish());
    expect(mid.find((f) => f.type === 'response.output_item.added').output_index).toBe(0);
    const completed = end.find((f) => f.type === 'response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['message']);
  });

  it('numbers tool calls after the reasoning and message items', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(reasoningChunk('thinking'));
    t.onChunk(textChunk('Checking.'));
    t.onChunk({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{}' } },
    ] } }] });
    const end = frames(t.finish());
    const fc = end.find((f) => f.type === 'response.output_item.added' && f.item.type === 'function_call');
    expect(fc.output_index).toBe(2);
    const completed = end.find((f) => f.type === 'response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['reasoning', 'message', 'function_call']);
  });

  it('still CLOSES a reasoning item whose text turned out to be blank', () => {
    // Once `added` has gone out, index 0 is spoken for and the message has
    // already been shifted to 1. Dropping the item here would leave the client
    // with an item that opened and never closed, and a hole at index 0.
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(reasoningChunk('   '));
    const end = frames(t.finish());
    const closed = end.find((f) => f.type === 'response.output_item.done' && f.item.type === 'reasoning');
    expect(closed).toBeDefined();
    expect(closed.item.summary).toEqual([]);
  });

  it('emits no reasoning frames at all when no chunk carried reasoning_content', () => {
    const t = createResponsesStreamTranslator(OPTS);
    t.onChunk(textChunk('Hello.'));
    const all = [...frames(t.onChunk(textChunk(' There.'))), ...frames(t.finish())];
    expect(all.filter((f) => f.item?.type === 'reasoning')).toHaveLength(0);
  });
});
