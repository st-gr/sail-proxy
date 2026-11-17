import { summarize, Summary } from './stats';

export const REQUESTS = 2000;
export const CONCURRENCY = 20;
export const RUNS = 5;
export const WARMUP = 5000; // requests before the first measured run (JIT, connection pool), not reported
export const UPSTREAM_DELAY_MS = 5;

export const variantLabel = (): string => process.env.BENCH_VARIANT || 'baseline';

/** Runs `total` calls of `one` with `concurrency` in flight; returns each call's duration in ms. */
export async function drive(one: () => Promise<void>, total: number, concurrency: number): Promise<number[]> {
  const samples: number[] = [];
  let started = 0;
  const worker = async (): Promise<void> => {
    while (started < total) {
      started++;
      const t0 = process.hrtime.bigint();
      await one();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

/** One warm-up pass (not reported), then RUNS measured runs, one JSON line each on stdout. */
export async function measure(mode: string, one: () => Promise<void>): Promise<Summary[]> {
  await drive(one, WARMUP, CONCURRENCY);
  const runs: Summary[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const s = summarize(await drive(one, REQUESTS, CONCURRENCY));
    runs.push(s);
    const r = (n: number) => Math.round(n * 1000) / 1000;
    console.log(JSON.stringify({ mode, variant: variantLabel(), run, p50: r(s.p50), p95: r(s.p95), mean: r(s.mean), requests: REQUESTS }));
  }
  return runs;
}
