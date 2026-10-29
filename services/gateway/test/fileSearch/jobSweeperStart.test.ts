// The sweeper's timers: one sweep soon after start, then every 6 hours. No database involved.
const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
const connect = jest.fn().mockResolvedValue({ query, release: jest.fn() });
jest.mock('../../src/fileSearch/db', () => ({
  getPool: () => ({ query, connect }),
  isFileSearchAvailable: () => true,
}));

import { startJobSweeper, stopJobSweeper } from '../../src/fileSearch/jobSweeper';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const deleteCalls = () => query.mock.calls.filter(([sql]) => /DELETE FROM fs_jobs/.test(String(sql))).length;

describe('startJobSweeper', () => {
  beforeEach(() => { jest.useFakeTimers(); query.mockClear(); });
  afterEach(() => { stopJobSweeper(); jest.useRealTimers(); });

  it('sweeps once shortly after start, then every 6 hours', async () => {
    startJobSweeper();
    expect(deleteCalls()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(deleteCalls()).toBe(1);
    await jest.advanceTimersByTimeAsync(SIX_HOURS);
    expect(deleteCalls()).toBe(2);
  });

  it('a failing first sweep is logged and does not stop the interval', async () => {
    connect.mockRejectedValueOnce(new Error('db down'));
    startJobSweeper();
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    await jest.advanceTimersByTimeAsync(SIX_HOURS);
    expect(deleteCalls()).toBe(1);
  });

  it('stop before the first sweep cancels it', async () => {
    startJobSweeper();
    stopJobSweeper();
    await jest.advanceTimersByTimeAsync(SIX_HOURS);
    expect(deleteCalls()).toBe(0);
  });
});
