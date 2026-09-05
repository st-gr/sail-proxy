import { describe, it, expect } from '@jest/globals';
import {
  newCompletion, inferFinishReason, transformSAPResponseToOpenAI,
} from '../src/controllers/openaiController';

describe('response identity + finish_reason (#1,#3,#6)', () => {
  it('newCompletion returns a stable chatcmpl- id and echoes the model', () => {
    const c = newCompletion('gpt-4o');
    expect(c.id).toMatch(/^chatcmpl-[A-Za-z0-9_-]{16,}$/);
    expect(c.model).toBe('gpt-4o');
  });
  it('infers tool_calls when the message has tool_calls and upstream omitted the reason', () => {
    expect(inferFinishReason({ upstream: null, hasToolCalls: true })).toBe('tool_calls');
  });
  it('honours an explicit upstream finish_reason', () => {
    expect(inferFinishReason({ upstream: 'length', hasToolCalls: false })).toBe('length');
  });
  it('defaults to stop', () => {
    expect(inferFinishReason({ upstream: null, hasToolCalls: false })).toBeNull();
  });
  it('non-streaming: id/model come from completion, not a hardcoded gpt-4', () => {
    const completion = newCompletion('claude-3-7');
    const sap = { final_result: { choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] } };
    const out = transformSAPResponseToOpenAI(sap, false, completion);
    expect(out.model).toBe('claude-3-7');
    expect(out.id).toBe(completion.id);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });
  it('streaming: content chunk uses the passed completion id/model', () => {
    const completion = newCompletion('gpt-4o');
    const sap = { final_result: { choices: [{ index: 0, delta: { content: 'x' } }] } };
    const out = transformSAPResponseToOpenAI(sap, true, completion);
    expect(out.id).toBe(completion.id);
    expect(out.model).toBe('gpt-4o');
  });
  it('streaming: an intermediate content chunk keeps finish_reason null', () => {
    const c = newCompletion('gpt-4o');
    const sap = { final_result: { choices: [{ index: 0, delta: { content: 'x' } }] } };
    expect(transformSAPResponseToOpenAI(sap, true, c).choices[0].finish_reason).toBeNull();
  });
  it('streaming: a tool_calls delta with no upstream reason keeps finish_reason null', () => {
    const c = newCompletion('gpt-4o');
    const sap = { final_result: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] } };
    expect(transformSAPResponseToOpenAI(sap, true, c).choices[0].finish_reason).toBeNull();
  });
  it('non-streaming: no upstream reason and no tool_calls defaults to stop', () => {
    const c = newCompletion('gpt-4o');
    const sap = { final_result: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } };
    expect(transformSAPResponseToOpenAI(sap, false, c).choices[0].finish_reason).toBe('stop');
  });
  it('streaming: ignores SAP per-chunk id/model, uses the stable completion id/model', () => {
    const c = newCompletion('gpt-5-mini');
    const sap = { final_result: { id: 'chatcmpl-UPSTREAM', model: 'gpt-5-mini-2025-08-07', choices: [{ index: 0, delta: { content: 'x' } }] } };
    const out = transformSAPResponseToOpenAI(sap, true, c);
    expect(out.id).toBe(c.id);
    expect(out.model).toBe('gpt-5-mini');
    expect(out.id).not.toBe('chatcmpl-UPSTREAM');
    expect(out.model).not.toBe('gpt-5-mini-2025-08-07');
  });
  it('non-streaming: ignores SAP id/model, uses the stable completion id/model', () => {
    const c = newCompletion('gpt-5-mini');
    const sap = { final_result: { id: 'chatcmpl-UPSTREAM', model: 'gpt-5-mini-2025-08-07', choices: [{ message: { role: 'assistant', content: 'hi' } }] } };
    const out = transformSAPResponseToOpenAI(sap, false, c);
    expect(out.id).toBe(c.id);
    expect(out.model).toBe('gpt-5-mini');
  });
});
