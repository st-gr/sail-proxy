// describeLive gates every live-server suite behind ADMIN_SERVICE_URL, so a
// bare `jest` run never fires HTTP requests at a developer's running admin
// instance and never leaves rows (e.g. "Test Configuration After Fix",
// "...Test Key") in that developer's admin.db.
//
// describeLive is assigned once, at module load, from whichever of
// `describe` / `describe.skip` is current at that moment - so each scenario
// below resets the module registry and re-requires the module after setting
// the env var. A static top-level import would only ever observe the first
// value.

describe('describeLive', () => {
  const ORIGINAL_ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (ORIGINAL_ADMIN_SERVICE_URL === undefined) {
      delete process.env.ADMIN_SERVICE_URL;
    } else {
      process.env.ADMIN_SERVICE_URL = ORIGINAL_ADMIN_SERVICE_URL;
    }
  });

  it('is describe.skip when ADMIN_SERVICE_URL is unset', () => {
    delete process.env.ADMIN_SERVICE_URL;
    jest.resetModules();

    const describeSpy = jest.spyOn(global as any, 'describe').mockImplementation(() => undefined as any);
    (describeSpy as any).skip = jest.fn();

    const { describeLive } = require('../src/test-config');

    expect(describeLive).toBe((describeSpy as any).skip);
    expect(describeLive).not.toBe(describeSpy);
  });

  it('is describe when ADMIN_SERVICE_URL is set', () => {
    process.env.ADMIN_SERVICE_URL = 'http://localhost:4004';
    jest.resetModules();

    const describeSpy = jest.spyOn(global as any, 'describe').mockImplementation(() => undefined as any);
    (describeSpy as any).skip = jest.fn();

    const { describeLive } = require('../src/test-config');

    expect(describeLive).toBe(describeSpy);
    expect(describeLive).not.toBe((describeSpy as any).skip);
  });
});
