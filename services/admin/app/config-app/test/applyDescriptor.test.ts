import { applyDescriptor, removeAt } from '../webapp/model/schemaForm';

const minimal = () => ({ api_config: { platform: { timeouts: { default: 30000, streaming: 60000 }, logging: { defaultLevel: 'DEBUG' } } } });

describe('applyDescriptor is anchored at the root', () => {
  it.each([
    ['/api_config/platform/rate_limit_handling/enabled', true, (d: any) => d.api_config.platform.rate_limit_handling.enabled],
    ['/api_config/platform/security/trust_forwarded_for', true, (d: any) => d.api_config.platform.security.trust_forwarded_for],
    ['/api_config/capabilities/web_search/max_searches', 3, (d: any) => d.api_config.capabilities.web_search.max_searches],
    ['/api_config/platform/logging/components/Gateway', 'DEBUG', (d: any) => d.api_config.platform.logging.components.Gateway],
  ])('creates the missing objects along %s instead of writing at the root', (pointer, value, read) => {
    const out = applyDescriptor(minimal(), pointer, value) as any;
    expect(read(out)).toEqual(value);
    expect(Object.keys(out)).toEqual(['api_config']);            // nothing beside api_config
  });
  it('does not mutate its input', () => {
    const doc = minimal(); const before = JSON.stringify(doc);
    applyDescriptor(doc, '/api_config/platform/security/trust_forwarded_for', true);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('throws on an index into a missing array rather than inventing one', () => {
    expect(() => applyDescriptor(minimal(), '/api_config/observability/siem/sinks/0/name', 'x')).toThrow(/array/);
  });
  it('still writes an existing array element', () => {
    const doc = { api_config: { observability: { siem: { sinks: [{ name: 'a' }] } } } };
    expect((applyDescriptor(doc, '/api_config/observability/siem/sinks/0/name', 'b') as any).api_config.observability.siem.sinks[0].name).toBe('b');
  });
});

describe('removeAt', () => {
  it('deletes exactly one key', () => {
    const doc = { api_config: { providers: { a: {}, b: {} } } };
    expect(removeAt(doc, '/api_config/providers/a')).toEqual({ api_config: { providers: { b: {} } } });
    expect(doc.api_config.providers).toHaveProperty('a');        // input untouched
  });
  it('splices exactly one array element', () => {
    const doc = { api_config: { hooks: { defaults: { anthropic: { invoke: [{ request: 1 }, { request: 2 }] } } } } };
    expect((removeAt(doc, '/api_config/hooks/defaults/anthropic/invoke/0') as any).api_config.hooks.defaults.anthropic.invoke).toEqual([{ request: 2 }]);
  });
  it('throws when the parent is missing', () => {
    expect(() => removeAt(minimal(), '/api_config/providers/a')).toThrow(/cannot resolve/);
  });
});
