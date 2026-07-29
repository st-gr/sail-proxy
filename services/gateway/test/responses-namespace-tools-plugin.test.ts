import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockMode = jest.fn<() => string>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getNamespaceToolMode: () => mockMode() },
  getNamespaceToolMode: () => mockMode(),
}));

import pluginRules = require('../src/plugins/responsesNamespaceToolsPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} }, strict: false });
const NS = { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent'), fn('close_agent')] };

describe('responsesNamespaceToolsPlugin — before', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  it('flattens the namespace and stashes the map on the request', async () => {
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    const r = await before({ req, res: {} as any, utils });

    expect(r).toEqual({ stop: false });
    expect(req.body.tools.some((t: any) => t.type === 'namespace')).toBe(false);
    expect(req.body.tools.map((t: any) => t.name)).toEqual(['exec_command', 'spawn_agent', 'close_agent']);
    expect(req.__namespaceToolMap).toEqual({ spawn_agent: 'multi_agent_v1', close_agent: 'multi_agent_v1' });
  });

  it('leaves a request with no namespace tool untouched and stashes no map', async () => {
    const req: any = { body: { tools: [fn('exec_command')] } };
    const snapshot = JSON.parse(JSON.stringify(req.body));

    await before({ req, res: {} as any, utils });

    expect(req.body).toEqual(snapshot);
    expect(req.__namespaceToolMap).toBeUndefined();
  });

  it('strip mode removes the tools and stashes no usable map', async () => {
    mockMode.mockReturnValue('strip');
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    await before({ req, res: {} as any, utils });

    expect(req.body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(req.__namespaceToolMap).toEqual({});
  });

  // The wording is operator-facing: "Flattened ... hoisted []" is what strip mode used to
  // log, which is accurate and reads as a bug to anyone grepping mid-incident for why the
  // client can see no sub-agent tools at all.
  it('logs strip mode as dropping rather than as flattening', async () => {
    mockMode.mockReturnValue('strip');
    (utils.logger.info as any).mockClear();
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    await before({ req, res: {} as any, utils });

    const line = String((utils.logger.info as any).mock.calls[0][0]);
    expect(line).toContain('Dropped Codex namespace tool(s) [mode=strip]');
    expect(line).toContain('spawn_agent');
    expect(line).not.toContain('Flattened');
    expect(line).not.toContain('hoisted');
  });

  it('logs flatten mode as flattening, listing what was hoisted', async () => {
    (utils.logger.info as any).mockClear();
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    await before({ req, res: {} as any, utils });

    const line = String((utils.logger.info as any).mock.calls[0][0]);
    expect(line).toContain('Flattened Codex namespace tool(s) [mode=flatten]');
    expect(line).toContain('hoisted [spawn_agent, close_agent]');
  });

  it('never throws on a malformed body', async () => {
    for (const body of [undefined, null, {}, { tools: 'nope' }] as any[]) {
      await expect(before({ req: { body } as any, res: {} as any, utils })).resolves.toEqual({ stop: false });
    }
  });
});

describe('responsesNamespaceToolsPlugin — after', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  it('restores the namespace Codex needs to route the call', async () => {
    const req: any = { __namespaceToolMap: { spawn_agent: 'multi_agent_v1' } };
    const upstreamResponse = { output: [
      { type: 'reasoning', id: 'r1' },
      { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{}' },
    ] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out.output[1].namespace).toBe('multi_agent_v1');
    expect(out.output[0]).toEqual({ type: 'reasoning', id: 'r1' });
  });

  it('leaves calls to non-namespaced tools alone', async () => {
    const req: any = { __namespaceToolMap: { spawn_agent: 'multi_agent_v1' } };
    const upstreamResponse = { output: [{ type: 'function_call', name: 'exec_command', call_id: 'c1' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect('namespace' in out.output[0]).toBe(false);
  });

  it('passes the response through untouched when no map was stashed', async () => {
    const upstreamResponse = { output: [{ type: 'function_call', name: 'spawn_agent', call_id: 'c1' }] };

    const out = await after({ req: {} as any, upstreamResponse, utils });

    expect(out).toBe(upstreamResponse);
  });

  it('never throws on a malformed response', async () => {
    const req: any = { __namespaceToolMap: { a: 'b' } };
    for (const r of [undefined, null, {}, { output: 'nope' }] as any[]) {
      await expect(after({ req, upstreamResponse: r, utils })).resolves.toBe(r);
    }
  });
});
