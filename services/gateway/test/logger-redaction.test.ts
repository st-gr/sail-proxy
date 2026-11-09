/**
 * The shared logger (libs/logger) must redact credential headers carried in
 * log metadata at every level, and must never throw on circular metadata.
 *
 * Prior to this fix, `formatHeaders` only stringified array values and never
 * called the redaction helpers (`isSensitiveHeaderName` / `redactHeaderValue`)
 * that `createHeadersPreview` already used, so `logger.info/debug/trace(...,
 * { headers: {...} })` printed credential header values verbatim. Separately,
 * non-trace metadata was serialized with a bare `JSON.stringify`, which
 * throws on a circular reference.
 *
 * This suite lives in services/gateway/test/ rather than under libs/logger
 * because libs/ has no test runner of its own; the gateway's jest config
 * already maps `@libs/*` to the shared libs and is where this file gets
 * picked up and executed by CI (see ci/ci-pipeline.js Phase 6, `pnpm run
 * test` in services/gateway).
 *
 * @see ../../../libs/logger/index.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@libs/logger';

// Hermetic: the shipped api_config.json (platform.logging.defaultLevel INFO) must not override the
// explicit levels these tests construct their loggers with.
process.env.CONFIG_FILE_PATH = path.join(__dirname, 'no-such-api-config.json');
// ...and neither may an exported LOG_LEVEL (it outranks the explicit constructor level).
const savedLogLevel = process.env.LOG_LEVEL;
delete process.env.LOG_LEVEL;

const FAKE_BEARER_TOKEN = 'sk-test-FAKE-SECRET-VALUE-abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_API_KEY = 'sk-test-FAKE-API-KEY-9876543210zyxwvutsrqponmlkjihgfedcba';

function captureConsole(method: 'info' | 'debug') {
  const calls: string[] = [];
  const original = console[method];
  (console as any)[method] = (msg: string) => calls.push(msg);
  return { calls, restore: () => { console[method] = original; } };
}

afterAll(() => {
  if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLogLevel;
});

describe('logger metadata header redaction', () => {
  let capture: { calls: string[]; restore: () => void };

  afterEach(() => {
    capture?.restore();
  });

  it.each(['info', 'debug'] as const)(
    'redacts credential headers in metadata at %s level',
    (level) => {
      const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
      capture = captureConsole(level === 'info' ? 'info' : 'debug');

      logger[level]('X', 'm', {
        headers: { authorization: `Bearer ${FAKE_BEARER_TOKEN}`, 'x-api-key': FAKE_API_KEY }
      });

      const output = capture.calls.join('\n');
      expect(output).not.toContain(FAKE_BEARER_TOKEN);
      expect(output).not.toContain(FAKE_API_KEY);
      expect(output).toContain('Bearer [redacted:');
    }
  );

  it('redacts credential headers in metadata at trace level', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('debug'); // trace writes via console.debug

    logger.trace('X', 'm', {
      headers: { authorization: `Bearer ${FAKE_BEARER_TOKEN}`, 'x-api-key': FAKE_API_KEY }
    });

    const output = capture.calls.join('\n');
    expect(output).not.toContain(FAKE_BEARER_TOKEN);
    expect(output).not.toContain(FAKE_API_KEY);
    expect(output).toContain('Bearer [redacted:');
  });

  it('keeps header keys and non-sensitive values intact while redacting', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('info');

    logger.info('X', 'm', {
      headers: { authorization: `Bearer ${FAKE_BEARER_TOKEN}`, 'content-type': 'application/json' }
    });

    const output = capture.calls.join('\n');
    expect(output).toContain('authorization');
    expect(output).toContain('application/json');
  });

  it('serializes a Date (top-level and nested) to its ISO string rather than {}', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('info');

    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    logger.info('X', 'm', { expiresAt, nested: { at: expiresAt } });

    const output = capture.calls.join('\n');
    expect(output).toContain('2024-01-01T00:00:00.000Z');
    expect(output).not.toContain('"expiresAt":{}');
    expect(output).not.toContain('"at":{}');
  });

  it('still redacts headers nested inside a plain object alongside a Date', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('info');

    logger.info('X', 'm', {
      expiresAt: new Date('2024-01-01T00:00:00.000Z'),
      request: { headers: { authorization: `Bearer ${FAKE_BEARER_TOKEN}` } }
    });

    const output = capture.calls.join('\n');
    expect(output).not.toContain(FAKE_BEARER_TOKEN);
    expect(output).toContain('Bearer [redacted:');
  });

  it('does not throw on circular metadata at info level', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('info');

    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => logger.info('X', 'm', circular)).not.toThrow();
    const output = capture.calls.join('\n');
    expect(output).toContain('[Circular]');
  });

  it('does not throw on circular metadata at trace level', () => {
    const logger = createLogger({ format: 'json', transports: [{ type: 'console' }], level: 'trace' });
    capture = captureConsole('debug');

    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => logger.trace('X', 'm', circular)).not.toThrow();
  });

  it('does not throw when writing circular metadata to a file transport', () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'logger-redaction-test-'));
    try {
      const logger = createLogger({
        format: 'json',
        transports: [{ type: 'file', config: { filename: 'app.log' } }],
        logFolderPath: tmpDir,
        level: 'info'
      });

      const circular: any = { a: 1 };
      circular.self = circular;

      expect(() => logger.info('X', 'm', circular)).not.toThrow();
      logger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('openRouterController raw header logging', () => {
  it('no longer JSON.stringifies req.headers directly in src/controllers', () => {
    const controllersDir = path.join(__dirname, '..', 'src', 'controllers');
    const files = fs.readdirSync(controllersDir).filter(f => f.endsWith('.ts'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(controllersDir, file), 'utf8');
      expect(content).not.toMatch(/JSON\.stringify\(\s*req\.headers\s*\)/);
    }
  });
});
