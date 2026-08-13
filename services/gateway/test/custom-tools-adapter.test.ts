import {
  translateCustomTools, resolveCustomToolMode, DEFAULT_CUSTOM_TOOL_MODE, FREEFORM_PARAM, translateCustomCallItems,
  restoreCustomToolCall, restoreOutputItems,
} from '../src/plugins/customTools/adapter';

const applyPatchTool = () => ({
  type: 'custom',
  name: 'apply_patch',
  description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch\n' },
});

describe('translateCustomTools', () => {
  it('rewrites a custom tool into a function tool with a single string parameter', () => {
    const body = { tools: [{ type: 'function', name: 'exec_command' }, applyPatchTool()] };
    const result = translateCustomTools(body, 'translate');

    expect(result.changed).toBe(true);
    expect(result.names).toEqual(['apply_patch']);
    expect(body.tools[1]).toMatchObject({
      type: 'function',
      name: 'apply_patch',
      parameters: {
        type: 'object',
        properties: { [FREEFORM_PARAM]: { type: 'string' } },
        required: [FREEFORM_PARAM],
      },
    });
    expect((body.tools[1] as any).format).toBeUndefined();
  });

  it('overrides the freeform instruction, which is actively wrong after translation', () => {
    const body = { tools: [applyPatchTool()] };
    translateCustomTools(body, 'translate');
    const description: string = (body.tools[0] as any).description;

    // The original text says "do not wrap the patch in JSON". Left alone, the model
    // emits bare patch text as the arguments and produces invalid JSON.
    expect(description).toContain('do not wrap the patch in JSON');   // original retained
    expect(description).toContain(FREEFORM_PARAM);                    // and explicitly overridden
    expect(description).toMatch(/ignore[\s\S]*freeform/i);
  });

  it('carries the lark grammar into the description as a soft constraint', () => {
    const body = { tools: [applyPatchTool()] };
    translateCustomTools(body, 'translate');
    expect((body.tools[0] as any).description).toContain('start: begin_patch hunk+ end_patch');
  });

  it('never tells the model to JSON-encode the payload, which caused live double-wrapping', () => {
    // A model reading "JSON-escaped" as "encode the payload as JSON" produced
    // {"input": "{\"input\": \"...\"}"} on live traffic (anthropic--claude-4.8-opus).
    // The override must say the opposite: the payload goes in verbatim, not encoded.
    const body = { tools: [applyPatchTool()] };
    translateCustomTools(body, 'translate');
    const description: string = (body.tools[0] as any).description;

    expect(description).not.toMatch(/json[- ]escaped/i);
    expect(description.toLowerCase()).not.toContain('encode the payload as json');
    // The override and the grammar must still both be present.
    expect(description).toMatch(/ignore[\s\S]*freeform/i);
    expect(description).toContain('start: begin_patch hunk+ end_patch');
  });

  it('removes the tool entirely in strip mode and reports it dropped', () => {
    const body = { tools: [{ type: 'function', name: 'exec_command' }, applyPatchTool()] };
    const result = translateCustomTools(body, 'strip');
    expect(result.dropped).toEqual(['apply_patch']);
    expect(result.names).toEqual([]);
    expect(body.tools).toHaveLength(1);
  });

  it('deletes an emptied tools array, which some deployments reject', () => {
    const body: any = { tools: [applyPatchTool()] };
    translateCustomTools(body, 'strip');
    expect(body.tools).toBeUndefined();
  });

  it('is a no-op when no custom tool is present', () => {
    const body = { tools: [{ type: 'function', name: 'exec_command' }] };
    expect(translateCustomTools(body, 'translate').changed).toBe(false);
  });

  it('resolves an unknown mode to the default', () => {
    expect(resolveCustomToolMode('nonsense')).toBe(DEFAULT_CUSTOM_TOOL_MODE);
    expect(DEFAULT_CUSTOM_TOOL_MODE).toBe('translate');
  });
});

describe('translateCustomCallItems', () => {
  it('converts a custom_tool_call into a function_call with JSON arguments', () => {
    const body = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
        { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
      ],
    };
    expect(translateCustomCallItems(body)).toBe(1);
    // No `id`: a ctc_-prefixed id is invalid on a function_call, which the upstream
    // validates by prefix — see the dedicated id-dropping tests below.
    expect(body.input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch\n' }),
    });
  });

  it('flattens the ARRAY-shaped custom_tool_call_output into a string', () => {
    // A function_call_output carries a string; a custom_tool_call_output carries
    // content parts. Confirmed against real OpenAI traffic — see
    // test/fixtures/codex-custom-tools/README.md, client_custom_tool_call_output.
    const body = {
      input: [
        { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1', output: [{ type: 'input_text', text: 'Success' }] },
      ],
    };
    expect(translateCustomCallItems(body)).toBe(1);
    // No `id`, for the same reason as the custom_tool_call case above.
    expect(body.input[0]).toEqual({
      type: 'function_call_output', call_id: 'call_1', output: 'Success',
    });
  });

  it('joins multiple output parts in order', () => {
    const body = {
      input: [{ type: 'custom_tool_call_output', call_id: 'c', output: [
        { type: 'input_text', text: 'first' }, { type: 'input_text', text: 'second' },
      ] }],
    };
    translateCustomCallItems(body);
    expect((body.input[0] as any).output).toBe('first\nsecond');
  });

  it('passes a string-shaped output through unchanged', () => {
    const body = { input: [{ type: 'custom_tool_call_output', call_id: 'c', output: 'already a string' }] };
    translateCustomCallItems(body);
    expect((body.input[0] as any).output).toBe('already a string');
  });

  it('drops a ctc_-prefixed id rather than carrying it onto the function_call, whose id prefix the upstream validates against the NEW type', () => {
    // Live capture (2026-08-11, deployed gpt-5.3-codex, turn 2 of a conversation):
    // carrying the id verbatim produced "Invalid 'input[8].id':
    // 'ctco_019ff2c9-c862-77f1-8ccd-21401a4e93fa'. Expected an ID that begins with 'fc'."
    // call_id is the pairing key and is unaffected; only the item's own optional id is dropped.
    const body = {
      input: [
        { type: 'custom_tool_call', id: 'ctc_019ff2c9-c862-77f1-8ccd-21401a4e93fb', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
      ],
    };
    expect(translateCustomCallItems(body)).toBe(1);
    const item: any = body.input[0];
    expect(item.type).toBe('function_call');
    expect(item.call_id).toBe('call_1');
    expect(item).not.toHaveProperty('id');
  });

  it('drops a ctco_-prefixed id rather than carrying it onto the function_call_output', () => {
    // The exact id from the live capture that triggered the defect.
    const body = {
      input: [
        {
          type: 'custom_tool_call_output', id: 'ctco_019ff2c9-c862-77f1-8ccd-21401a4e93fa',
          call_id: 'call_1', status: 'completed', output: [{ type: 'input_text', text: 'Success' }],
        },
      ],
    };
    expect(translateCustomCallItems(body)).toBe(1);
    const item: any = body.input[0];
    expect(item).toEqual({
      type: 'function_call_output', call_id: 'call_1', status: 'completed', output: 'Success',
    });
    expect(item).not.toHaveProperty('id');
  });

  it('leaves unrelated items alone and reports zero', () => {
    const body = { input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'function_call', name: 'x', arguments: '{}' }] };
    expect(translateCustomCallItems(body)).toBe(0);
  });

  it('tolerates a string input body', () => {
    const body = { input: 'plain string' };
    expect(translateCustomCallItems(body)).toBe(0);
  });
});

describe('restoreCustomToolCall', () => {
  const names = new Set(['apply_patch']);

  it('turns a function_call back into a custom_tool_call carrying raw input', () => {
    const item: any = {
      type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch\n' }),
    };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.type).toBe('custom_tool_call');
    expect(item.input).toBe('*** Begin Patch\n*** End Patch\n');
    expect(item.call_id).toBe('call_1');
    expect(item.arguments).toBeUndefined();
  });

  it('falls back to the raw arguments when the model ignored the JSON instruction', () => {
    // A model that obeys the ORIGINAL "do not wrap in JSON" text emits bare patch
    // text. Passing it through as the input still produces a usable call.
    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: '*** Begin Patch\n' };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.input).toBe('*** Begin Patch\n');
  });

  it('falls back to the raw arguments when the JSON lacks the input property', () => {
    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: '{"patch":"x"}' };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.input).toBe('{"patch":"x"}');
  });

  it('leaves a function_call for a tool we did not translate completely alone', () => {
    const item: any = { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{"cmd":"ls"}' };
    expect(restoreCustomToolCall(item, names)).toBe(false);
    expect(item.type).toBe('function_call');
    expect(item.arguments).toBe('{"cmd":"ls"}');
  });

  it('ignores non-function_call items', () => {
    expect(restoreCustomToolCall({ type: 'message' }, names)).toBe(false);
    expect(restoreCustomToolCall(null, names)).toBe(false);
  });

  it('counts restorations across an output array', () => {
    const output = [
      { type: 'message' },
      { type: 'function_call', call_id: 'a', name: 'apply_patch', arguments: '{"input":"p"}' },
      { type: 'function_call', call_id: 'b', name: 'exec_command', arguments: '{}' },
    ];
    expect(restoreOutputItems(output, names)).toBe(1);
    expect((output[1] as any).type).toBe('custom_tool_call');
    expect((output[2] as any).type).toBe('function_call');
  });

  it('returns zero for a non-array output', () => {
    expect(restoreOutputItems(undefined, names)).toBe(0);
  });
});

describe('restoreCustomToolCall — double-wrap unwrapping', () => {
  const names = new Set(['apply_patch']);

  // Verbatim from live traffic (anthropic--claude-4.8-opus, orchestration route,
  // 2026-08-11): the model put a whole {"input": ...} envelope INSIDE the input
  // string instead of the raw patch text.
  const rawPatch = '*** Begin Patch\n*** Add File: hi.txt\n+hello\n*** End Patch';

  it('unwraps a double-wrapped payload to the raw patch text', () => {
    const doubleWrapped = JSON.stringify({ input: JSON.stringify({ input: rawPatch }) });
    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: doubleWrapped };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.input).toBe(rawPatch);
  });

  it('leaves a singly-wrapped payload unchanged (no over-unwrapping)', () => {
    const singlyWrapped = JSON.stringify({ input: rawPatch });
    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: singlyWrapped };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.input).toBe(rawPatch);
  });

  it('does not unwrap a payload that merely starts with "{" but is not our wrapper shape', () => {
    // Not our shape: a single key, but not named "input".
    const notOurKey = JSON.stringify({ input: JSON.stringify({ a: 1 }) });
    const item1: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: notOurKey };
    restoreCustomToolCall(item1, names);
    expect(item1.input).toBe(JSON.stringify({ a: 1 }));

    // Not our shape: has "input", but also another key.
    const extraKey = JSON.stringify({ input: JSON.stringify({ input: 'x', extra: 1 }) });
    const item2: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: extraKey };
    restoreCustomToolCall(item2, names);
    expect(item2.input).toBe(JSON.stringify({ input: 'x', extra: 1 }));
  });

  it('still falls back to the raw arguments string when arguments is not valid JSON', () => {
    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: rawPatch };
    expect(restoreCustomToolCall(item, names)).toBe(true);
    expect(item.input).toBe(rawPatch);
  });

  it('bounds the number of unwraps so a pathologically nested wrapper does not loop forever', () => {
    // 5 layers of wrapping around the raw (non-JSON) payload.
    const wrap1 = JSON.stringify({ input: rawPatch });
    const wrap2 = JSON.stringify({ input: wrap1 });
    const wrap3 = JSON.stringify({ input: wrap2 });
    const wrap4 = JSON.stringify({ input: wrap3 });
    const wrap5 = JSON.stringify({ input: wrap4 });

    const item: any = { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: wrap5 };
    restoreCustomToolCall(item, names);

    // The bound (2 extra unwraps beyond the base extraction) stops short of the raw
    // text: it should have peeled exactly 3 layers total (wrap5 -> wrap2), not all 5.
    expect(item.input).toBe(wrap2);
    expect(item.input).not.toBe(rawPatch);
  });
});
