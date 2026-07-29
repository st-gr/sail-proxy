import { describe, it, expect } from '@jest/globals';
import {
  flattenNamespaceTools, renestFunctionCall, renestOutputItems,
  resolveNamespaceToolMode, DEFAULT_NAMESPACE_TOOL_MODE,
} from '../src/plugins/namespaceTools/adapter';

const fn = (name: string) => ({
  type: 'function', name, description: `does ${name}`,
  parameters: { type: 'object', properties: {}, required: [] }, strict: false,
});

const NAMESPACE = {
  type: 'namespace', name: 'multi_agent_v1',
  description: 'Tools for spawning and managing sub-agents.',
  tools: [fn('close_agent'), fn('spawn_agent'), fn('wait_agent')],
};

describe('resolveNamespaceToolMode', () => {
  it('defaults to flatten', () => {
    expect(DEFAULT_NAMESPACE_TOOL_MODE).toBe('flatten');
    expect(resolveNamespaceToolMode(undefined)).toBe('flatten');
  });

  it('accepts the two valid modes and rejects everything else', () => {
    expect(resolveNamespaceToolMode('flatten')).toBe('flatten');
    expect(resolveNamespaceToolMode('strip')).toBe('strip');
    for (const bad of ['FLATTEN', 'off', '', 0, null, {}, [], true]) {
      expect(resolveNamespaceToolMode(bad as any)).toBe('flatten');
    }
  });
});

describe('flattenNamespaceTools', () => {
  it('hoists nested tools in place and records the map', () => {
    const body: any = { tools: [fn('exec_command'), { ...NAMESPACE }, fn('view_image')] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(r.changed).toBe(true);
    expect(body.tools.map((t: any) => t.name)).toEqual(
      ['exec_command', 'close_agent', 'spawn_agent', 'wait_agent', 'view_image']);
    expect(body.tools.some((t: any) => t.type === 'namespace')).toBe(false);
    expect(r.map).toEqual({
      close_agent: 'multi_agent_v1', spawn_agent: 'multi_agent_v1', wait_agent: 'multi_agent_v1',
    });
    expect(r.hoisted).toEqual(['close_agent', 'spawn_agent', 'wait_agent']);
  });

  it('hoists nested tools verbatim', () => {
    const body: any = { tools: [{ ...NAMESPACE }] };
    flattenNamespaceTools(body, 'flatten');
    expect(body.tools[0]).toEqual(NAMESPACE.tools[0]);
  });

  it('drops a nested tool whose name collides with a top-level one, and omits it from the map', () => {
    const body: any = { tools: [fn('spawn_agent'), { ...NAMESPACE }] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(body.tools.filter((t: any) => t.name === 'spawn_agent')).toHaveLength(1);
    expect(r.dropped).toContain('spawn_agent');
    expect(r.map.spawn_agent).toBeUndefined();
  });

  it('strip mode removes the namespace and records no map', () => {
    const body: any = { tools: [fn('exec_command'), { ...NAMESPACE }] };

    const r = flattenNamespaceTools(body, 'strip');

    expect(body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(r.map).toEqual({});
    expect(r.dropped).toEqual(['close_agent', 'spawn_agent', 'wait_agent']);
  });

  it('handles multiple namespaces and keeps each tool with its own', () => {
    const other = { type: 'namespace', name: 'crm_v1', tools: [fn('lookup')] };
    const body: any = { tools: [{ ...NAMESPACE }, other] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(r.map.lookup).toBe('crm_v1');
    expect(r.map.close_agent).toBe('multi_agent_v1');
  });

  it('deletes an emptied tools key rather than sending []', () => {
    const body: any = { tools: [{ type: 'namespace', name: 'empty_v1', tools: [] }] };
    flattenNamespaceTools(body, 'flatten');
    expect('tools' in body).toBe(false);
  });

  it('is a no-op without a namespace tool, and tolerates junk', () => {
    const body: any = { tools: [fn('exec_command')] };
    const snapshot = JSON.parse(JSON.stringify(body));
    expect(flattenNamespaceTools(body, 'flatten').changed).toBe(false);
    expect(body).toEqual(snapshot);

    for (const junk of [{}, { tools: 'nope' }, null, undefined] as any[]) {
      expect(() => flattenNamespaceTools(junk, 'flatten')).not.toThrow();
      expect(flattenNamespaceTools(junk, 'flatten').changed).toBe(false);
    }
  });

  it('skips nested entries that are not function tools', () => {
    const body: any = { tools: [{ ...NAMESPACE, tools: [fn('ok'), { type: 'namespace', name: 'x' }, null] }] };
    const r = flattenNamespaceTools(body, 'flatten');
    expect(r.hoisted).toEqual(['ok']);
  });

  // A tool name is data off the wire, and the map is keyed by it. On a plain object
  // literal `map['__proto__'] = ns` goes through Object.prototype's `__proto__` SETTER,
  // which silently ignores a non-object: no own property is created and the prototype is
  // left alone too, so the tool is reported hoisted while never actually mapping — and
  // reading it back yields Object.prototype, which renestFunctionCall would stamp onto
  // the call as a bogus `"namespace":{}`. A prototype-less map makes both halves ordinary.
  it('maps a tool named __proto__ as an own property, not through the prototype', () => {
    const body: any = { tools: [{ ...NAMESPACE, tools: [fn('__proto__'), fn('spawn_agent')] }] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(r.hoisted).toEqual(['__proto__', 'spawn_agent']);
    expect(Object.getPrototypeOf(r.map)).toBeNull();
    expect(Object.keys(r.map)).toEqual(['__proto__', 'spawn_agent']);
    expect(r.map['__proto__']).toBe('multi_agent_v1');

    const call: any = { type: 'function_call', call_id: 'c1', name: '__proto__', arguments: '{}' };
    expect(renestFunctionCall(call, r.map)).toBe(true);
    expect(call.namespace).toBe('multi_agent_v1');
  });

  // The same read hazard without the write: an inherited member is truthy, so a call to a
  // tool the map never mentions would have been given a function as its namespace —
  // dropped by JSON.stringify, but only after forcing a needless re-serialisation.
  it('does not resolve an inherited member for a tool named toString or constructor', () => {
    const r = flattenNamespaceTools({ tools: [{ ...NAMESPACE }] } as any, 'flatten');

    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const call: any = { type: 'function_call', call_id: 'c1', name, arguments: '{}' };
      expect(renestFunctionCall(call, r.map)).toBe(false);
      expect('namespace' in call).toBe(false);
    }
  });
});

describe('renestFunctionCall', () => {
  const map = { close_agent: 'multi_agent_v1' };

  it('adds the namespace Codex needs to route the call', () => {
    const item: any = { type: 'function_call', name: 'close_agent', call_id: 'c1', arguments: '{}' };

    expect(renestFunctionCall(item, map)).toBe(true);
    expect(item.namespace).toBe('multi_agent_v1');
  });

  it('leaves an unrelated function call alone', () => {
    const item: any = { type: 'function_call', name: 'exec_command', call_id: 'c1' };
    expect(renestFunctionCall(item, map)).toBe(false);
    expect('namespace' in item).toBe(false);
  });

  it('does not overwrite a namespace the model already set', () => {
    const item: any = { type: 'function_call', name: 'close_agent', namespace: 'other', call_id: 'c1' };
    expect(renestFunctionCall(item, map)).toBe(false);
    expect(item.namespace).toBe('other');
  });

  it('ignores non-function-call items and junk', () => {
    for (const junk of [{ type: 'message' }, {}, null, undefined] as any[]) {
      expect(renestFunctionCall(junk, map)).toBe(false);
    }
  });

  it('is a no-op with an empty map', () => {
    const item: any = { type: 'function_call', name: 'close_agent', call_id: 'c1' };
    expect(renestFunctionCall(item, {})).toBe(false);
  });
});

describe('renestOutputItems', () => {
  it('re-nests every matching call in an output array and counts them', () => {
    const map = { close_agent: 'multi_agent_v1', spawn_agent: 'multi_agent_v1' };
    const output: any = [
      { type: 'reasoning', id: 'r1' },
      { type: 'function_call', name: 'spawn_agent', call_id: 'c1' },
      { type: 'function_call', name: 'exec_command', call_id: 'c2' },
      { type: 'function_call', name: 'close_agent', call_id: 'c3' },
    ];

    expect(renestOutputItems(output, map)).toBe(2);
    expect(output[1].namespace).toBe('multi_agent_v1');
    expect('namespace' in output[2]).toBe(false);
    expect(output[3].namespace).toBe('multi_agent_v1');
  });

  it('returns 0 for a non-array or an empty map', () => {
    expect(renestOutputItems(undefined, { a: 'b' })).toBe(0);
    expect(renestOutputItems([{ type: 'function_call', name: 'a' }], {})).toBe(0);
  });
});
