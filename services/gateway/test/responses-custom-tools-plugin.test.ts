import configService from '../src/services/configService';

const rules = require('../src/plugins/responsesCustomToolsPlugin');
const before = rules.find((r: any) => r.strategy === 'before').handler;
const after = rules.find((r: any) => r.strategy === 'after').handler;

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const ctx = (body: any, upstreamResponse?: any) => ({
  req: { body } as any,
  res: { write: jest.fn(), end: jest.fn() } as any,
  utils: { logger },
  upstreamResponse,
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('translate');
});

describe('responsesCustomToolsPlugin', () => {
  it('translates the declaration and records the names on the request', async () => {
    const c = ctx({ tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] });
    await before(c);
    expect(c.req.body.tools[0].type).toBe('function');
    expect([...(c.req as any).__customToolNames]).toEqual(['apply_patch']);
  });

  it('translates replayed history even when the request declares no tools', async () => {
    // A turn can replay custom_tool_call items while offering no tools at all;
    // orchestration 400s on the item type regardless of the tools array.
    const c = ctx({ input: [{ type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: 'p' }] });
    await before(c);
    expect(c.req.body.input[0].type).toBe('function_call');
  });

  it('restores the call in a non-streaming reply', async () => {
    const c = ctx({ tools: [{ type: 'custom', name: 'apply_patch' }] });
    await before(c);
    const result = await after({
      ...c,
      upstreamResponse: { output: [{ type: 'function_call', call_id: 'x', name: 'apply_patch', arguments: '{"input":"P"}' }] },
    });
    expect(result.output[0].type).toBe('custom_tool_call');
    expect(result.output[0].input).toBe('P');
  });

  it('is inert for a request with neither custom tools nor custom history', async () => {
    const c = ctx({ tools: [{ type: 'function', name: 'exec_command' }] });
    await before(c);
    expect((c.req as any).__customToolNames).toBeUndefined();
    const upstream = { output: [{ type: 'function_call', name: 'exec_command', arguments: '{}' }] };
    expect(await after({ ...c, upstreamResponse: upstream })).toBe(upstream);
  });

  it('never throws out of the before handler', async () => {
    jest.spyOn(configService, 'getCustomToolMode').mockImplementation(() => { throw new Error('boom'); });
    await expect(before(ctx({ tools: [] }))).resolves.toEqual({ stop: false });
    expect(logger.error).toHaveBeenCalled();
  });

  describe('strip mode', () => {
    it('removes the custom declaration, leaving other tools by name', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      const c = ctx({ tools: [{ type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch', description: 'd' }] });
      await before(c);
      expect(c.req.body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    });

    it('deletes an emptied tools array rather than leaving []', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      const c = ctx({ tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] });
      await before(c);
      expect(c.req.body.tools).toBeUndefined();
      expect('tools' in c.req.body).toBe(false);
    });

    it('never stashes __customToolNames on the request', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      const c = ctx({ tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] });
      await before(c);
      expect((c.req as any).__customToolNames).toBeUndefined();
    });

    // The wording is operator-facing: reading "Translated" while apply_patch is actually
    // being dropped is exactly what made the equivalent namespace-plugin wording read as
    // a bug mid-incident (see responsesNamespaceToolsPlugin.test.ts).
    it('logs strip mode as dropping rather than translating', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      logger.info.mockClear();
      const c = ctx({ tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] });
      await before(c);
      const line = String(logger.info.mock.calls[0][0]);
      expect(line).toContain('Dropped Codex custom tool(s) [mode=strip]');
      expect(line).toContain('apply_patch');
      expect(line).not.toContain('Translated');
    });

    // The non-obvious case: strip governs only the declaration. A turn can replay
    // custom_tool_call history from when the tool was still declared, and orchestration
    // 400s on that item type regardless of what this turn declares — so replayed history
    // is converted unconditionally, even in strip mode.
    it('still converts replayed custom_tool_call history', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      const c = ctx({
        tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }],
        input: [{ type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: 'p' }],
      });
      await before(c);
      expect(c.req.body.tools).toBeUndefined();              // declaration still stripped
      expect(c.req.body.input[0].type).toBe('function_call');
    });
  });
});
