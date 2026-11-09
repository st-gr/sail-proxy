import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock logger so the module's own info-log calls don't hit the real transport, and so
// test (c) can assert on the "undeterminable" log line. The mock object is created
// inside the factory (jest.mock's call is hoisted above all imports, so it cannot
// close over a module-scope const declared below it) and recovered afterwards via
// the mocked module's own export, which always returns that same instance.
jest.mock('@libs/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => logger };
});

import { getDefaultLogger } from '@libs/logger';
import { createUsageMetrics } from '../../src/utils/usageTracker';
import { foldInclusiveUsage } from '../../src/utils/usageFolding';
import { imageTokensFromDimensions } from '../../src/utils/imageDimensions';
import { captureImageTokensAsync } from '../../src/utils/imageTokenCapture';

const loggerMock = getDefaultLogger() as any;

// Same fixture bytes as image-dimensions.test.ts: PNG signature + IHDR chunk declaring
// a 2x3 image. Header-only, no pixel data -- everything sniffImageDimensions needs.
const PNG_2x3_HEX = '89504e470d0a1a0a0000000d49484452000000020000000308';
const PNG_2x3_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_2x3_HEX, 'hex').toString('base64')}`;

const fakeReq: any = { debugRequestId: 'req-1' };

/** Flush the setImmediate `captureImageTokensAsync` schedules, plus whatever microtasks
 *  its internal async work chains onto -- by the time this resolves, a same-request
 *  setImmediate callback (with no further macrotask hops of its own) has fully run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('captureImageTokensAsync', () => {
  const originalOverhead = process.env.IMAGE_TOKEN_OVERHEAD;

  beforeEach(() => {
    loggerMock.info.mockClear();
    process.env.IMAGE_TOKEN_OVERHEAD = '10';
  });

  afterEach(() => {
    if (originalOverhead === undefined) delete process.env.IMAGE_TOKEN_OVERHEAD;
    else process.env.IMAGE_TOKEN_OVERHEAD = originalOverhead;
  });

  // (b) orchestration async path computes tokens from a data-URL image and folds them.
  it('sniffs a data-URL image off the hot path and folds its token count into metrics', async () => {
    const metrics = createUsageMetrics();
    captureImageTokensAsync(fakeReq, metrics, [PNG_2x3_DATA_URL]);

    // Not yet -- the compute has only been scheduled, not run.
    expect(metrics.imageInputTokens).toBe(0);

    await flush();

    const expected = imageTokensFromDimensions(2, 3, 10);
    expect(metrics.imageInputTokens).toBe(expected);
  });

  it('sums tokens across multiple image refs', async () => {
    const metrics = createUsageMetrics();
    captureImageTokensAsync(fakeReq, metrics, [PNG_2x3_DATA_URL, PNG_2x3_DATA_URL]);
    await flush();
    expect(metrics.imageInputTokens).toBe(2 * imageTokensFromDimensions(2, 3, 10));
  });

  // (c) an unreadable image leaves imageInputTokens at 0 and logs a flag.
  it('leaves imageInputTokens at 0 and logs when dimensions cannot be determined', async () => {
    const metrics = createUsageMetrics();
    const garbageRef = 'data:application/octet-stream;base64,' + Buffer.from('not an image').toString('base64');

    captureImageTokensAsync(fakeReq, metrics, [garbageRef]);
    await flush();

    expect(metrics.imageInputTokens).toBe(0);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'imageTokenCapture',
      'dimensions undeterminable — imageInputTokens left 0',
      { ref: garbageRef },
    );
  });

  it('is a no-op when there are no image refs', async () => {
    const metrics = createUsageMetrics();
    const onComplete = jest.fn();
    captureImageTokensAsync(fakeReq, metrics, undefined, onComplete);
    // No refs -> nothing to schedule, onComplete fires synchronously.
    expect(onComplete).toHaveBeenCalledTimes(1);
    await flush();
    expect(metrics.imageInputTokens).toBe(0);
  });

  // (d) latency guard: the caller's response path is never awaited on sniffing.
  it('returns synchronously, letting the caller finish (e.g. serve the response) before the deferred compute runs', async () => {
    const metrics = createUsageMetrics();
    const order: string[] = [];

    captureImageTokensAsync(fakeReq, metrics, [PNG_2x3_DATA_URL], () => {
      order.push('deferred-compute-complete');
    });

    // The call above already returned. Simulate the caller finishing its own response
    // handling (e.g. res.json / res.end) right after, in the same synchronous tick.
    order.push('response-sent');

    // At this point, only the response has been recorded -- the setImmediate callback
    // has not run yet, so the onComplete-sequenced step (e.g. emitUsageEvent) has not
    // fired either.
    expect(order).toEqual(['response-sent']);
    expect(metrics.imageInputTokens).toBe(0);

    await flush();

    expect(order).toEqual(['response-sent', 'deferred-compute-complete']);
    expect(metrics.imageInputTokens).toBeGreaterThan(0);
  });
});

// (a) Responses path copies input_tokens_details.image_tokens into metrics.
//
// `applyResponsesUsage` (responsesController.ts) is not exported, but it does nothing
// more than extract `usage.input_tokens_details.image_tokens` and hand it to
// `foldInclusiveUsage` as the 6th argument -- exactly what this exercises directly
// against the real (exported) folding function Task 9 extended for this purpose.
describe('Responses native-path image token copy (foldInclusiveUsage 6th arg)', () => {
  it('copies usage.input_tokens_details.image_tokens straight into metrics.imageInputTokens', () => {
    const metrics = createUsageMetrics();
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, image_tokens: 42 },
    };

    const cachedInput = usage.input_tokens_details?.cached_tokens || 0;
    const cacheWriteInput = usage.input_tokens_details?.cache_write_tokens || 0;
    const imageTokens = usage.input_tokens_details?.image_tokens ?? 0;
    foldInclusiveUsage(metrics, usage.input_tokens, usage.output_tokens, cacheWriteInput, cachedInput, imageTokens);

    expect(metrics.imageInputTokens).toBe(42);
  });

  it('defaults to 0 when the upstream usage carries no image_tokens field', () => {
    const metrics = createUsageMetrics();
    foldInclusiveUsage(metrics, 100, 20, 0, 0, undefined);
    expect(metrics.imageInputTokens).toBe(0);
  });
});
