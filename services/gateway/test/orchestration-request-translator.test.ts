/**
 * Responses request -> SAP orchestration payload.
 *
 * Orchestration speaks OpenAI chat shape, so this is a semantics translation:
 * Responses `input` items become chat messages, and `tools` move onto
 * prompt.tools. Content is emitted as BLOCKS, never flattened to a string —
 * a string has nowhere to hang a cache_control breakpoint, which is what
 * caching on this path depends on.
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildOrchestrationPayload, responsesInputToMessages, UnsupportedInputItemError,
} from '../src/responses/orchestrationBridge/requestTranslator';

describe('responsesInputToMessages', () => {
  it('turns a plain string input into one user message with block content', () => {
    expect(responsesInputToMessages('hello')).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('puts instructions in front as a system message', () => {
    const msgs = responsesInputToMessages('hi', 'be brief');
    expect(msgs[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be brief' }] });
    expect(msgs[1].role).toBe('user');
  });

  it('translates message items, mapping input_text and output_text to text blocks', () => {
    const msgs = responsesInputToMessages([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });

  it('translates a function_call into an assistant tool_calls message', () => {
    // content must be '' not [] -- confirmed live against orchestration:
    // an empty block array 400s with "Request Body: [] is not of type
    // 'string'" (orchestration's schema is string-or-array-of-blocks, and
    // an empty array satisfies neither branch).
    const msgs = responsesInputToMessages([
      { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{"path":"/"}' },
    ]);
    expect(msgs).toEqual([{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"/"}' } }],
    }]);
  });

  it('wraps a message item with plain string content in a text block', () => {
    // Not every caller sends the array-of-parts shape for `content` — guard
    // against silently losing this to a flattening regression in textBlocks.
    const msgs = responsesInputToMessages([
      { type: 'message', role: 'user', content: 'q' },
    ]);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
  });

  it('translates a function_call_output into a tool message keyed to the call, with STRING content', () => {
    // Unlike every other role, `tool` content must be a plain string --
    // confirmed live against orchestration: block-array content 400s with
    // "Tool message content must be a string for Anthropic harmonization.
    // Received: list."
    const msgs = responsesInputToMessages([
      { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
    ]);
    expect(msgs).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
    ]);
  });

  it('JSON-stringifies a non-string function_call_output for the tool message', () => {
    const msgs = responsesInputToMessages([
      { type: 'function_call_output', call_id: 'c1', output: { ok: true } },
    ]);
    expect(msgs).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
  });

  describe('function_call_output with an array `output` carrying an image', () => {
    // Measured live against a real codex 0.147.0 turn, NOT guessed: codex's
    // `view_image` tool returns the image inside a `function_call_output`
    // whose `output` is an ARRAY, with a `data:image/...` URL at
    // `output[0].image_url` (`textBlocks`'s `input_image`-in-a-message path
    // is never exercised by codex -- it never sends that shape). The
    // element's own `type` field was not part of what was measured (the
    // capture's `keys=[...]` listing names the function_call_output item's
    // keys, not the array element's), so extraction here keys off the
    // presence of `image_url`, not an assumed `type` value.
    //
    // The image cannot live in the tool message itself: a `role:'tool'`
    // message's content must be a plain string on this route (see this
    // file's header) -- confirmed live, block content 400s with "Tool
    // message content must be a string for Anthropic harmonization.
    // Received: list." So the proven design, also verified live (the model's
    // description came back accurate, i.e. it saw real pixels, not base64
    // text): the tool message keeps string content, followed immediately by
    // a user message carrying the image as an `image_url` block.

    it('produces a tool message with string content followed by a user message with an image_url block', () => {
      const msgs = responsesInputToMessages([
        { type: 'function_call', call_id: 'call_1', name: 'view_image', arguments: '{"path":"shot.png"}' },
        {
          type: 'function_call_output', call_id: 'call_1',
          output: [{ image_url: 'data:image/png;base64,AAA' }],
        },
      ]);
      expect(msgs).toHaveLength(3);
      expect(msgs[1].role).toBe('tool');
      expect(msgs[1].tool_call_id).toBe('call_1');
      expect(typeof msgs[1].content).toBe('string');
      expect(msgs[2]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: expect.any(String) },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      });
    });

    it('keeps text parts from the same output array in the tool message string, not lost', () => {
      const msgs = responsesInputToMessages([
        {
          type: 'function_call_output', call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'here is the screenshot' },
            { image_url: 'data:image/png;base64,AAA' },
          ],
        },
      ]);
      expect(msgs[0]).toEqual({
        role: 'tool', tool_call_id: 'call_1', content: 'here is the screenshot',
      });
      expect(msgs[1].role).toBe('user');
    });

    it('leaves a plain-string output exactly as today (regression guard)', () => {
      const msgs = responsesInputToMessages([
        { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
      ]);
      expect(msgs).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' }]);
    });

    it('leaves a text-parts-only output array exactly as today (regression guard)', () => {
      const output = [{ type: 'input_text', text: 'ok' }];
      const msgs = responsesInputToMessages([
        { type: 'function_call_output', call_id: 'call_1', output },
      ]);
      expect(msgs).toEqual([
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(output) },
      ]);
    });

    it('places the image message immediately after its tool message, surrounding order intact', () => {
      const msgs = responsesInputToMessages([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at this' }] },
        { type: 'function_call', call_id: 'call_1', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output', call_id: 'call_1',
          output: [{ image_url: 'data:image/png;base64,AAA' }],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I see a cat' }] },
      ]);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    });

    it('does not produce an image block for a non-data:image url in that position', () => {
      const output = [{ image_url: 'https://example.com/cat.png' }];
      const msgs = responsesInputToMessages([
        { type: 'function_call_output', call_id: 'call_1', output },
      ]);
      // Falls back to today's behaviour -- no image_url block anywhere.
      expect(msgs).toEqual([
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(output) },
      ]);
    });
  });

  it('OMITS reasoning items rather than fabricating an equivalent', () => {
    // Anthropic models have no reasoning-item equivalent and no golden exists
    // for one served through orchestration. Dropping is the approved behaviour;
    // inventing a shape is not.
    const msgs = responsesInputToMessages([
      { type: 'reasoning', id: 'r1', encrypted_content: 'opaque' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    ]);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
  });

  it('OMITS a compaction_trigger and keeps the surrounding turn intact', () => {
    // Measured 2026-08-11: the DEPLOYED route accepts this item (200, and answers
    // with a `compaction` output item) while this bridge used to reject it with
    // `Unsupported Responses input item type: compaction_trigger`. The shape below
    // is the whole item, verbatim from
    // test/fixtures/codex-custom-tools/responses-api-compliance-capture.json.
    const msgs = responsesInputToMessages([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before' }] },
      { type: 'compaction_trigger' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after' }] },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'before' }] },
      { role: 'user', content: [{ type: 'text', text: 'after' }] },
    ]);
  });

  it('OMITS a replayed compaction item, so one /compact cannot kill the session', () => {
    // This is the load-bearing case. Codex replays its ENTIRE history every turn
    // (`store: false`, no `previous_response_id`), so a `compaction` item returned
    // once is resent on every subsequent turn. Throwing here did not cost one turn,
    // it cost the rest of the session. Field set verbatim from the capture.
    const msgs = responsesInputToMessages([
      {
        type: 'compaction',
        id: 'cmp_08837e1beb979fab016a',
        encrypted_content: 'gAAAAABn…',
        internal_chat_message_metadata_passthrough: { turn_id: '019fefcc-3cbe-77e0-875e-7b351' },
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'carry on' }] },
    ]);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'carry on' }] }]);
  });

  it('does not throw on either compaction type', () => {
    // Guards the two above against a regression that turns the drop back into a
    // throw while some other assertion still happens to pass.
    expect(() => responsesInputToMessages([{ type: 'compaction_trigger' }])).not.toThrow();
    expect(() => responsesInputToMessages([{ type: 'compaction', id: 'cmp_x' }])).not.toThrow();
  });

  it('still refuses an unknown type — the drop list is exceptions, not a catch-all', () => {
    // The drop set gained two entries; it must not have become "swallow anything".
    // `compaction_call` is deliberately close to a dropped name and is NOT one.
    expect(() => responsesInputToMessages([{ type: 'compaction_call', id: 'x' }]))
      .toThrow(UnsupportedInputItemError);
    expect(() => responsesInputToMessages([{ type: 'tool_search_call', id: 'x' }]))
      .toThrow(UnsupportedInputItemError);
  });

  it('refuses an unknown item type instead of silently dropping content', () => {
    // Silently dropping means the model answers a question the user did not ask.
    expect(() => responsesInputToMessages([{ type: 'image_generation_call', id: 'x' }]))
      .toThrow(UnsupportedInputItemError);
    try {
      responsesInputToMessages([{ type: 'image_generation_call', id: 'x' }]);
    } catch (e: any) {
      expect(e.itemType).toBe('image_generation_call');
    }
  });

  it('refuses a content PART it cannot express, rather than dropping it', () => {
    // Same principle one level down. Keeping only the text parts meant an
    // unexpressable part vanished without trace — and a message whose parts
    // were ALL non-text produced `content: []`, which orchestration rejects
    // with "Request Body: [] is not of type 'string'": the request failed
    // anyway, with a 400 that named neither the item nor the part.
    //
    // `input_image` is now partially expressible (see the describe block
    // below), so this uses `input_file` instead — explicitly out of scope
    // (plan's "Scope boundaries": no evidence any client sends it, no
    // accepted upstream shape is known) — to keep testing an ORDINARY
    // unexpressable part.
    const fileOnly = [{
      type: 'message', role: 'user',
      content: [{ type: 'input_file', file_id: 'f1' }],
    }];
    expect(() => responsesInputToMessages(fileOnly)).toThrow(UnsupportedInputItemError);
    try {
      responsesInputToMessages(fileOnly);
    } catch (e: any) {
      expect(e.itemType).toBe('input_file');   // the PART type: what a caller must change
    }

    // And a MIXED message too — the text surviving is not a reason to lose
    // the unexpressable part.
    expect(() => responsesInputToMessages([{
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'what is this?' }, { type: 'input_file', file_id: 'f1' }],
    }])).toThrow(UnsupportedInputItemError);
  });

  describe('input_image parts', () => {
    it('turns a data: URL input_image into an image_url content block', () => {
      // The target shape is measured, not guessed: sent live via the chat
      // path to anthropic--claude-4.8-opus, a request carrying exactly this
      // block made the model correctly answer "pink" about a 1x1 pink PNG,
      // and the upstream payload carried `image_url` — not Anthropic's
      // `{type:"image", source:{...}}`, which never appeared.
      const msgs = responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }],
      }]);
      expect(msgs).toEqual([{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
      }]);
    });

    it('keeps a mixed text+image message intact, both parts, in order', () => {
      // The text surviving is not a reason to lose the image, and the image
      // being expressible now is not a reason to lose the text either.
      const msgs = responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      }]);
      expect(msgs).toEqual([{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      }]);
    });

    it('still refuses an input_image whose url is remote, not a data: URL', () => {
      // Task 2 (a separate change) inlines remote images to data: URLs in a
      // plugin's `before` handler, before this pure translator ever sees the
      // request — this file does no downloads and never will. If that
      // guarantee is ever broken, a remote URL landing here must still fail
      // loudly: silently forwarding it would let orchestration reject the
      // whole request with an opaque 400 naming neither the item nor the
      // part, and passing it through unmarked would be exactly the silent
      // drop this file's header refuses to do.
      expect(() => responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/cat.png' }],
      }])).toThrow(UnsupportedInputItemError);
    });

    it('still refuses an input_image whose data: URL is not an image', () => {
      // The accept branch checks `data:image/…` specifically, not just
      // `data:` — an `image_url` block whose "url" is really
      // `data:text/plain;…` is a different bug than the one this translator
      // exists to catch, and is better refused here (loud, via the same
      // UnsupportedInputItemError path as any other unexpressable part) than
      // forwarded as an image orchestration will choke on for an unrelated
      // reason.
      expect(() => responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [{ type: 'input_image', image_url: 'data:text/plain;base64,QUFB' }],
      }])).toThrow(UnsupportedInputItemError);
    });

    it('accepts both documented image_url spellings — plain string and {url}', () => {
      // Codex's exact input_image part shape is in NO capture in this repo
      // (`input_image` appears 0 times across 330 payload-log captures as of
      // 2026-08-12). The Responses API documents `image_url` both as a plain
      // string and as an object `{url}`; this tolerance accepts both
      // deliberately, because neither has actually been observed from a real
      // client here — it is not copied from a confirmed shape.
      const stringForm = responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }],
      }]);
      const objectForm = responsesInputToMessages([{
        type: 'message', role: 'user',
        content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,AAA' } }],
      }]);
      const expected = [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
      }];
      expect(stringForm).toEqual(expected);
      expect(objectForm).toEqual(expected);
    });
  });
});

describe('buildOrchestrationPayload', () => {
  const base = { input: 'hello', instructions: 'be brief' };

  it('builds the module structure orchestration expects', () => {
    const p: any = buildOrchestrationPayload(base, { modelName: 'anthropic--claude-4.8-opus', stream: false });
    expect(p.config.modules.prompt_templating.model.name).toBe('anthropic--claude-4.8-opus');
    expect(p.config.modules.prompt_templating.model.version).toBe('latest');
    expect(Array.isArray(p.messages_history)).toBe(true);
    expect(p.placeholder_values).toEqual({});
  });

  it('puts the system message in the template ONLY — messages_history carries no system entry', () => {
    // The de-duplication. The system message used to go in BOTH places, so the
    // wire carried the same (often ~40k-char) text twice — and because
    // applyCacheBreakpoints marked only the messages_history copy, one copy was
    // marked and one was not. That asymmetry is what made SAP report usage in an
    // inclusive shape (arm A0 of test/fixtures/orchestration/bridge-cache-probe-result.md:
    // prompt_tokens 15903 = 15892 cache + 11 new); de-duplicated it reports the
    // ordinary exclusive shape (arm A2: prompt_tokens flat at 14, cache 0 -> 17692).
    const p: any = buildOrchestrationPayload(base, { modelName: 'm', stream: false });

    const template = p.config.modules.prompt_templating.prompt.template;
    expect(template).toHaveLength(1);
    expect(template[0].role).toBe('system');
    expect(template[0].content).toEqual([{ type: 'text', text: 'be brief' }]);

    expect(p.messages_history.map((m: any) => m.role)).toEqual(['user']);
    // Not just "no system role" — the instructions TEXT appears exactly once in
    // the whole payload. A mutant that re-adds the duplicate under another role,
    // or leaves the object in history by reference, fails here.
    expect((JSON.stringify(p).match(/be brief/g) || [])).toHaveLength(1);
  });

  it('yields exactly ONE system copy on the fallback branch too, with nothing system-shaped in history', () => {
    // No `instructions` -> no system message in `messages`, so the template gets
    // the default entry. That default must not be joined by a second copy, and
    // nothing system-shaped may appear in messages_history either: the fallback
    // is the branch most likely to be missed by a de-dup fix written around the
    // `systemMessage` variable being truthy.
    const p: any = buildOrchestrationPayload({ input: 'hello' }, { modelName: 'm', stream: false });

    const template = p.config.modules.prompt_templating.prompt.template;
    expect(template).toHaveLength(1);
    expect(template[0].role).toBe('system');
    expect(template[0].content).toEqual([{ type: 'text', text: 'You are a helpful assistant.' }]);

    expect(p.messages_history.filter((m: any) => m.role === 'system')).toEqual([]);
    expect(p.messages_history.map((m: any) => m.role)).toEqual(['user']);
    expect((JSON.stringify(p).match(/You are a helpful assistant\./g) || [])).toHaveLength(1);
  });

  it('carries every NON-system message in messages_history, in order', () => {
    const p: any = buildOrchestrationPayload({
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
      ],
    }, { modelName: 'm', stream: false });
    expect(p.messages_history.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(p.messages_history.map((m: any) => m.content[0].text)).toEqual(['q1', 'a1', 'q2']);
  });

  it('never flattens system/user/assistant-with-text content to a string', () => {
    const p: any = buildOrchestrationPayload(base, { modelName: 'm', stream: false });
    for (const m of p.messages_history) {
      expect(Array.isArray(m.content)).toBe(true);
    }
  });

  it('gives a tool-call round trip the STRING content orchestration requires, not blocks', () => {
    // The one deliberate exception to "content is blocks": confirmed live
    // against orchestration (see requestTranslator.ts's file header).
    const p: any = buildOrchestrationPayload({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
      ],
    }, { modelName: 'm', stream: false });
    const [assistantCall, toolResult] = p.messages_history;
    expect(assistantCall).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
    });
    expect(toolResult).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file.txt' });
  });

  it('moves tools onto prompt.tools and tool_choice onto model.params', () => {
    const p: any = buildOrchestrationPayload({
      ...base,
      tools: [{ type: 'function', name: 'ls', parameters: { type: 'object' } }],
      tool_choice: 'auto',
    }, { modelName: 'm', stream: false });

    expect(p.config.modules.prompt_templating.prompt.tools).toEqual([
      { type: 'function', function: { name: 'ls', parameters: { type: 'object' } } },
    ]);
    expect(p.config.modules.prompt_templating.model.params.tool_choice).toBe('auto');
  });

  it('sets stream.enabled only when streaming', () => {
    const off: any = buildOrchestrationPayload(base, { modelName: 'm', stream: false });
    const on: any = buildOrchestrationPayload(base, { modelName: 'm', stream: true });
    expect(off.config.stream).toBeUndefined();
    expect(on.config.stream).toEqual({ enabled: true });
  });

  it('maps max_output_tokens and temperature onto model.params', () => {
    const p: any = buildOrchestrationPayload(
      { ...base, max_output_tokens: 256, temperature: 0.2 },
      { modelName: 'm', stream: false });
    expect(p.config.modules.prompt_templating.model.params.max_tokens).toBe(256);
    expect(p.config.modules.prompt_templating.model.params.temperature).toBe(0.2);
  });

  describe('reasoning.effort', () => {
    it('puts thinking and output_config inside params, beside max_tokens, for an adaptive-shape model', () => {
      const p: any = buildOrchestrationPayload(
        { ...base, max_output_tokens: 8192, reasoning: { effort: 'medium' } },
        { modelName: 'anthropic--claude-4.8-opus', stream: false });
      // Assert the actual nesting -- both keys live under the same params
      // object as max_tokens, not floating anywhere else in the payload.
      expect(p.config.modules.prompt_templating.model.params).toEqual({
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      });
    });

    it('produces neither key when reasoning carries no effort (e.g. {summary:"auto"})', () => {
      const p: any = buildOrchestrationPayload(
        { ...base, max_output_tokens: 8192, reasoning: { summary: 'auto' } },
        { modelName: 'anthropic--claude-4.8-opus', stream: false });
      const params = p.config.modules.prompt_templating.model.params;
      expect(params.thinking).toBeUndefined();
      expect(params.output_config).toBeUndefined();
    });

    it('produces neither key when reasoning is absent -- not a zero budget or a disabled shape', () => {
      const p: any = buildOrchestrationPayload(
        { ...base, max_output_tokens: 8192 },
        { modelName: 'anthropic--claude-4.8-opus', stream: false });
      const params = p.config.modules.prompt_templating.model.params;
      expect(params.thinking).toBeUndefined();
      expect(params.output_config).toBeUndefined();
    });

    it('leaves the four existing params unchanged, in presence and value, when reasoning also resolves', () => {
      // temperature:1 / top_p:0.95 are the measured-compatible sampling values --
      // anything else would suppress thinking (see the describe block below),
      // which would make "when reasoning also resolves" false and this test
      // would stop pinning what its title says.
      const p: any = buildOrchestrationPayload(
        {
          ...base, max_output_tokens: 8192, temperature: 1, top_p: 0.95,
          tool_choice: 'auto', reasoning: { effort: 'medium' },
        },
        { modelName: 'anthropic--claude-4.8-opus', stream: false });
      const params = p.config.modules.prompt_templating.model.params;
      expect(params.max_tokens).toBe(8192);
      expect(params.temperature).toBe(1);
      expect(params.top_p).toBe(0.95);
      expect(params.tool_choice).toBe('auto');
      // The point of "also resolves" -- without this, the test would pass
      // whether or not the resolver emitted anything at all.
      expect(params.thinking).toEqual({ type: 'adaptive' });
      expect(params.output_config).toEqual({ effort: 'medium' });
    });

    it('resolves the budget shape end-to-end through max_output_tokens, for a budget-shape model', () => {
      // All the tests above use 4.8-opus (adaptive), whose branch never reads
      // maxTokens -- so on its own this suite never proves the resolver call
      // site reads the right field. This pins the budget branch through the
      // real body key (max_output_tokens), catching a regression to e.g.
      // body?.max_tokens (a plausible typo -- max_tokens is the OUTPUT param
      // name, not a body field) that the adaptive-only tests would miss entirely.
      //
      // budget_tokens is 2048: floor(4096 / 2), the half-of-max_tokens
      // answer reserve -- not 3072 (max_tokens - 1024), an earlier, corrected
      // version of the clamp that left too little of the answer's own budget.
      const p: any = buildOrchestrationPayload(
        { ...base, max_output_tokens: 4096, reasoning: { effort: 'xhigh' } },
        { modelName: 'anthropic--claude-4.5-sonnet', stream: false });
      const params = p.config.modules.prompt_templating.model.params;
      expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
      expect(params.output_config).toBeUndefined();
    });

    describe('incompatible sampling params suppress thinking without touching the client value', () => {
      it('temperature 0.2 suppresses thinking and leaves params.temperature at the client value', () => {
        const p: any = buildOrchestrationPayload(
          { ...base, max_output_tokens: 8192, temperature: 0.2, reasoning: { effort: 'medium' } },
          { modelName: 'anthropic--claude-4.8-opus', stream: false });
        const params = p.config.modules.prompt_templating.model.params;
        expect(params.thinking).toBeUndefined();
        expect(params.output_config).toBeUndefined();
        // The whole point of the rule: the client's sampling value survives
        // untouched, not silently rewritten to 1 to make room for thinking.
        expect(params.temperature).toBe(0.2);
      });

      it('top_p 0.9 suppresses thinking and leaves params.top_p at the client value', () => {
        // The temperature counterpart above only proves the survival rule for
        // one key -- top_p goes through a separate `params.top_p = ...` line
        // in buildOrchestrationPayload, so it needs its own pin.
        const p: any = buildOrchestrationPayload(
          { ...base, max_output_tokens: 8192, top_p: 0.9, reasoning: { effort: 'medium' } },
          { modelName: 'anthropic--claude-4.8-opus', stream: false });
        const params = p.config.modules.prompt_templating.model.params;
        expect(params.thinking).toBeUndefined();
        expect(params.output_config).toBeUndefined();
        expect(params.top_p).toBe(0.9);
      });
    });

    describe('tool_choice "required" suppresses thinking without touching the client value', () => {
      it('"required" suppresses thinking and leaves params.tool_choice at "required"', () => {
        const p: any = buildOrchestrationPayload(
          { ...base, max_output_tokens: 8192, tool_choice: 'required', reasoning: { effort: 'medium' } },
          { modelName: 'anthropic--claude-4.8-opus', stream: false });
        const params = p.config.modules.prompt_templating.model.params;
        expect(params.thinking).toBeUndefined();
        expect(params.output_config).toBeUndefined();
        expect(params.tool_choice).toBe('required');
      });
    });
  });
});
