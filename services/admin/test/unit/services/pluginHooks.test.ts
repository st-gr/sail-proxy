/** mergeSuggestedHooks (spec 2026-11-04 §7): pure, never mutates its input. */
import { mergeSuggestedHooks, HookConflictError } from '../../../src/services/pluginHooks';

const hook = (id: string) => ({ request: { callback: { id }, match: ['acme:any'] } });
const manifest = (hooks: Record<string, unknown>) => ({ id: 'acme', version: '1.0.0', runtime: 'node', gateway: '*', help: { en: { summary: 's' } }, hooks }) as any;
const HOOKS = {
  definitions: { 'acme:any': { type: 'header', name: 'x-acme', equals: '1' } },
  defaults: { anthropic: { invoke: [hook('acmeRule')] } },
};

describe('mergeSuggestedHooks', () => {
  it('appends the definitions and the default hooks', () => {
    const base = { hooks: { defaults: { anthropic: { invoke: [hook('other')] } } }, platform: { a: 1 } };
    const { apiConfig, warnings } = mergeSuggestedHooks(base, manifest(HOOKS));
    expect((apiConfig as any).hooks.defaults.anthropic.invoke).toEqual([hook('other'), hook('acmeRule')]);
    expect((apiConfig as any).hooks.definitions['acme:any']).toEqual(HOOKS.definitions['acme:any']);
    expect((apiConfig as any).platform).toEqual({ a: 1 });
    expect(warnings).toEqual([]);
  });

  it('works on a configuration with no hooks section', () => {
    const { apiConfig } = mergeSuggestedHooks({}, manifest(HOOKS));
    expect((apiConfig as any).hooks.defaults.anthropic.invoke).toEqual([hook('acmeRule')]);
  });

  it('a second run adds nothing', () => {
    const once = mergeSuggestedHooks({}, manifest(HOOKS)).apiConfig;
    const twice = mergeSuggestedHooks(once, manifest(HOOKS)).apiConfig;
    expect(twice).toEqual(once);
  });

  it('a different definition under the same id throws and changes nothing', () => {
    const base = { hooks: { definitions: { 'acme:any': { type: 'header', name: 'x-other', equals: '2' } } } };
    const before = JSON.parse(JSON.stringify(base));
    expect(() => mergeSuggestedHooks(base, manifest(HOOKS))).toThrow(HookConflictError);
    expect(base).toEqual(before);
  });

  it('warns, naming the model, when a model has its own list for a subpath the plugin adds to', () => {
    const base = { models: { overrides: { 'model-a': { hooks: { invoke: [hook('x')] } }, 'model-b': { hooks: { converse: [hook('y')] } } } } };
    const { warnings } = mergeSuggestedHooks(base, manifest(HOOKS));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('model-a');
    expect(warnings[0]).not.toContain('model-b');
  });

  it('does not mutate its input', () => {
    const base = { hooks: { defaults: { anthropic: { invoke: [hook('other')] } } } };
    const before = JSON.parse(JSON.stringify(base));
    mergeSuggestedHooks(base, manifest(HOOKS));
    expect(base).toEqual(before);
  });

  it('a manifest without hooks changes nothing', () => {
    const base = { platform: {} };
    expect(mergeSuggestedHooks(base, { ...manifest({}), hooks: undefined }).apiConfig).toEqual(base);
  });
});
