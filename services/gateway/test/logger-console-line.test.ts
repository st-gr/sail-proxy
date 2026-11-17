/**
 * The console line the gateway logger writes is read by people, by `sail-proxy logs` (its --since
 * filter looks for the ISO timestamp) and by log shippers. It must not change.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createLogger } from '@libs/logger';

const TS = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

describe('logger console line', () => {
  let lines: string[];
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    lines = [];
    const grab = (l: unknown) => { lines.push(String(l)); };
    jest.spyOn(console, 'info').mockImplementation(grab);
    jest.spyOn(console, 'error').mockImplementation(grab);
    logger = createLogger({ enableColors: false, enableFileLogging: false });
  });

  afterEach(() => {
    logger.clearRequestContext();
    jest.restoreAllMocks();
  });

  it('writes <timestamp> [<request id>] <LEVEL> [<component>] <message> <metadata JSON>', () => {
    logger.setRequestContext({ requestId: 'gateway-1-abc' } as any);
    logger.info('imagesController', 'Images request refused', { status: 400 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${TS} \\[gateway-1-abc\\] INFO  \\[imagesController\\] Images request refused \\{"status":400\\}$`));
  });

  it('appends the error name, message and stack on their own lines', () => {
    logger.setRequestContext({ requestId: 'gateway-1-abc' } as any);
    logger.error('imagesController', 'Images request failed', new TypeError('boom'));
    expect(lines).toHaveLength(1);
    const parts = lines[0].split('\n');
    expect(parts[0]).toMatch(new RegExp(`^${TS} \\[gateway-1-abc\\] ERROR \\[imagesController\\] Images request failed$`));
    expect(parts[1]).toBe('Error: TypeError: boom');
    expect(parts[2]).toMatch(/^Stack: TypeError: boom/);
  });

  it('omits the request id bracket when there is none', () => {
    logger.info('startup', 'ready');
    expect(lines[0]).toMatch(new RegExp(`^${TS} INFO  \\[startup\\] ready$`));
  });
});
