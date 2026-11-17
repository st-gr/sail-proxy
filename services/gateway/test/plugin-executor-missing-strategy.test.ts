/**
 * A hook chain names plugins by id, and the before and after chains both walk all of them. A plugin
 * that only has a `before` handler is not a fault in the after chain: no warning. An id no plugin
 * has at all still warns, in either chain (2026-11-17: two warnings per request for
 * stripCacheControlScope and repairToolBlocks).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const beforeOnly = { id: 'beforeOnly', strategy: 'before', handler: async () => ({ stop: false }) };
const afterOnly = { id: 'afterOnly', strategy: 'after', handler: async ({ upstreamResponse }: any) => upstreamResponse };
const registry: any[] = [beforeOnly, afterOnly];
const getRule = (id: string, strategy: string) => registry.find((r) => r.id === id && r.strategy === strategy) || null;

jest.mock('../src/services/pluginLoader', () => ({
  __esModule: true,
  default: {
    matchAll: () => true,
    getRule: (id: string, strategy: string) => getRule(id, strategy),
    getAllRulesById: (id: string) => registry.filter((r) => r.id === id),
    selectRule: (_req: any, hook: any, strategy: string) => ({ ruleId: hook.request.callback.id, rule: getRule(hook.request.callback.id, strategy) }),
  },
}));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: { getConfig: () => ({ api_config: {} }) } }));

import { getDefaultLogger } from '@libs/logger';
import { executeBeforePlugins, executeAfterPlugins } from '../src/services/pluginExecutor';

const hook = (id: string) => ({ request: { match: ['always'], callback: { id } } });
const req = (): any => ({ headers: {}, body: {}, method: 'POST' });
const res = (): any => ({});

describe('a hook chain entry without a handler for the running strategy', () => {
  let warn: any;
  beforeEach(() => { warn = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined as any); });
  afterEach(() => { warn.mockRestore(); });
  const notFound = () => warn.mock.calls.filter((c: any[]) => /not found/.test(String(c[1])));

  it('after chain: a plugin that only has a before handler is passed over without a warning', async () => {
    const out = await executeAfterPlugins(req(), res(), { ok: true }, [hook('beforeOnly'), hook('afterOnly')] as any);
    expect(out).toEqual({ ok: true });
    expect(notFound()).toEqual([]);
  });

  it('before chain: a plugin that only has an after handler is passed over without a warning', async () => {
    const result = await executeBeforePlugins(req(), res(), [hook('afterOnly'), hook('beforeOnly')] as any);
    expect(result.stop).toBe(false);
    expect(notFound()).toEqual([]);
  });

  it('an id no plugin has still warns, in both chains', async () => {
    await executeAfterPlugins(req(), res(), {}, [hook('nobody')] as any);
    await executeBeforePlugins(req(), res(), [hook('nobody')] as any);
    expect(notFound().map((c: any[]) => c[1])).toEqual([
      "Plugin rule 'nobody' with strategy 'after' not found",
      "Plugin rule 'nobody' with strategy 'before' not found",
    ]);
  });
});
