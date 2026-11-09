// W3 Task 1: the OCR enablement switch and its configured languages. A fake `tesseract` script on
// PATH stands in for the real binary, so these run everywhere; the real binary is covered by the
// FILE_SEARCH_TEST_BINARIES suite (integration/extractors.test.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));

let mockLanguages: string[] = ['eng'];
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ parsing: { ocr: { languages: mockLanguages } } }),
}));

type OcrModule = typeof import('../../src/fileSearch/extractors/ocrAvailability');

const savedEnv = { PATH: process.env.PATH, FILE_SEARCH_OCR: process.env.FILE_SEARCH_OCR, TESSDATA_PREFIX: process.env.TESSDATA_PREFIX };
let tmpDir: string;
let marker: string;

/**
 * A PATH directory with a fake tesseract whose --list-langs prints `langs`; each run appends a line
 * with the TESSDATA_PREFIX it was given to `marker`.
 */
function fakeTesseractDir(langs: string[]): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'bin-'));
  const script = [
    '#!/bin/sh',
    `echo "run:$TESSDATA_PREFIX" >> '${marker}'`,
    `printf '%s\\n' 'List of available languages in "/usr/share/tessdata/" (${langs.length}):' ${langs.map((l) => `'${l}'`).join(' ')}`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'tesseract'), script, { mode: 0o755 });
  return dir;
}

function runLines(): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
}

/** A fresh module instance: its cached decision and runners' binary cache start empty. */
function freshModule(): OcrModule {
  let mod!: OcrModule;
  jest.isolateModules(() => {
    mod = require('../../src/fileSearch/extractors/ocrAvailability');
  });
  return mod;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-switch-'));
  marker = path.join(tmpDir, 'runs.log');
  mockLanguages = ['eng'];
  delete process.env.FILE_SEARCH_OCR;
  delete process.env.TESSDATA_PREFIX;
  Object.values(mockLog).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isOcrEnabled', () => {
  it('is off in the npm standalone CLI (FILE_SEARCH_OCR=off) even with tesseract and the languages installed', async () => {
    process.env.PATH = fakeTesseractDir(['eng', 'deu', 'osd']);
    process.env.FILE_SEARCH_OCR = 'off';
    const ocr = freshModule();

    expect(await ocr.isOcrEnabled()).toBe(false);
    const status = await ocr.getOcrStatus();
    expect(status.switchedOff).toBe(true);
    expect(status.languages).toEqual([]);
    expect(await ocr.getOcrLanguages()).toEqual([]);
    expect(runLines()).toEqual([]); // the host's tesseract is never even asked
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('FileSearchOcr', expect.stringContaining('OCR is off'));
  });

  it.each(['OFF', ' off ', 'false', '0', 'no', 'disabled'])('treats FILE_SEARCH_OCR=%j as off', async (value) => {
    process.env.PATH = fakeTesseractDir(['eng']);
    process.env.FILE_SEARCH_OCR = value;
    expect(await freshModule().isOcrEnabled()).toBe(false);
    expect(runLines()).toEqual([]);
  });

  it('is on in the image and dev when tesseract has eng (the default), and asks tesseract only once', async () => {
    process.env.PATH = fakeTesseractDir(['eng', 'osd']);
    const ocr = freshModule();

    expect(await ocr.isOcrEnabled()).toBe(true);
    expect(await ocr.isOcrEnabled()).toBe(true);
    expect(runLines()).toHaveLength(1);
    const status = await ocr.getOcrStatus();
    expect(status.languages).toEqual(['eng']);
    expect(status.installed).toEqual(['eng', 'osd']);
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('FileSearchOcr', 'OCR is on: tesseract with eng');
  });

  it.each(['auto', 'AUTO', ''])('FILE_SEARCH_OCR=%j means on when the tools are there', async (value) => {
    process.env.PATH = fakeTesseractDir(['eng']);
    process.env.FILE_SEARCH_OCR = value;
    expect(await freshModule().isOcrEnabled()).toBe(true);
  });

  it('uses the configured languages in configured order', async () => {
    mockLanguages = ['deu', 'eng'];
    process.env.PATH = fakeTesseractDir(['eng', 'deu', 'osd']);
    const ocr = freshModule();
    expect(await ocr.getOcrLanguages()).toEqual(['deu', 'eng']);
    expect(mockLog.info).toHaveBeenCalledWith('FileSearchOcr', 'OCR is on: tesseract with deu+eng');
  });

  it('skips a configured language without data, with one warning naming it, and stays on', async () => {
    mockLanguages = ['eng', 'deu', 'fra'];
    process.env.PATH = fakeTesseractDir(['eng', 'osd']);
    const ocr = freshModule();

    expect(await ocr.isOcrEnabled()).toBe(true);
    expect(await ocr.getOcrLanguages()).toEqual(['eng']);
    expect((await ocr.getOcrStatus()).missing).toEqual(['deu', 'fra']);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('FileSearchOcr', expect.stringContaining('skipped: deu, fra'));
  });

  it('is off with one warning when none of the configured languages is installed', async () => {
    mockLanguages = ['deu'];
    process.env.PATH = fakeTesseractDir(['eng', 'osd']);
    const ocr = freshModule();

    expect(await ocr.isOcrEnabled()).toBe(false);
    expect(await ocr.isOcrEnabled()).toBe(false);
    expect((await ocr.getOcrStatus()).reason).toMatch(/none of the configured languages \(deu\)/);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('FileSearchOcr', expect.stringContaining('OCR is off'));
  });

  it('asks tesseract again when the configured list changes, and sees language data installed meanwhile', async () => {
    const dir = fakeTesseractDir(['eng']);
    process.env.PATH = dir;
    const ocr = freshModule();
    expect(await ocr.getOcrLanguages()).toEqual(['eng']);
    expect(await ocr.getOcrLanguages()).toEqual(['eng']);
    expect(runLines()).toHaveLength(1); // unchanged list: no new probe

    // deu installed after start, then added to the configuration
    fs.rmSync(dir, { recursive: true });
    fs.renameSync(fakeTesseractDir(['eng', 'deu']), dir);
    mockLanguages = ['eng', 'deu'];
    expect(await ocr.getOcrLanguages()).toEqual(['eng', 'deu']);
    expect(await ocr.getOcrLanguages()).toEqual(['eng', 'deu']);
    expect(runLines()).toHaveLength(2); // one new probe for the new list
    expect(mockLog.info).toHaveBeenCalledWith('FileSearchOcr', 'OCR is on: tesseract with eng+deu');
  });

  it('keeps one probe in flight for concurrent callers', async () => {
    process.env.PATH = fakeTesseractDir(['eng']);
    const ocr = freshModule();
    const results = await Promise.all([ocr.isOcrEnabled(), ocr.isOcrEnabled(), ocr.isOcrEnabled()]);
    expect(results).toEqual([true, true, true]);
    expect(runLines()).toHaveLength(1);
    expect(mockLog.info).toHaveBeenCalledTimes(1);
  });

  it('retries a failed probe after the back-off, not before, and warns only once while it keeps failing', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'later-'));
    process.env.PATH = dir;
    const ocr = freshModule();
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(await ocr.isOcrEnabled()).toBe(false);
      now += ocr.PROBE_RETRY_MS - 1;
      expect(await ocr.isOcrEnabled()).toBe(false); // within the back-off: the failure is kept
      now += 1;
      expect(await ocr.isOcrEnabled()).toBe(false); // retried, still no tesseract
      expect(mockLog.warn).toHaveBeenCalledTimes(1);

      // tesseract appears (e.g. installed while the gateway runs)
      fs.rmSync(dir, { recursive: true });
      fs.renameSync(fakeTesseractDir(['eng']), dir);
      expect(await ocr.isOcrEnabled()).toBe(false); // the retried failure is kept for the back-off
      expect(runLines()).toHaveLength(0);
      now += ocr.PROBE_RETRY_MS;
      expect(await ocr.isOcrEnabled()).toBe(true);
      expect(runLines()).toHaveLength(1);
      now += 10 * ocr.PROBE_RETRY_MS;
      expect(await ocr.isOcrEnabled()).toBe(true); // a successful probe is kept
      expect(runLines()).toHaveLength(1);
      expect(mockLog.info).toHaveBeenCalledWith('FileSearchOcr', 'OCR is on: tesseract with eng');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('is off with one warning when tesseract is not on PATH', async () => {
    process.env.PATH = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const ocr = freshModule();

    expect(await ocr.isOcrEnabled()).toBe(false);
    expect((await ocr.getOcrStatus()).reason).toMatch(/tesseract is not available/);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it('is off when tesseract fails', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'bin-'));
    fs.writeFileSync(path.join(dir, 'tesseract'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    process.env.PATH = dir;
    expect(await freshModule().isOcrEnabled()).toBe(false);
  });

  it("passes the gateway's TESSDATA_PREFIX on to tesseract", async () => {
    process.env.PATH = fakeTesseractDir(['eng']);
    process.env.TESSDATA_PREFIX = '/opt/tessdata';
    expect(await freshModule().isOcrEnabled()).toBe(true);
    expect(runLines()).toEqual(['run:/opt/tessdata']);
  });

  it('warns about an unknown FILE_SEARCH_OCR value and falls back to auto', async () => {
    process.env.PATH = fakeTesseractDir(['eng']);
    process.env.FILE_SEARCH_OCR = 'sometimes';
    const ocr = freshModule();
    expect(await ocr.isOcrEnabled()).toBe(true);
    expect(await ocr.isOcrEnabled()).toBe(true);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('FileSearchOcr', expect.stringContaining('sometimes'));
  });
});

describe('detectOcr', () => {
  it('uses an injected probe and does not cache', async () => {
    const ocr = freshModule();
    const probe = { listLanguages: jest.fn().mockResolvedValue('List of available languages in "x" (2):\neng\ndeu\n') };
    expect((await ocr.detectOcr({}, ['eng'], probe)).languages).toEqual(['eng']);
    expect((await ocr.detectOcr({}, ['deu', 'eng'], probe)).languages).toEqual(['deu', 'eng']);
    expect(probe.listLanguages).toHaveBeenCalledTimes(2);
    expect((await ocr.detectOcr({ FILE_SEARCH_OCR: 'off' }, ['eng'], probe)).enabled).toBe(false);
    expect(probe.listLanguages).toHaveBeenCalledTimes(2);
  });
});

describe('parseLanguageList', () => {
  it('drops the header line and blank lines, including CRLF output', () => {
    const { parseLanguageList } = freshModule();
    expect(parseLanguageList('List of available languages in "/usr/share/tessdata/" (3):\r\ndeu\r\neng\r\nosd\r\n')).toEqual([
      'deu',
      'eng',
      'osd',
    ]);
  });
});

describe('tesseractChildEnv', () => {
  it('limits tesseract to one thread and passes TESSDATA_PREFIX only when set', () => {
    const { tesseractChildEnv } = freshModule();
    expect(tesseractChildEnv({})).toEqual({ OMP_THREAD_LIMIT: '1' });
    expect(tesseractChildEnv({ TESSDATA_PREFIX: '/opt/tessdata', PATH: '/usr/bin' })).toEqual({
      OMP_THREAD_LIMIT: '1',
      TESSDATA_PREFIX: '/opt/tessdata',
    });
  });
});

describe('nice', () => {
  const niceLines = () => mockLog.debug.mock.calls.filter((c) => /"nice" is not on PATH/.test(String(c[1])));

  it('says once, at debug level, that nice is missing (OCR and page rendering then run at normal priority)', async () => {
    process.env.PATH = fakeTesseractDir(['eng']); // no nice on this PATH
    const ocr = freshModule();
    await ocr.getOcrStatus();
    mockLanguages = ['eng', 'deu']; // a new decision is logged again; nice is not
    await ocr.getOcrStatus();
    expect(mockLog.info).toHaveBeenCalledTimes(2);
    expect(niceLines()).toHaveLength(1);
    expect(mockLog.warn.mock.calls.flat().join(' ')).not.toMatch(/nice/);
  });

  it('says nothing when nice is there', async () => {
    const nice = fs.mkdtempSync(path.join(tmpDir, 'nice-'));
    fs.writeFileSync(path.join(nice, 'nice'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    process.env.PATH = `${fakeTesseractDir(['eng'])}${path.delimiter}${nice}`;
    await freshModule().getOcrStatus();
    expect(niceLines()).toHaveLength(0);
  });
});
