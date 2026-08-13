/**
 * Plugin-level coverage for the `tool_search` translation, which shares
 * responsesCustomToolsPlugin's handlers and streaming interceptor.
 *
 * Shapes are verbatim from test/fixtures/codex-custom-tools/tool-search-capture.md
 * (real codex 0.147.0 against api.openai.com).
 */
import configService from '../src/services/configService';

const rules = require('../src/plugins/responsesCustomToolsPlugin');
const before = rules.find((r: any) => r.strategy === 'before').handler;
const after = rules.find((r: any) => r.strategy === 'after').handler;

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

function makeStream() {
  const written: string[] = [];
  const res: any = { write: (c: any) => { written.push(String(c)); return true; }, end: (...a: any[]) => a };
  return { res, written };
}
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
const parseAll = (written: string[]) => written.join('')
  .split('\n\n').filter((b) => b.startsWith('data: '))
  .map((b) => JSON.parse(b.slice(6)));

const toolSearchDecl = () => ({
  type: 'tool_search',
  execution: 'client',
  description: '# Tool discovery\n\nSearches over deferred tool metadata with BM25.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number' }, query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
});

const ctx = (body: any, res?: any) => ({
  req: { body } as any,
  res: res ?? ({ write: jest.fn(), end: jest.fn() } as any),
  utils: { logger },
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('translate');
  jest.spyOn(configService, 'getToolSearchMode').mockReturnValue('translate');
  jest.spyOn(configService, 'getToolSearchHoistDiscoveredTools').mockReturnValue(true);
});

describe('responsesCustomToolsPlugin — tool_search', () => {
  it('translates the declaration and flags the request', async () => {
    const c = ctx({ tools: [{ type: 'function', name: 'exec_command' }, toolSearchDecl()] });
    await before(c);
    expect(c.req.body.tools[1]).toMatchObject({ type: 'function', name: 'tool_search' });
    expect(c.req.body.tools[1].execution).toBeUndefined();
    expect((c.req as any).__toolSearchTranslated).toBe(true);
  });

  it('converts a replayed tool_search_output even when no tool is declared this turn', async () => {
    // Orchestration 400s on the item type whether or not the tool is still offered.
    const c = ctx({
      input: [{
        type: 'tool_search_output',
        id: 'tso_019ff30e-f030-70a2-b22f-544e804b5699',
        call_id: 'call_1jyP3Ac7IS5Hnl92l4Kxgc2N',
        status: 'completed', execution: 'client',
        tools: [{ type: 'namespace', name: 'mcp__capturedocs', tools: [{ type: 'function', name: 'capture_read_document' }] }],
      }],
    });
    await before(c);
    expect(c.req.body.input[0].type).toBe('function_call_output');
    expect(c.req.body.input[0].id).toBeUndefined();          // tso_ prefix would be rejected
    expect(c.req.body.input[0].call_id).toBe('call_1jyP3Ac7IS5Hnl92l4Kxgc2N');
  });

  it('strip mode removes the tool and installs nothing', async () => {
    jest.spyOn(configService, 'getToolSearchMode').mockReturnValue('strip');
    const c = ctx({ stream: true, tools: [toolSearchDecl()] });
    await before(c);
    expect(c.req.body.tools).toBeUndefined();
    expect((c.req as any).__toolSearchTranslated).toBeUndefined();
  });

  // The wording is operator-facing, matching Task 1's custom-tool assertion: reading
  // "Translated" while tool_search is actually being dropped reads as a bug mid-incident.
  it('logs strip mode as dropping rather than translating', async () => {
    jest.spyOn(configService, 'getToolSearchMode').mockReturnValue('strip');
    logger.info.mockClear();
    const c = ctx({ tools: [toolSearchDecl()] });
    await before(c);
    const line = String(logger.info.mock.calls[0][0]);
    expect(line).toContain('Dropped the Codex tool_search tool [mode=strip]');
    expect(line).not.toContain('Translated');
  });

  // The non-obvious case, same reasoning as the custom-tool sibling: strip governs only
  // the declaration. A turn can replay tool_search_call/tool_search_output history from
  // when the tool was still declared, and orchestration 400s on those item types
  // regardless of what this turn declares — so replayed history is converted
  // unconditionally, even in strip mode.
  it('still converts replayed tool_search_call and tool_search_output history', async () => {
    jest.spyOn(configService, 'getToolSearchMode').mockReturnValue('strip');
    const c = ctx({
      tools: [toolSearchDecl()],
      input: [
        { type: 'tool_search_call', call_id: 'call_1', arguments: { query: 'docs' } },
        { type: 'tool_search_output', call_id: 'call_1', status: 'completed', tools: [] },
      ],
    });
    await before(c);
    expect(c.req.body.tools).toBeUndefined();                // declaration still stripped
    expect(c.req.body.input[0].type).toBe('function_call');
    expect(c.req.body.input[1].type).toBe('function_call_output');
  });

  it('restores the call in a non-streaming reply', async () => {
    const c = ctx({ tools: [toolSearchDecl()] });
    await before(c);
    const result = await after({
      ...c,
      upstreamResponse: {
        output: [{ type: 'function_call', call_id: 'call_x', name: 'tool_search', arguments: '{"query":"documents","limit":8}' }],
      },
    });
    expect(result.output[0].type).toBe('tool_search_call');
    expect(result.output[0].arguments).toEqual({ query: 'documents', limit: 8 });
    expect(result.output[0].execution).toBe('client');
  });

  it('is inert for a request with no tool_search at all', async () => {
    const c = ctx({ tools: [{ type: 'function', name: 'exec_command' }] });
    await before(c);
    expect((c.req as any).__toolSearchTranslated).toBeUndefined();
    const upstream = { output: [{ type: 'function_call', name: 'exec_command', arguments: '{}' }] };
    expect(await after({ ...c, upstreamResponse: upstream })).toBe(upstream);
  });

  describe('hoisting discovered tools', () => {
    const withDiscovery = () => ({
      tools: [{ type: 'function', name: 'exec_command' }, toolSearchDecl()],
      input: [{
        type: 'tool_search_output', id: 'tso_1', call_id: 'call_1', status: 'completed',
        tools: [{
          type: 'namespace', name: 'mcp__capturedocs',
          tools: [{ type: 'function', name: 'capture_list_documents', parameters: { type: 'object' } }],
        }],
      }],
    });

    it('hoists the discovered tool into the request and stashes its namespace', async () => {
      const c = ctx(withDiscovery());
      await before(c);
      expect(c.req.body.tools.map((t: any) => t.name)).toContain('capture_list_documents');
      expect((c.req as any).__toolSearchHoistedNamespaces.capture_list_documents).toBe('mcp__capturedocs');
    });

    it('re-nests a call to a hoisted tool so codex can route it', async () => {
      // Codex routes by (namespace, name); without the namespace its router refuses the call
      // as `unsupported call: capture_list_documents`.
      const c = ctx(withDiscovery());
      await before(c);
      const result = await after({
        ...c,
        upstreamResponse: {
          output: [{ type: 'function_call', call_id: 'x', name: 'capture_list_documents', arguments: '{"folder":"reports"}' }],
        },
      });
      expect(result.output[0].namespace).toBe('mcp__capturedocs');
      expect(result.output[0].type).toBe('function_call');   // stays a function call, just routed
    });

    it('does nothing at all when the switch is off, so the workaround can be retired', async () => {
      jest.spyOn(configService, 'getToolSearchHoistDiscoveredTools').mockReturnValue(false);
      const c = ctx(withDiscovery());
      await before(c);
      expect(c.req.body.tools.map((t: any) => t.name)).not.toContain('capture_list_documents');
      expect((c.req as any).__toolSearchHoistedNamespaces).toBeUndefined();
      // The tool_search translation itself is unaffected — only the hoist is switched off.
      expect((c.req as any).__toolSearchTranslated).toBe(true);
    });

    it('leaves a call to a non-hoisted tool without a namespace', async () => {
      const c = ctx(withDiscovery());
      await before(c);
      const result = await after({
        ...c,
        upstreamResponse: { output: [{ type: 'function_call', call_id: 'y', name: 'exec_command', arguments: '{}' }] },
      });
      expect(result.output[0].namespace).toBeUndefined();
    });
  });

  describe('streaming', () => {
    async function install() {
      const { res, written } = makeStream();
      await before(ctx({ stream: true, tools: [toolSearchDecl()] }, res));
      return { res, written };
    }

    it('rewrites the item and SUPPRESSES the argument deltas the real protocol never sends', async () => {
      const { res, written } = await install();

      res.write(frame({ type: 'response.output_item.added', output_index: 0,
        item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_x', name: 'tool_search', arguments: '' } }));
      res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query"' }));
      res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"docs"}' }));
      res.write(frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"query":"docs"}' }));
      res.write(frame({ type: 'response.output_item.done', output_index: 0,
        item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_x', name: 'tool_search', arguments: '{"query":"docs"}' } }));

      const events = parseAll(written);
      const types = events.map((e) => e.type);

      // Captured protocol: output_item.added then output_item.done, nothing between.
      expect(types).toEqual(['response.output_item.added', 'response.output_item.done']);
      expect(events[0].item.type).toBe('tool_search_call');
      expect(events[0].item.arguments).toEqual({});          // in_progress carries {}
      expect(events[1].item.type).toBe('tool_search_call');
      expect(events[1].item.arguments).toEqual({ query: 'docs' });
      expect(events[1].item.name).toBeUndefined();
    });

    it('rewrites the terminal frame output array', async () => {
      const { res, written } = await install();
      res.write(frame({ type: 'response.completed', response: { output: [
        { type: 'function_call', call_id: 'call_x', name: 'tool_search', arguments: '{"query":"q"}' },
      ] } }));
      const terminal = parseAll(written).find((e) => e.type === 'response.completed');
      expect(terminal.response.output[0].type).toBe('tool_search_call');
      expect(terminal.response.output[0].arguments).toEqual({ query: 'q' });
    });

    it('passes another tool\'s call through untouched, deltas included', async () => {
      const { res, written } = await install();
      const added = frame({ type: 'response.output_item.added', output_index: 3,
        item: { id: 'fc_9', type: 'function_call', call_id: 'c9', name: 'exec_command', arguments: '' } });
      const delta = frame({ type: 'response.function_call_arguments.delta', output_index: 3, delta: '{"cmd"' });
      res.write(added);
      res.write(delta);
      expect(written.join('')).toBe(added + delta);
    });
  });
});
