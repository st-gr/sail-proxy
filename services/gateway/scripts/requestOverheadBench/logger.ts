import express from 'express';
import { AddressInfo } from 'net';
import { measure, UPSTREAM_DELAY_MS } from './load';

const LINES_PER_REQUEST = 37; // the measured production average per request

// Logger path alone: no gateway code, only @libs/logger. File logging is off and the console
// methods the logger writes through are replaced by no-ops for the run.
export async function runLoggerMode(): Promise<void> {
  process.env.DISABLE_FILE_LOGGING = 'true';
  process.env.LOG_LEVEL = 'INFO';
  // Loaded only now, so the two variables above reach the logger when it is created.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger } = require('@libs/logger');

  // BENCH_SINK: off (default, no shipper), resolve (the real shipper, a publish that resolves at once),
  // hang (the real shipper, a publish that never resolves).
  const sinkMode = process.env.BENCH_SINK ?? 'off';
  let stopShipper: (() => void) | undefined;
  if (sinkMode !== 'off') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startLogShipper } = require('../../src/services/logShipper');
    stopShipper = startLogShipper({
      publish: sinkMode === 'hang' ? () => new Promise<void>(() => undefined) : () => Promise.resolve(),
      settings: () => ({ enabled: true, minLevel: 'INFO' }),
      warn: () => undefined,
    });
  }

  const saved = { info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const noop = (): void => undefined;
  console.info = console.debug = console.warn = console.error = noop;

  const app = express();
  let counter = 0;
  app.get('/work', async (_req, res) => {
    const requestId = `bench-${++counter}`;
    // The one call that sets the request context: the rest of the request runs inside it.
    await logger.runWithRequestContext({ requestId, timestamp: new Date().toISOString(), method: 'GET', path: '/work', service: 'bench' }, async () => {
      for (let i = 0; i < LINES_PER_REQUEST; i++) logger.info('BenchComponent', `step ${i} of the request`, { step: i, model: 'gpt-bench' });
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_DELAY_MS));
    });
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/work`;
  try {
    await measure('logger', async () => { await (await fetch(url)).text(); });
  } finally {
    stopShipper?.();
    Object.assign(console, saved);
    await new Promise((resolve) => server.close(resolve));
    logger.close();
  }
}
