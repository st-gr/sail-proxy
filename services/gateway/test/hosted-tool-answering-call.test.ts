import { describe, it, expect } from '@jest/globals';
import { withoutFunctionTools } from '../src/pluginSupport/hostedTool/answeringCall';

describe('withoutFunctionTools — the body of the answering call', () => {
  const search = { type: 'function', name: 'web_search', parameters: {} };
  const shell = { type: 'function', name: 'shell', parameters: {} };

  it('removes the named function tools and keeps every other tool and field', () => {
    const body = { model: 'm', input: 'go', tool_choice: 'auto', tools: [search, shell, { type: 'custom', name: 'web_search' }] };
    expect(withoutFunctionTools(body, ['web_search'])).toEqual({
      model: 'm', input: 'go', tool_choice: 'auto', tools: [shell, { type: 'custom', name: 'web_search' }],
    });
  });

  it('recognises a function tool in the chat shape, with its name nested under `function`', () => {
    const body = { tools: [{ type: 'function', function: { name: 'web_search' } }, shell] };
    expect(withoutFunctionTools(body, ['web_search']).tools).toEqual([shell]);
  });

  it('does not change the body it was given', () => {
    const body = { tools: [search, shell], tool_choice: 'auto' };
    const next = withoutFunctionTools(body, ['web_search']);
    expect(next).not.toBe(body);
    expect(body).toEqual({ tools: [search, shell], tool_choice: 'auto' });
  });

  it('returns the same body when there is nothing to remove', () => {
    const body = { tools: [shell] };
    expect(withoutFunctionTools(body, ['web_search'])).toBe(body);
    expect(withoutFunctionTools(body, [])).toBe(body);
    const noTools = { input: 'go' };
    expect(withoutFunctionTools(noTools, ['web_search'])).toBe(noTools);
  });

  it('removes `tools` and `tool_choice` altogether when no tool is left', () => {
    const next = withoutFunctionTools({ input: 'go', tools: [search], tool_choice: 'auto' }, ['web_search']);
    expect(next).toEqual({ input: 'go' });
  });

  it("falls back to 'auto' when tool_choice names a removed tool, and keeps any other choice", () => {
    expect(withoutFunctionTools({ tools: [search, shell], tool_choice: { type: 'function', name: 'web_search' } }, ['web_search']).tool_choice)
      .toBe('auto');
    expect(withoutFunctionTools({ tools: [search, shell], tool_choice: { type: 'function', name: 'shell' } }, ['web_search']).tool_choice)
      .toEqual({ type: 'function', name: 'shell' });
    expect(withoutFunctionTools({ tools: [search, shell], tool_choice: 'none' }, ['web_search']).tool_choice).toBe('none');
  });
});
