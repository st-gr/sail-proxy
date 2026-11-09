/**
 * Gemini 3 refuses a replayed tool call without its thought signature, and SAP orchestration has no
 * signature field: it packs the signature into the tool call id (`vertex_tool_<uuid>__<signature>`,
 * measured 2026-11-04 on gemini-3.5-flash). The bridge used to drop that id and mint its own, so
 * Gemini CLI failed on the turn after its first tool call with "Function call is missing a
 * thought_signature". The id now travels in `thoughtSignature`, the field Gemini clients echo back.
 */
import { describe, it, expect } from '@jest/globals';
import { orchestrationToGeminiResponse } from '../src/google/orchestrationBridge/responseTranslator';
import { createGeminiStreamTranslator } from '../src/google/orchestrationBridge/streamTranslator';
import { geminiToOrchestrationPayload } from '../src/google/orchestrationBridge/requestTranslator';

const SAP_ID = 'vertex_tool_ba7f3b26__Q2lNQkFZ';
const call = (id: string) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } });
const envelope = (id: string) => ({
  final_result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [call(id)] }, finish_reason: 'tool_calls' }] },
});
const partOf = (id: string) => orchestrationToGeminiResponse(envelope(id), { modelName: 'gemini-3.5-flash' }).candidates[0].content.parts[0];

function historyWith(part: any) {
  return {
    contents: [
      { role: 'user', parts: [{ text: 'read a.txt' }] },
      { role: 'model', parts: [part] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'hello' } } }] },
    ],
  };
}
function replayed(part: any, modelName: string) {
  const payload: any = geminiToOrchestrationPayload(historyWith(part), { modelName, stream: false });
  const messages: any[] = [...(payload.messages_history ?? []), ...payload.config.modules.prompt_templating.prompt.template];
  return {
    callId: messages.find((m) => m.tool_calls)?.tool_calls[0].id,
    answerId: messages.find((m) => m.role === 'tool')?.tool_call_id,
  };
}

describe('Gemini thought signature carried by the SAP tool call id', () => {
  it('a non-streaming reply puts the id into thoughtSignature on the part', () => {
    const part = partOf(SAP_ID);
    expect(part.functionCall).toEqual({ name: 'read_file', args: { path: 'a.txt' } });
    expect(typeof part.thoughtSignature).toBe('string');
    expect(part.thoughtSignature).toContain(SAP_ID);
  });

  it('a streamed reply does the same', () => {
    const t = createGeminiStreamTranslator({ modelName: 'gemini-3.5-flash' });
    const frames = t.onChunk({
      final_result: { choices: [{ delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, ...call(SAP_ID) }] }, finish_reason: 'tool_calls' }] },
    });
    const body = JSON.parse(frames[0].replace(/^data: /, ''));
    expect(body.candidates[0].content.parts[0].thoughtSignature).toContain(SAP_ID);
  });

  it('keeps parallel calls apart: SAP streams both at index 0, only the first with a signature', () => {
    // Measured 2026-11-04: read_file twice in one turn, two deltas, both `index: 0`, different ids.
    const t = createGeminiStreamTranslator({ modelName: 'gemini-3.5-flash' });
    const delta = (id: string, path: string) => ({
      final_result: { choices: [{ delta: { role: 'assistant', content: '', tool_calls: [{
        index: 0, id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) },
      }] } }] },
    });
    const frames = [
      ...t.onChunk(delta(SAP_ID, 'add.js')),
      ...t.onChunk(delta('vertex_tool_553f26b4', 'add.test.js')),
      ...t.onChunk({ final_result: { choices: [{ delta: { content: '' }, finish_reason: 'stop' }] } }),
      ...t.finish(),
    ];
    const parts = frames.flatMap((f) => JSON.parse(f.slice('data: '.length)).candidates[0].content.parts);
    expect(parts.map((p: any) => p.functionCall.args)).toEqual([{ path: 'add.js' }, { path: 'add.test.js' }]);
    expect(parts[0].thoughtSignature).toContain(SAP_ID);
  });

  it('still assembles one call from deltas that repeat its id or carry none', () => {
    const t = createGeminiStreamTranslator({ modelName: 'gemini-3.5-flash' });
    const delta = (tool: any) => ({ final_result: { choices: [{ delta: { tool_calls: [{ index: 0, ...tool }] } }] } });
    const frames = [
      ...t.onChunk(delta({ id: SAP_ID, type: 'function', function: { name: 'read_file', arguments: '{"path":' } })),
      ...t.onChunk(delta({ id: SAP_ID, function: { arguments: '"a' } })),
      ...t.onChunk(delta({ function: { arguments: '.txt"}' } })),
      ...t.finish(),
    ];
    const parts = frames.flatMap((f) => JSON.parse(f.slice('data: '.length)).candidates[0].content.parts);
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall.args).toEqual({ path: 'a.txt' });
  });

  it('the id round-trips onto the replayed call and its answer', () => {
    expect(replayed(partOf(SAP_ID), 'gemini-3.5-flash')).toEqual({ callId: SAP_ID, answerId: SAP_ID });
  });

  it('adds nothing for a tool call id that carries no signature', () => {
    expect(partOf('c00001000').thoughtSignature).toBeUndefined();
  });

  it('mints an id for another family, because Mistral refuses any other shape', () => {
    const { callId } = replayed(partOf(SAP_ID), 'mistralai--mistral-medium');
    expect(callId).toMatch(/^[a-z0-9]{9}$/);
  });

  it('mints an id for a signature that came from elsewhere, such as a deployed Gemini', () => {
    const { callId } = replayed({ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'AY89a1opaque' }, 'gemini-3.5-flash');
    expect(callId).toMatch(/^[a-z0-9]{9}$/);
  });
});
