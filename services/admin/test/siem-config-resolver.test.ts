import { resolveSiemDispatch } from '../src/siem/siemConfigResolver';

// This covers the boot-time decision of whether initializeSiemDispatcher (admin-service.ts)
// starts the dispatcher at all, and with which sinks. admin-service.ts itself cannot be
// required in a Jest test — probed directly, importing it opens a real Valkey connection
// and starts an uncancelled setInterval/setTimeout as import-time side effects of sibling
// singletons (config-service.ts, notification-stream.ts), independent of this change — so
// resolveSiemDispatch was factored out specifically to make this decision testable on its
// own. What is NOT covered here: that admin-service.ts actually calls startDispatcher with
// what this function returns, and retains the handle. That wiring was verified by reading
// the code (services/admin/src/srv/admin-service.ts, initializeSiemDispatcher), not by an
// automated test.
describe('resolveSiemDispatch', () => {
  it('does not start when siem.enabled is false', () => {
    expect(resolveSiemDispatch({ enabled: false, sinks: [{ name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest' }] })).toBeNull();
  });

  it('does not start when the siem block is missing entirely', () => {
    expect(resolveSiemDispatch(undefined)).toBeNull();
  });

  it('does not start when siem.enabled is true but no sink is enabled', () => {
    expect(resolveSiemDispatch({
      enabled: true,
      sinks: [{ name: 'webhook', type: 'webhook', enabled: false, url: 'https://siem.example.invalid/ingest' }],
    })).toBeNull();
  });

  it('starts with an enabled, valid webhook sink and reads batch_size/interval_ms from config', () => {
    const result = resolveSiemDispatch({
      enabled: true,
      batch_size: 50,
      interval_ms: 5000,
      sinks: [{ name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest', token_env: 'SIEM_WEBHOOK_TOKEN' }],
    }, (n: string) => (n === 'SIEM_WEBHOOK_TOKEN' ? 'secret-value' : undefined));

    expect(result).not.toBeNull();
    expect(result!.sinks.map(s => s.name)).toEqual(['webhook']);
    expect(result!.dispatcherConfig).toEqual({ batchSize: 50, intervalMs: 5000 });
    expect(result!.warnings).toEqual([]);
  });

  it('falls back to default batch_size/interval_ms when the config omits them', () => {
    const result = resolveSiemDispatch({
      enabled: true,
      sinks: [{ name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest' }],
    });

    expect(result!.dispatcherConfig).toEqual({ batchSize: 100, intervalMs: 15000 });
  });

  it('warns but still builds the sink when its named token env var is not set', () => {
    const result = resolveSiemDispatch({
      enabled: true,
      sinks: [{ name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest', token_env: 'SIEM_WEBHOOK_TOKEN' }],
    });

    expect(result).not.toBeNull();
    expect(result!.sinks.map(s => s.name)).toEqual(['webhook']);
    expect(result!.warnings.some(w => w.includes('SIEM_WEBHOOK_TOKEN') && w.includes('no credential stored'))).toBe(true);
  });

  it('skips a sink with an unsupported type, without throwing, and warns', () => {
    const result = resolveSiemDispatch({
      enabled: true,
      sinks: [
        { name: 'made-up', type: 'made-up', enabled: true },
        { name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest' },
      ],
    });

    expect(result!.sinks.map(s => s.name)).toEqual(['webhook']);
    expect(result!.warnings.some(w => w.includes("'made-up'") && w.includes('unsupported type'))).toBe(true);
  });

  it('skips a sink that fails validateConfig (e.g. a missing url), without throwing, and warns', () => {
    const result = resolveSiemDispatch({
      enabled: true,
      sinks: [
        { name: 'broken', type: 'webhook', enabled: true },
        { name: 'webhook', type: 'webhook', enabled: true, url: 'https://siem.example.invalid/ingest' },
      ],
    });

    expect(result!.sinks.map(s => s.name)).toEqual(['webhook']);
    expect(result!.warnings.some(w => w.includes("'broken'") && w.includes('config problems'))).toBe(true);
  });

  it('does not start when every configured sink is unsupported or invalid', () => {
    expect(resolveSiemDispatch({
      enabled: true,
      sinks: [{ name: 'otel', type: 'otel', enabled: true }],
    })).toBeNull();
  });
});
