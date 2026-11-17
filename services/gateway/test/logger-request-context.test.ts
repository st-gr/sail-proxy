/**
 * A log line carries the id of the request it belongs to, also when requests overlap: the id
 * comes from the context that runs the line, not from the request that arrived last.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AddressInfo } from 'net';
import express from 'express';
import { createLogger, getDefaultLogger } from '@libs/logger';
import { accessLogMiddleware } from '../src/utils/accessLog';
import { requestContextMiddleware } from '../src/app';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('request context of a log line', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    const grab = (l: unknown) => { lines.push(String(l)); };
    jest.spyOn(console, 'info').mockImplementation(grab);
    jest.spyOn(console, 'error').mockImplementation(grab);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('runWithRequestContext', () => {
    it('gives each of two overlapping requests its own id', async () => {
      const logger = createLogger({ enableColors: false, enableFileLogging: false });
      const request = (id: string, wait: number) => logger.runWithRequestContext({ requestId: id } as any, async () => {
        await sleep(wait);
        logger.info('test', `line of ${id}`);
      });
      await Promise.all([request('a', 30), request('b', 5)]);
      expect(lines.find((l) => l.includes('line of a'))).toContain('[a]');
      expect(lines.find((l) => l.includes('line of b'))).toContain('[b]');
    });

    it('returns what the function returns', () => {
      const logger = createLogger({ enableColors: false, enableFileLogging: false });
      expect(logger.runWithRequestContext({ requestId: 'a' } as any, () => 42)).toBe(42);
    });

    it('falls back to the context setRequestContext set when no context is running', () => {
      const logger = createLogger({ enableColors: false, enableFileLogging: false });
      logger.setRequestContext({ requestId: 'fallback' } as any);
      logger.info('test', 'outside');
      logger.runWithRequestContext({ requestId: 'inner' } as any, () => logger.info('test', 'inside'));
      logger.clearRequestContext();
      expect(lines[0]).toContain('[fallback]');
      expect(lines[1]).toContain('[inner]');
    });
  });

  describe('the gateway middleware', () => {
    it('gives the access line and the handler lines of overlapping requests their own ids', async () => {
      const logger = getDefaultLogger();
      const app = express();
      app.use(requestContextMiddleware);
      app.use(accessLogMiddleware((message) => logger.info('HTTP', message)));
      app.get('/slow/:name', async (req, res) => {
        await sleep(req.params.name === 'first' ? 60 : 5);
        logger.info('handler', `handler line of ${req.params.name}`);
        res.json({ id: (req as any).debugRequestId });
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const [first, second] = await Promise.all(['first', 'second'].map(async (name) => {
          const res = await fetch(`${base}/slow/${name}`);
          return ((await res.json()) as { id: string }).id;
        }));
        await sleep(50);
        expect(first).not.toBe(second);
        for (const [name, id] of [['first', first], ['second', second]]) {
          expect(lines.find((l) => l.includes(`handler line of ${name}`))).toContain(`[${id}]`);
          expect(lines.find((l) => l.includes(`GET /slow/${name} `))).toContain(`[${id}]`);
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
