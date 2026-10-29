// Legacy Word (.doc) reading: the FILE_SEARCH_DOC switch, the converter's availability, and the
// runner limits it runs under. A fake `antiword` script on PATH stands in for the real binary, so
// these run everywhere; the real binary is covered by the FILE_SEARCH_TEST_BINARIES suite
// (integration/legacyDoc.test.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ ingestion: { extractTimeoutMs: 10_000 } }),
}));

type Registry = typeof import('../../src/fileSearch/extractors/registry');
type LegacyDoc = typeof import('../../src/fileSearch/extractors/legacyDoc');
type Runners = typeof import('../../src/fileSearch/extractors/runners');
type Limits = typeof import('../../src/fileSearch/extractors/ooxml/limits');

const savedEnv = { PATH: process.env.PATH, FILE_SEARCH_DOC: process.env.FILE_SEARCH_DOC, W9_DOC_SENTINEL: process.env.W9_DOC_SENTINEL };
let tmpDir: string;
let marker: string;

/** A PATH directory holding a fake antiword. It logs its argv, whether its last argument is a file,
 *  that file's path and the sentinel variable to `marker`, then acts on the file's first line:
 *  HANG spins, KILL dies by SIGKILL, FAIL writes document text to stderr and exits 1, FLOOD writes without end,
 *  anything else is echoed back as the "converted" text. Builtins only: the child has no PATH. */
function fakeAntiwordDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'bin-'));
  const script = [
    '#!/bin/sh',
    'for a in "$@"; do last="$a"; done',
    `echo "args:$*" >> '${marker}'`,
    `echo "path:$last" >> '${marker}'`,
    `echo "pid:$$" >> '${marker}'`,
    `echo "sentinel:\${W9_DOC_SENTINEL-unset}" >> '${marker}'`,
    `if [ -f "$last" ]; then echo "file:present" >> '${marker}'; fi`,
    'read -r first < "$last"',
    'case "$first" in',
    '  HANG*) while :; do :; done ;;',
    '  KILL*) kill -9 $$ ;;',
    '  FAIL*) echo "SECRET-DOC-TEXT is not a Word Document." >&2; exit 1 ;;',
    '  FLOOD*) while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done ;;',
    'esac',
    'printf "Converted: %s\\n" "$first"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'antiword'), script, { mode: 0o755 });
  return dir;
}

/** A fake antiword in node (absolute shebang: the child has no PATH) that records the modes of its
 *  input file and that file's directory. */
function modeRecordingAntiwordDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'bin-'));
  const script = [
    `#!${process.execPath}`,
    "const fs = require('fs'), path = require('path');",
    'const file = process.argv[process.argv.length - 1];',
    "const m = (p) => (fs.statSync(p).mode & 0o777).toString(8);",
    `fs.appendFileSync('${marker}', 'filemode:' + m(file) + '\\ndirmode:' + m(path.dirname(file)) + '\\n');`,
    "process.stdout.write('ok\\n');",
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'antiword'), script, { mode: 0o755 });
  return dir;
}

function markerLines(): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
}

function markerValue(key: string): string | undefined {
  return markerLines().find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1);
}

/** Fresh modules: runners' binary cache starts empty, so PATH changes are seen. */
function fresh(): { registry: Registry; legacyDoc: LegacyDoc; runners: Runners; limits: Limits } {
  let mods!: { registry: Registry; legacyDoc: LegacyDoc; runners: Runners; limits: Limits };
  jest.isolateModules(() => {
    mods = {
      registry: require('../../src/fileSearch/extractors/registry'),
      legacyDoc: require('../../src/fileSearch/extractors/legacyDoc'),
      runners: require('../../src/fileSearch/extractors/runners'),
      limits: require('../../src/fileSearch/extractors/ooxml/limits'),
    };
  });
  return mods;
}

function withAntiword(): void {
  process.env.PATH = `${fakeAntiwordDir()}${path.delimiter}${savedEnv.PATH}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-doc-'));
  marker = path.join(tmpDir, 'runs.log');
  delete process.env.FILE_SEARCH_DOC;
  Object.values(mockLog).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('whether .doc is read here', () => {
  it('reads .doc when antiword is on PATH and FILE_SEARCH_DOC is unset or auto', () => {
    withAntiword();
    expect(fresh().legacyDoc.isLegacyDocEnabled()).toBe(true);
    process.env.FILE_SEARCH_DOC = 'auto';
    const { registry } = fresh();
    expect(registry.isSupportedExtension('doc')).toBe(true);
    expect(registry.isSupportedFilename('Report.DOC')).toBe(true);
  });

  it.each(['off', 'OFF', ' off ', 'false', '0', 'no', 'disabled'])(
    'is off with FILE_SEARCH_DOC=%j although antiword is installed (the npm standalone CLI sets off)',
    (value) => {
      withAntiword();
      process.env.FILE_SEARCH_DOC = value;
      const { legacyDoc, registry } = fresh();
      expect(legacyDoc.isLegacyDocEnabled()).toBe(false);
      expect(registry.isSupportedExtension('doc')).toBe(false);
      expect(registry.isSupportedFilename('a.doc')).toBe(false);
    },
  );

  it('is off without antiword on PATH', () => {
    process.env.PATH = tmpDir; // a directory without antiword
    const { legacyDoc, registry } = fresh();
    expect(legacyDoc.isLegacyDocEnabled()).toBe(false);
    expect(registry.isSupportedExtension('doc')).toBe(false);
  });

  it('looks antiword up once per process: a miss is remembered, until reset', () => {
    process.env.PATH = tmpDir; // a directory without antiword
    const { legacyDoc } = fresh();
    expect(legacyDoc.isLegacyDocEnabled()).toBe(false);
    fs.writeFileSync(path.join(tmpDir, 'antiword'), '#!/bin/sh\n', { mode: 0o755 });
    expect(legacyDoc.isLegacyDocEnabled()).toBe(false); // PATH is not scanned again
    legacyDoc.resetLegacyDocPathCache();
    expect(legacyDoc.isLegacyDocEnabled()).toBe(true);
    fs.rmSync(path.join(tmpDir, 'antiword'));
    expect(legacyDoc.isLegacyDocEnabled()).toBe(true); // and a hit is kept
  });

  it('leaves .ppt and .xls refused either way', () => {
    withAntiword();
    const { registry } = fresh();
    expect(registry.isSupportedExtension('ppt')).toBe(false);
    expect(registry.isSupportedExtension('xls')).toBe(false);
  });
});

describe('a .doc where it is not read', () => {
  it.each([
    ['switched off', () => { withAntiword(); process.env.FILE_SEARCH_DOC = 'off'; }],
    ['antiword missing', () => { process.env.PATH = tmpDir; }],
  ])('fails permanently, saying so, when %s — and never runs the converter', async (_label, setup) => {
    setup();
    const { registry } = fresh();
    for (const extract of [registry.extractText, registry.extractStructuredText]) {
      // eslint-disable-next-line no-await-in-loop
      const error = await (extract as any)('memo.doc', Buffer.from('plain words'), {}).catch((e: any) => e);
      expect(error).toBeInstanceOf(registry.UnsupportedFileTypeError); // permanent (ingestWorker)
      expect(error).toBeInstanceOf(registry.LegacyDocUnsupportedError);
      expect(error.message).toBe('legacy .doc files are not supported on this deployment');
      // the name a re-extract looks for, to queue the file again once .doc is read here
      expect(error.name).toBe('UnsupportedFileTypeError');
    }
    expect(markerLines()).toEqual([]);
  });
});

describe('a .doc where it is read', () => {
  it('returns the converter\'s text, from a private temporary file removed afterwards', async () => {
    withAntiword();
    process.env.W9_DOC_SENTINEL = 'must-not-reach-the-child';
    const { registry } = fresh();
    const text = await registry.extractText('memo.doc', Buffer.from('Harbour minutes\n'), {});
    expect(text).toBe('Converted: Harbour minutes\n');
    expect(markerValue('args')).toMatch(/^-m UTF-8\.txt -w 0 \S+$/);
    expect(markerValue('file')).toBe('present');
    // the child's environment is empty (runners.ts allowlist): nothing of the gateway's reaches it
    expect(markerValue('sentinel')).toBe('unset');
    const inputPath = markerValue('path')!;
    expect(path.basename(inputPath)).toBe('input'); // never the upload's own name
    expect(fs.existsSync(path.dirname(inputPath))).toBe(false);
  });

  it('reads it for the structure strategy as plain blank-line blocks', async () => {
    withAntiword();
    const { registry } = fresh();
    await expect(registry.extractStructuredText('memo.doc', Buffer.from('Body text\n'), {}))
      .resolves.toEqual({ text: 'Converted: Body text\n', format: 'plain' });
  });

  it('runs antiword through the runner with the extraction timeout, at low priority', async () => {
    withAntiword();
    const { registry, runners } = fresh();
    const spy = jest.spyOn(runners, 'runExtractorOnFile');
    await registry.extractText('memo.doc', Buffer.from('x\n'), { timeoutMs: 4321 });
    expect(spy).toHaveBeenCalledWith('antiword', ['-m', 'UTF-8.txt', '-w', '0'], expect.any(Buffer),
      { timeoutMs: 4321, maxOutputBytes: undefined, lowPriority: true });
  });

  it('turns a refused file into a permanent DocumentReadError without echoing antiword\'s stderr', async () => {
    withAntiword();
    const { registry, limits } = fresh();
    const error = await registry.extractText('memo.doc', Buffer.from('FAIL\n'), {}).catch((e) => e);
    expect(error).toBeInstanceOf(limits.DocumentReadError);
    expect(error.message).toBe('Could not read the Word file: it is not a Word 97–2003 document, or it is encrypted or damaged');
    expect(error.message).not.toContain('SECRET-DOC-TEXT');
    expect(fs.existsSync(path.dirname(markerValue('path')!))).toBe(false);
  });

  it('keeps the input in a 0700 directory as a 0600 file', async () => {
    process.env.PATH = `${modeRecordingAntiwordDir()}${path.delimiter}${savedEnv.PATH}`;
    const { registry } = fresh();
    await expect(registry.extractText('memo.doc', Buffer.from('x\n'), {})).resolves.toBe('ok\n');
    expect(markerValue('dirmode')).toBe('700');
    expect(markerValue('filemode')).toBe('600');
  });

  it('kills a converter that hangs at the timeout (not after the SIGKILL grace) and removes the temporary file', async () => {
    withAntiword();
    const { registry, runners } = fresh();
    const started = Date.now();
    // 1 s gives the fake's shell time to start and write its marker on a loaded machine (with
    // 300 ms a parallel run killed it before it wrote anything)
    const error = await registry.extractText('memo.doc', Buffer.from('HANG\n'), { timeoutMs: 1000 }).catch((e) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(runners.ExtractionTimeoutError);
    expect(error.message).toContain('1000ms');
    // settled by the timer itself: not early, and below the SIGKILL escalation (timeout + 3 s grace)
    expect(elapsed).toBeGreaterThanOrEqual(990);
    expect(elapsed).toBeLessThan(3500);
    expect(fs.existsSync(path.dirname(markerValue('path')!))).toBe(false);
    // the hung process is really gone (SIGTERM reaches its group), within a bounded wait
    const pid = Number(markerValue('pid'));
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2000;
    while (alive() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive()).toBe(false);
  });

  it('treats an antiword killed by a signal (OOM kill) as transient, not as "not a Word document"', async () => {
    withAntiword();
    const { registry, runners, limits } = fresh();
    const error = await registry.extractText('memo.doc', Buffer.from('KILL\n'), {}).catch((e) => e);
    expect(error).toBeInstanceOf(runners.ExtractorExitError);
    expect(error.exitCode).toBeNull();
    expect(error).not.toBeInstanceOf(limits.DocumentReadError);
    expect(error).not.toBeInstanceOf(registry.UnsupportedFileTypeError); // so the worker retries it
    expect(fs.existsSync(path.dirname(markerValue('path')!))).toBe(false);
  });

  it('aborts a converter whose output passes the cap', async () => {
    withAntiword();
    const { legacyDoc, runners } = fresh();
    const error = await legacyDoc.readLegacyDoc(Buffer.from('FLOOD\n'), { timeoutMs: 10_000, maxOutputBytes: 4096 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(runners.ExtractionOutputTooLargeError);
  });
});
