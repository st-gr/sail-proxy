/**
 * When the daily maintenance runs. Unset, it is what it always was: 5 minutes after startup, then
 * every 24 hours from that clock time — so a midday redeploy pins the heaviest daily job to
 * midday. With `platform.maintenance.dailyRunAtUtc` set, the startup run still happens (it is the
 * self-healing pass) and every later run starts at that UTC time of day; a configuration
 * activation re-arms the schedule without triggering a run.
 */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn(async () => ({})) } }));
jest.mock('../../../src/services/sapCapacityService', () => ({ getCacheBillingFactors: () => ({ read: 1, write: 1 }), isProductive: () => true, cuFactor: () => 1 }));
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../../../src/services/usageCounters', () => ({ rebuild: jest.fn(async () => ({ users: 0, buckets: 0, durationMs: 0 })) }));
jest.mock('../../../src/services/userQuotaService', () => ({ republishAll: jest.fn(async () => 0) }));
jest.mock('../../../src/services/quotaLimits', () => ({ maintenanceRunAtUtc: jest.fn(async () => null) }));

import { CostRecalculationService, nextOccurrenceUtc } from '../../../src/services/costRecalculationService';
import { maintenanceRunAtUtc } from '../../../src/services/quotaLimits';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STARTUP_DELAY = 5 * MINUTE;

const runAt = (value: string | null) => (maintenanceRunAtUtc as jest.Mock).mockResolvedValue(value);

describe('nextOccurrenceUtc', () => {
  it('takes today when the time of day is still ahead', () => {
    expect(nextOccurrenceUtc(new Date('2026-09-07T10:00:00Z'), '23:30').toISOString()).toBe('2026-09-07T23:30:00.000Z');
  });

  it('rolls to tomorrow when the time of day has passed', () => {
    expect(nextOccurrenceUtc(new Date('2026-09-07T23:45:00Z'), '23:30').toISOString()).toBe('2026-09-08T23:30:00.000Z');
  });

  // A run must not be armed for a moment that is about to pass: 30 s ahead is below the lead.
  it('rolls to tomorrow when the time of day is nearer than the one-minute lead', () => {
    expect(nextOccurrenceUtc(new Date('2026-09-07T23:29:30Z'), '23:30').toISOString()).toBe('2026-09-08T23:30:00.000Z');
  });

  // Today's 00:00 lies in the past, so the candidate rolls forward one day and lands exactly
  // 60 s ahead — which the `< minLeadMs` test accepts rather than rolling forward again.
  it('takes tomorrow midnight at 23:59, exactly the one-minute lead away', () => {
    expect(nextOccurrenceUtc(new Date('2026-09-07T23:59:00Z'), '00:00').toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('the daily maintenance schedule', () => {
  let service: CostRecalculationService;
  let run: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-09-07T10:00:00Z') });
    service = new CostRecalculationService();
    run = jest.spyOn(service, 'runRecalculation').mockResolvedValue({ apiKeyRecords: 0, awsRecords: 0 });
  });

  afterEach(async () => {
    await service.shutdown();
    jest.useRealTimers();
  });

  it('unset: runs 5 minutes after startup, then every 24 hours from then', async () => {
    runAt(null);
    await service.initialize();

    await jest.advanceTimersByTimeAsync(STARTUP_DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expect(service.nextRunAt()).toBeNull();

    await jest.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("set: the startup run still happens, then every day at the configured UTC time", async () => {
    runAt('08:00');
    await service.initialize();

    // 08:00 has passed by the 10:05 startup run, so the first aligned run is tomorrow's.
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expect(service.nextRunAt()?.toISOString()).toBe('2026-09-08T08:00:00.000Z');

    await jest.advanceTimersByTimeAsync(21 * HOUR + 55 * MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    expect(service.nextRunAt()?.toISOString()).toBe('2026-09-09T08:00:00.000Z');

    await jest.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('re-arms on a configuration activation without triggering a run', async () => {
    runAt('08:00');
    await service.initialize();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY);
    expect(run).toHaveBeenCalledTimes(1);

    runAt('23:30');
    await service.rearm();

    expect(run).toHaveBeenCalledTimes(1);
    expect(service.nextRunAt()?.toISOString()).toBe('2026-09-07T23:30:00.000Z');
  });

  // Each re-arm reads the setting before it touches the timers, so the second one clears what the
  // first armed instead of both arming on top of a field only one of them can hold.
  it('two activations in quick succession leave one schedule, not two', async () => {
    runAt('08:00');
    await service.initialize();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY);

    runAt('23:30');
    await Promise.all([service.rearm(), service.rearm()]);

    await jest.advanceTimersByTimeAsync(14 * HOUR);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('re-arms back to the 24-hour interval when the setting is cleared', async () => {
    runAt('08:00');
    await service.initialize();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY);

    runAt(null);
    await service.rearm();
    expect(service.nextRunAt()).toBeNull();

    // The cleared alignment timer must not fire on top of the interval.
    await jest.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
