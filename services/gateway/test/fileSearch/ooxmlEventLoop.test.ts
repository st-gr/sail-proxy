// The OOXML reader must not stall the gateway: parts inflate in the thread pool and the XML is
// read in slices with a yield after each, so a large workbook keeps the event loop responsive.
import { readXlsx } from '../../src/fileSearch/extractors/ooxml/xlsx';
import { xlsx } from './fixtures/ooxmlFixtures';

/** Runs `work` while a 1 ms interval measures the longest gap between its ticks. */
async function longestStall(work: () => Promise<unknown>): Promise<{ stallMs: number; totalMs: number }> {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const started = Date.now();
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return { stallMs: worst, totalMs: Date.now() - started };
}

describe('a large workbook', () => {
  it('120 000 rows × 4 columns (480 000 cells) read without stalling the event loop', async () => {
    const rows = [['Id', 'Customer', 'Amount', 'Region'],
      ...Array.from({ length: 120_000 }, (_, i) => [i, `Customer ${i}`, i * 1.5, `R${i % 7}`])];
    const bytes = xlsx([{ name: 'Big', rows }]);
    let text = '';
    const { stallMs, totalMs } = await longestStall(async () => {
      text = await readXlsx(bytes, { timeoutMs: 120_000 });
    });
    expect(text.split('\n')).toHaveLength(120_000 + 5);
    // Measured locally (~3 MB file, ~20 MB of XML): longest gap 10-25 ms under plain node, 35-70 ms under
    // jest (its larger heap: GC pauses); 1-2.5 s in all.
    expect({ stallMs, totalMs }).toEqual({ stallMs: expect.any(Number), totalMs: expect.any(Number) });
    // A loaded runner stretches the 35-70 ms; the old single-pass parse stalled the loop for the whole
    // 1-2.5 s read and more, so a ceiling of 1 s still catches a parse that blocks until it is done.
    expect(stallMs).toBeLessThan(1000);
  }, 120_000);
});
