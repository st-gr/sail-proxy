// Module scope: a plain script would share top-level names with other test files under ts-jest.
export {};

/**
 * cuFactor() reads the configurable SAP GenAI-token -> Capacity-Unit factor from
 * platform.billing.cuFactor in api_config.json, falling back to the SAP_CU_FACTOR default.
 * The config file is mocked per-case (with module isolation) so both the configured and the
 * fallback paths are exercised deterministically.
 */
const REAL_FS = jest.requireActual('fs');

function loadService(billing: any) {
  jest.resetModules();
  jest.doMock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: {} }));
  jest.doMock('fs', () => ({
    ...REAL_FS,
    readFileSync: (p: string, enc?: any) =>
      String(p).endsWith('api_config.json')
        ? JSON.stringify({ api_config: { platform: { billing } } })
        : REAL_FS.readFileSync(p, enc),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/services/sapCapacityService');
}

describe('cuFactor (platform.billing.cuFactor)', () => {
  afterEach(() => {
    jest.dontMock('fs');
    jest.dontMock('@sap/cds');
    jest.resetModules();
  });

  it('uses the configured factor when set to a positive number', () => {
    const svc = loadService({ cuFactor: 2.5 });
    expect(svc.cuFactor()).toBe(2.5);
  });

  it('falls back to SAP_CU_FACTOR (1.90385) when cuFactor is unset', () => {
    const svc = loadService({ productive: true });
    expect(svc.cuFactor()).toBe(svc.SAP_CU_FACTOR);
    expect(svc.cuFactor()).toBe(1.90385);
  });

  it('falls back to the default when the value is non-positive or non-numeric', () => {
    expect(loadService({ cuFactor: 0 }).cuFactor()).toBe(1.90385);
    expect(loadService({ cuFactor: -1 }).cuFactor()).toBe(1.90385);
    expect(loadService({ cuFactor: 'x' }).cuFactor()).toBe(1.90385);
  });
});
