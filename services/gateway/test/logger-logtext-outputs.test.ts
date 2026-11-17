/**
 * `logText` (what the stored log may show of an error carrying an upstream's text) is for the log
 * shipper's sink only. The console in `json` format and the file transport write the entry as
 * before: no `logText` in their lines.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '@libs/logger';
import type { LogEntry } from '@libs/logger';

const marked = (): Error => Object.defineProperty(new Error('the upstream said Jane Roe'), 'logText',
  { value: 'upstream error (status 400)', enumerable: false });

describe('logText stays out of the written lines', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('the json console format', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((l: unknown) => { lines.push(String(l)); });
    const logger = createLogger({ format: 'json', enableFileLogging: false, transports: [{ type: 'console' }] });
    const seen: LogEntry[] = [];
    logger.addSink((e) => { seen.push(e); });
    logger.error('X', 'call failed', marked());
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('logText');
    expect(JSON.parse(lines[0]).error).toEqual({ name: 'Error', message: 'the upstream said Jane Roe', stack: expect.any(String) });
    // the sink still gets it
    expect(seen[0].error?.logText).toBe('upstream error (status 400)');
  });

  it('the file transport', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtext-'));
    try {
      const logger = createLogger({ enableFileLogging: true, logFolderPath: dir, configFilePath: path.join(dir, 'none.json'), transports: [{ type: 'file', config: { filename: 'app.log' } }] });
      logger.error('X', 'call failed', marked());
      const line = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim();
      expect(line).not.toContain('logText');
      expect(JSON.parse(line).error.message).toBe('the upstream said Jane Roe');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
