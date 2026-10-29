// The blob sweeper's timers: one sweep soon after start, then every 5 minutes. No database involved.
const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
let available = true;
jest.mock('../../src/fileSearch/db', () => ({
  getPool: () => ({ query, connect: jest.fn() }),
  isFileSearchAvailable: () => available,
}));
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } } }),
}));

import { startBlobSweeper, stopBlobSweeper, __isRunningForTests } from '../../src/fileSearch/blob/blobSweeper';

const FIVE_MINUTES = 5 * 60 * 1000;
const sweeps = () => query.mock.calls.filter(([sql]) => /FROM file_blobs\s+WHERE delete_after < now\(\)/.test(String(sql))).length;

describe('startBlobSweeper', () => {
  beforeEach(() => { jest.useFakeTimers(); query.mockClear(); available = true; });
  afterEach(() => { stopBlobSweeper(); jest.useRealTimers(); });

  it('sweeps once shortly after start, then every 5 minutes', async () => {
    startBlobSweeper();
    expect(sweeps()).toBe(0);
    await jest.advanceTimersByTimeAsync(61 * 1000);
    expect(sweeps()).toBe(1);
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(sweeps()).toBe(2);
  });

  it('a failing sweep is logged and does not stop the interval', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    startBlobSweeper();
    await jest.advanceTimersByTimeAsync(61 * 1000);
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(sweeps()).toBe(2);
    expect(__isRunningForTests()).toBe(true);
  });

  it('stop before the first sweep cancels it; not started when file_search is unavailable', async () => {
    startBlobSweeper();
    stopBlobSweeper();
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES * 2);
    expect(sweeps()).toBe(0);
    available = false;
    startBlobSweeper();
    expect(__isRunningForTests()).toBe(false);
  });
});
