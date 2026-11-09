/**
 * An image inside a tool_result (Claude Code reading a screenshot) has to reach the model on the
 * orchestration path. Orchestration's `tool` message takes a plain string, so the image travels in
 * the user message right after the tool messages.
 */
import { describe, it, expect } from '@jest/globals';
import { processAnthropicMessages } from '../src/services/anthropicMessageService';

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } };
const imageUrl = { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } };
const result = (id: string, content: any) => ({ type: 'tool_result', tool_use_id: id, content });

describe('processAnthropicMessages: images in tool results', () => {
  it('moves an image-only result into a user message after the tool message', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [result('t1', [image])] }] as any);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
    expect(typeof out[0].content).toBe('string');
    expect(out[0].content).not.toBe('');
    expect(out[1]).toMatchObject({ role: 'user', content: [imageUrl], has_image: true });
  });

  it('keeps the text of a mixed result in the tool message', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [result('t1', [{ type: 'text', text: 'page 1' }, image])] }] as any);
    expect(out[0].content).toBe('page 1');
    expect(out[1].content).toEqual([imageUrl]);
  });

  it('keeps every tool message contiguous, with the images behind the last one', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [result('t1', [image]), result('t2', 'plain')] }] as any);
    expect(out.map((m) => m.role)).toEqual(['tool', 'tool', 'user']);
    expect(out[2].content).toEqual([imageUrl]);
  });

  it('puts the images before what the user added in the same turn', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [result('t1', [image]), { type: 'text', text: 'and now?' }] }] as any);
    expect(out[1].content).toEqual([imageUrl, { type: 'text', text: 'and now?' }]);
  });

  it('adds no user message for results without images', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [result('t1', 'plain')] }] as any);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 't1', content: 'plain', has_tools: true }]);
  });

  it('prefixes an image-only error result like any other error', () => {
    const out = processAnthropicMessages([{ role: 'user', content: [{ ...result('t1', [image]), is_error: true }] }] as any);
    expect(String(out[0].content).startsWith('Error: ')).toBe(true);
  });
});
