/**
 * The response cache registers a request it has no answer for as "pending", so that an identical
 * request arriving meanwhile waits for that answer instead of calling the upstream a second time.
 * The entry was only released when the request succeeded. After a request the upstream rejected,
 * a client's unchanged retry waited 30 seconds for an answer that never came (measured
 * 2026-11-10 with Claude Code retrying a 400).
 */
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import pluginRules = require('../src/plugins/awsBedrockResponseCache/index');

const rules = pluginRules as any[];
const beforeHandler = rules.find((r) => r.strategy === 'before').handler;
const afterHandler = rules.find((r) => r.strategy === 'after').handler;

const utils = {
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() },
};

function makeReq(text: string) {
  return {
    method: 'POST',
    originalUrl: '/anthropic/v1/model/claude-test/invoke',
    url: '/anthropic/v1/model/claude-test/invoke',
    headers: {},
    body: { anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: text }] },
  } as any;
}

function makeRes() {
  const res: any = new EventEmitter();
  res.writable = true;
  res.writableEnded = false;
  res.headersSent = false;
  res.setHeader = () => {};
  res.status = () => res;
  res.json = () => res;
  res.write = () => true;
  res.end = () => { res.writableEnded = true; };
  return res;
}

/** 'waited' when the handler has not answered within 300 ms: it is waiting for a pending request. */
const outcome = (work: Promise<any>) => Promise.race([
  work.then((result) => result),
  new Promise((resolve) => setTimeout(() => resolve('waited'), 300)),
]);

describe('response cache: a pending request is released when its response ends without an answer', () => {
  it('a retry of a request that failed goes on at once', async () => {
    const first = makeRes();
    expect(await beforeHandler({ req: makeReq('retry after a failure'), res: first, utils })).toEqual({ stop: false });

    // The upstream rejected the call: the response ends and no after handler runs.
    first.emit('close');

    expect(await outcome(beforeHandler({ req: makeReq('retry after a failure'), res: makeRes(), utils }))).toEqual({ stop: false });
  });

  it('while the first request is still running, an identical one waits for it', async () => {
    const first = makeRes();
    await beforeHandler({ req: makeReq('still running'), res: first, utils });

    expect(await outcome(beforeHandler({ req: makeReq('still running'), res: makeRes(), utils }))).toBe('waited');
    first.emit('close');
  });

  it('the end of a request that succeeded does not release a later request with the same key', async () => {
    const firstReq = makeReq('same key twice');
    const first = makeRes();
    await beforeHandler({ req: firstReq, res: first, utils });
    // Succeeds, but with a response the cache does not keep.
    await afterHandler({ req: firstReq, res: first, upstreamResponse: null, utils });
    await afterHandler({ req: firstReq, res: first, upstreamResponse: { type: 'error' }, utils });

    const second = makeRes();
    await beforeHandler({ req: makeReq('same key twice'), res: second, utils });
    // The first response closes only now; the pending entry belongs to the second request.
    first.emit('close');

    expect(await outcome(beforeHandler({ req: makeReq('same key twice'), res: makeRes(), utils }))).toBe('waited');
    second.emit('close');
  });
});
