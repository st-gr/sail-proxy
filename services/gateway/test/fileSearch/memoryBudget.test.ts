// The process-wide memory reservation for files being embedded (memoryBudget.ts): a budget from the
// container's limit, waiting (FIFO) while it is full, a set larger than the whole budget proceeding
// alone, and every reservation released exactly once.
import {
  FileSearchMemoryBusyError, memoryBudgetBytes, reserveMemory, textReserveBytes, vectorReserveBytes, waitUntil,
  __memoryBudgetForTests,
} from '../../src/fileSearch/memoryBudget';
import { FileSearchBusyError } from '../../src/fileSearch/dbBusy';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const tick = () => new Promise((r) => setImmediate(r));

describe('the memory budget', () => {
  afterEach(() => __memoryBudgetForTests.reset(null));

  it('a quarter of the process\'s memory limit, between 256 MiB and 1 GiB; 512 MiB when none is known', () => {
    expect(memoryBudgetBytes(2 * GiB)).toBe(512 * MiB);
    expect(memoryBudgetBytes(512 * MiB)).toBe(256 * MiB);
    expect(memoryBudgetBytes(16 * GiB)).toBe(1 * GiB);
    expect(memoryBudgetBytes(0)).toBe(512 * MiB);
    expect(memoryBudgetBytes(2 ** 64)).toBe(512 * MiB);
  });

  it('a file reserves three times its text (UTF-16) after extraction, then its float32 vectors after chunking', () => {
    expect(textReserveBytes(64 * MiB)).toBe(384 * MiB);
    expect(vectorReserveBytes(21_845, 1536)).toBe(21_845 * 1536 * 4);
    expect(textReserveBytes(0) + vectorReserveBytes(0, 1536)).toBe(0);
  });

  it('a wait ends at its time bound as a busy error (handed back), leaving the queue', async () => {
    __memoryBudgetForTests.reset(100);
    const held = await reserveMemory(100);
    const started = Date.now();
    const err = await reserveMemory(10, { until: Date.now() + 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(FileSearchMemoryBusyError);
    expect(err).toBeInstanceOf(FileSearchBusyError);
    expect(err.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(__memoryBudgetForTests.state()).toMatchObject({ waiting: 0, used: 100 });
    held.release();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now); // no wall-clock drift between the asserts
    try {
      expect(waitUntil(now + 10_000)).toBe(now + 5_000);
      expect(waitUntil(now - 1)).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });

  it('waits while the budget is full and grants in arrival order as reservations are released', async () => {
    __memoryBudgetForTests.reset(100);
    const a = await reserveMemory(60);
    const order: string[] = [];
    const b = reserveMemory(50).then((r) => { order.push('b'); return r; });
    const c = reserveMemory(10).then((r) => { order.push('c'); return r; }); // fits, but waits behind b (FIFO)
    await tick();
    expect(order).toEqual([]);
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 60, waiting: 2 });
    a.release();
    a.release(); // a second release is a no-op
    const [rb, rc] = await Promise.all([b, c]);
    expect(order).toEqual(['b', 'c']);
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 60, waiting: 0 });
    rb.release();
    rc.release();
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0 });
  });

  it('a reservation larger than the whole budget proceeds alone, never deadlocks', async () => {
    __memoryBudgetForTests.reset(100);
    const big = await reserveMemory(500); // nothing else held: granted at once
    let small = false;
    const s = reserveMemory(1).then((r) => { small = true; return r; });
    await tick();
    expect(small).toBe(false);
    big.release();
    (await s).release();
    expect(small).toBe(true);

    const held = await reserveMemory(10);
    let bigToo = false;
    const b2 = reserveMemory(500).then((r) => { bigToo = true; return r; });
    await tick();
    expect(bigToo).toBe(false); // waits for the holder
    held.release();
    (await b2).release();
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0, waiting: 0 });
  });

  it('grow adds to a held reservation without waiting; release returns all of it', async () => {
    __memoryBudgetForTests.reset(100);
    const r = await reserveMemory(40);
    r.grow(90);
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 130 });
    r.release();
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0 });
  });

  it('a waiter whose stop signal aborts leaves the queue at once as a busy error', async () => {
    __memoryBudgetForTests.reset(100);
    const held = await reserveMemory(100);
    const controller = new AbortController();
    const w = reserveMemory(10, { signal: controller.signal }).catch((e) => e);
    await tick();
    controller.abort();
    const err = await w;
    expect(err).toBeInstanceOf(FileSearchMemoryBusyError);
    expect(err.reason).toBe('stopping');
    expect(__memoryBudgetForTests.state()).toMatchObject({ waiting: 0, used: 100 });
    held.release();
  });
});
