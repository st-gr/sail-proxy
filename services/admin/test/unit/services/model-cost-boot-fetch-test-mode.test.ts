/**
 * modelCostService.initialize() arms a background model-data fetch (a 10 s timer without
 * Valkey, a 20 s self-heal with it) that reads GATEWAY_URL. A jest-hosted admin (cds.test)
 * must not arm it: in CI the Phase 5 gateway is live during the test phase, and its real model
 * list landed in an in-memory suite's LibraryModels once the suite outlived the timer
 * (private CI 2026-09-30, "Expected: 2, Received: 87"). Tests exercise the fetch paths directly
 * (ensureModelDataFallback, refreshPricingData); the boot timers stay off under NODE_ENV=test.
 */
import { modelCostService } from '../../../src/services/modelCostService';

describe('modelCostService.initialize() under NODE_ENV=test', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('arms no background model-data fetch while jest hosts the admin', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    await modelCostService.initialize();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('still arms the boot fetch outside test mode (the production and dev behaviour)', async () => {
    process.env.NODE_ENV = 'development';
    await modelCostService.initialize();
    expect(jest.getTimerCount()).toBe(1);
  });
});
