import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getTeacherLoggingConfig,
  resolveMaxConcurrentWrites,
  MAX_CONCURRENT_WRITES_CEILING,
} from '../../src/services/configService';
import { getDefaultLogger } from '@libs/logger';

describe('getTeacherLoggingConfig', () => {
  it('is off by default, and text storage is off independently', () => {
    const c = getTeacherLoggingConfig();
    expect(c.enabled).toBe(false);
    expect(c.storeChunkText).toBe(false);
    expect(c.sampleRate).toBe(1.0);
    expect(c.source).toBe('production');
    expect(c.maxConcurrentWrites).toBe(2);
  });

  // The arm above reads the SHIPPED config, which always carries a complete
  // teacher_logging block — so it exercises the populated branch and mutating a
  // default fails nothing. The branch below is what an UPGRADING install hits:
  // its api_config.json predates the block entirely. It was untested.
  //
  // Asserted against written-out literals, never against
  // TEACHER_LOGGING_DEFAULTS: comparing the constant to itself passes no matter
  // what the constant becomes, which is the failure mode this test exists to
  // avoid.
  describe('when teacher_logging is absent entirely (an upgrading install)', () => {
    // getTeacherLoggingConfig calls the module-LOCAL getConfig(), so spying on
    // the export cannot intercept it, and fs.existsSync is not redefinable so it
    // cannot be spied either. CONFIG_FILE_PATH is read into a const at module
    // load, so the way in is to point it at a config file that predates the
    // teacher_logging block and re-require the module.
    let tmpDir: string;

    function loadWith(config: unknown): typeof import('../../src/services/configService') {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify(config));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService');
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-logging-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });

    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('yields the shipped defaults', () => {
      const svc = loadWith({ api_config: { file_search: {} } });
      expect(svc.getTeacherLoggingConfig()).toEqual({
        enabled: false,
        storeChunkText: false,
        sampleRate: 1.0,
        source: 'production',
        maxConcurrentWrites: 2,
      });
    });

    it('yields the same defaults when file_search itself is absent', () => {
      const svc = loadWith({ api_config: {} });
      expect(svc.getTeacherLoggingConfig()).toEqual({
        enabled: false,
        storeChunkText: false,
        sampleRate: 1.0,
        source: 'production',
        maxConcurrentWrites: 2,
      });
    });
  });
});

// The admin config schema caps max_concurrent_writes at the pg pool size
// ("maximum": 10), but that only validates edits made through the cockpit — a
// hand-edited api_config.json reaches the gateway unchecked, and above the
// pool size the teacher logger's semaphore stops DROPPING surplus writes and
// starts queueing them inside the pool, delaying the searches it exists to
// observe. The clamp must therefore be enforced at read time, and must say so
// out loud (a silent override of a tuning choice is its own defect) without
// warning on every search — this resolver runs on the search path.
describe('resolveMaxConcurrentWrites', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('leaves a value at or below the pool ceiling untouched and says nothing', () => {
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');
    expect(MAX_CONCURRENT_WRITES_CEILING).toBe(10); // the pool's own `max` — fileSearch/db.ts
    for (const v of [1, 2, 5, MAX_CONCURRENT_WRITES_CEILING]) {
      expect(resolveMaxConcurrentWrites(v)).toBe(v);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clamps an over-limit value to the pool ceiling and warns EXACTLY ONCE for it', () => {
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');

    for (let i = 0; i < 25; i++) {
      expect(resolveMaxConcurrentWrites(500)).toBe(MAX_CONCURRENT_WRITES_CEILING);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][1]);
    expect(message).toContain('max_concurrent_writes');
    expect(message).toContain('500');                              // what was configured
    expect(message).toContain(String(MAX_CONCURRENT_WRITES_CEILING)); // what it became
    expect(message).toMatch(/clamp/i);
  });

  it('warns again when the configured value changes to a different over-limit value', () => {
    // teacher_logging is deliberately runtime-flippable from the admin
    // cockpit, so a later edit is a new decision, not a repeat of the one
    // already warned about — and it must not be swallowed by the once-only
    // guard above.
    resolveMaxConcurrentWrites(11);
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');

    expect(resolveMaxConcurrentWrites(11)).toBe(MAX_CONCURRENT_WRITES_CEILING);
    expect(warnSpy).not.toHaveBeenCalled(); // same value, already warned

    expect(resolveMaxConcurrentWrites(64)).toBe(MAX_CONCURRENT_WRITES_CEILING);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][1])).toContain('64');
  });
});
