/**
 * Codex 0.149 declares its tools in an `additional_tools` input item instead of `tools` (captured
 * 2026-11-04). A deployment takes that item; the orchestration bridge refused it with a 400 on the
 * first request. Hoisting it into `tools` lets the namespace and custom-tool plugins do their job.
 */
import { describe, it, expect } from '@jest/globals';
import { hoistAdditionalTools } from '../src/responses/orchestrationBridge/additionalTools';
import { flattenNamespaceTools } from '../src/pluginSupport/namespaceTools/adapter';

const wait = { type: 'function', name: 'wait', parameters: { type: 'object', properties: {} } };
const spawn = { type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: {} } };
const exec = { type: 'custom', name: 'exec', description: 'Run code', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } };
const message = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
const item = (tools: any[]) => ({ type: 'additional_tools', role: 'developer', tools });
const ns = (name: string, tools: any[]) => ({ type: 'namespace', name, description: '', tools });

describe('hoistAdditionalTools', () => {
  it('removes the item from the input and declares its tools', () => {
    const body: any = { input: [item([ns('collaboration', [spawn])]), message] };
    hoistAdditionalTools(body);
    expect(body.input).toEqual([message]);
    expect(body.tools).toEqual([ns('collaboration', [spawn])]);
  });

  it('lifts a custom tool out of its namespace, because the namespace flattener only keeps function tools', () => {
    const body: any = { input: [item([ns('functions', [exec, wait])]), message] };
    hoistAdditionalTools(body);
    expect(body.tools).toEqual([exec, ns('functions', [wait])]);
    const { map } = flattenNamespaceTools(body, 'flatten');
    expect(map).toEqual({ wait: 'functions' });
    expect(body.tools.map((t: any) => t.name)).toEqual(['exec', 'wait']);
  });

  it('drops a namespace that held only custom tools', () => {
    const body: any = { input: [item([ns('functions', [exec])])] };
    hoistAdditionalTools(body);
    expect(body.tools).toEqual([exec]);
  });

  it('keeps tools the request already declared, ahead of the hoisted ones', () => {
    const body: any = { tools: [wait], input: [item([spawn])] };
    hoistAdditionalTools(body);
    expect(body.tools).toEqual([wait, spawn]);
  });

  it('merges several items', () => {
    const body: any = { input: [item([wait]), message, item([spawn])] };
    hoistAdditionalTools(body);
    expect(body.tools).toEqual([wait, spawn]);
    expect(body.input).toEqual([message]);
  });

  it('leaves a request without the item alone, including a string input', () => {
    const a: any = { input: 'hi' };
    hoistAdditionalTools(a);
    expect(a).toEqual({ input: 'hi' });
    const b: any = { input: [message] };
    hoistAdditionalTools(b);
    expect(b).toEqual({ input: [message] });
  });

  it('removes an item with no tools without declaring an empty list', () => {
    const body: any = { input: [{ type: 'additional_tools', role: 'developer' }, message] };
    hoistAdditionalTools(body);
    expect(body).toEqual({ input: [message] });
  });
});
