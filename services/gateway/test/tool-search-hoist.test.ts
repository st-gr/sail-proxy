/**
 * The hoist workaround: discovered MCP tools are lifted out of a replayed tool_search_output
 * into the request's own `tools` array, because codex only keeps deferred tools exposed when the
 * provider base_url is api.openai.com (measured 2026-08-11 — the URL is the sole discriminator).
 *
 * Shapes verbatim from test/fixtures/codex-custom-tools/tool-search-capture.md.
 */
import { describe, it, expect } from '@jest/globals';
import {
  hoistDiscoveredTools, translateToolSearchOutputItems,
  resolveHoistDiscoveredTools, DEFAULT_HOIST_DISCOVERED_TOOLS,
} from '../src/plugins/toolSearch/adapter';

const discoveredOutput = () => ({
  type: 'tool_search_output',
  id: 'tso_019ff30e-f030-70a2-b22f-544e804b5699',
  call_id: 'call_1jyP3Ac7IS5Hnl92l4Kxgc2N',
  status: 'completed',
  execution: 'client',
  tools: [{
    type: 'namespace',
    name: 'mcp__capturedocs',
    description: 'Tools in the mcp__capturedocs namespace.',
    tools: [
      {
        type: 'function', name: 'capture_read_document', description: 'Read one document.',
        strict: false, defer_loading: true,
        parameters: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'] },
      },
      {
        type: 'function', name: 'capture_list_documents', description: 'List documents.',
        strict: false, defer_loading: true,
        parameters: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'] },
      },
    ],
  }],
});

describe('hoistDiscoveredTools', () => {
  it('lifts the discovered tools into body.tools as FLAT function tools', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }], input: [discoveredOutput()] };
    const r = hoistDiscoveredTools(body);

    expect(r.hoisted).toEqual(['capture_read_document', 'capture_list_documents']);
    expect(body.tools.map((t: any) => t.name)).toEqual(
      ['exec_command', 'capture_read_document', 'capture_list_documents']
    );
    // Flattened, not left wrapped: no upstream on this gateway accepts `namespace`.
    expect(body.tools.every((t: any) => t.type === 'function')).toBe(true);
  });

  it('reports the name -> namespace map the response side needs to re-nest calls', () => {
    const body: any = { tools: [], input: [discoveredOutput()] };
    const r = hoistDiscoveredTools(body);
    expect(r.map.capture_read_document).toBe('mcp__capturedocs');
    expect(r.map.capture_list_documents).toBe('mcp__capturedocs');
  });

  it('carries description, parameters and strict, but not defer_loading', () => {
    const body: any = { tools: [], input: [discoveredOutput()] };
    hoistDiscoveredTools(body);
    const t = body.tools.find((x: any) => x.name === 'capture_list_documents');
    expect(t.description).toBe('List documents.');
    expect(t.parameters).toEqual({ type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'] });
    expect(t.strict).toBe(false);
    expect(t.defer_loading).toBeUndefined();   // a client-side loading policy; upstream reads nothing here
  });

  it('does not add a name the request already declares, and leaves it out of the map', () => {
    const body: any = {
      tools: [{ type: 'function', name: 'capture_list_documents' }],
      input: [discoveredOutput()],
    };
    const r = hoistDiscoveredTools(body);
    expect(r.hoisted).toEqual(['capture_read_document']);
    expect(body.tools.filter((t: any) => t.name === 'capture_list_documents')).toHaveLength(1);
    expect(r.map.capture_list_documents).toBeUndefined();
  });

  it('uses a prototype-less map, so a tool named __proto__ cannot poison it', () => {
    const body: any = { tools: [], input: [{
      type: 'tool_search_output', call_id: 'c',
      tools: [{ type: 'namespace', name: 'ns', tools: [{ type: 'function', name: '__proto__' }] }],
    }] };
    const r = hoistDiscoveredTools(body);
    expect(Object.getPrototypeOf(r.map)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(r.map, '__proto__')).toBe(true);
    expect(({} as any).ns).toBeUndefined();
  });

  it('is idempotent once the upstream bug is fixed and codex sends its own tools', () => {
    // The scenario this workaround has to survive being outlived by: codex stops gating
    // deferred-tool exposure on the provider host and starts sending discovered tools itself,
    // exactly as it already does against api.openai.com. Nothing may be duplicated.
    const body: any = {
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'function', name: 'capture_read_document' },
        { type: 'function', name: 'capture_list_documents' },
      ],
      input: [discoveredOutput()],
    };
    const r = hoistDiscoveredTools(body);

    expect(r.hoisted).toEqual([]);
    expect(body.tools.map((t: any) => t.name)).toEqual(
      ['exec_command', 'capture_read_document', 'capture_list_documents']
    );
    // No map entries either: those calls are codex's own declarations and the namespace plugin
    // owns their routing, so stamping a namespace here would be interfering with it.
    expect(Object.keys(r.map)).toEqual([]);
  });

  it('is a no-op when there is no tool_search_output', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }], input: [{ type: 'message' }] };
    expect(hoistDiscoveredTools(body).hoisted).toEqual([]);
    expect(body.tools).toHaveLength(1);
  });

  it('tolerates an empty discovered list — an API-key session really returns one', () => {
    const body: any = { tools: [], input: [{ type: 'tool_search_output', call_id: 'c', tools: [] }] };
    expect(hoistDiscoveredTools(body).hoisted).toEqual([]);
  });

  it('MUST run before the conversion, which drops the tools array', () => {
    // Pins the ordering the plugin depends on: converting first loses everything.
    const body: any = { tools: [], input: [discoveredOutput()] };
    translateToolSearchOutputItems(body);
    expect(hoistDiscoveredTools(body).hoisted).toEqual([]);   // too late — nothing left to hoist
  });
});

describe('the hoist switch', () => {
  it('is on unless the config says exactly false', () => {
    // Mirrors the supports_prompt_caching precedent: a wrong `true` costs nothing here (names
    // already declared are skipped), a wrong `false` silently makes discovered tools uncallable.
    expect(resolveHoistDiscoveredTools(undefined)).toBe(true);
    expect(resolveHoistDiscoveredTools(null)).toBe(true);
    expect(resolveHoistDiscoveredTools('false')).toBe(true);   // a string is not the boolean
    expect(resolveHoistDiscoveredTools(true)).toBe(true);
    expect(resolveHoistDiscoveredTools(false)).toBe(false);
    expect(DEFAULT_HOIST_DISCOVERED_TOOLS).toBe(true);
  });

  it('ships enabled in api_config.json', () => {
    const shipped = require('../api_config.json');
    expect(shipped.api_config.tool_search.hoist_discovered_tools).toBe(true);
  });
});
