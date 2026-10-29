// W3 Task 0: the runner extensions OCR (pdftoppm -> tesseract), the OOXML
// reader and vision page rendering build on — a Buffer-output variant, a
// narrow env allowlist and an optional lower-priority wrapper. Like
// runners.test.ts these spawn real processes (cat, node, nice) so the
// timeout/kill/cap paths are exercised for real.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runExtractor,
  runExtractorBuffer,
  ALLOWED_CHILD_ENV,
  ExtractionTimeoutError,
  ExtractionOutputTooLargeError,
} from '../../src/fileSearch/extractors/runners';

const FIXTURES = path.join(__dirname, 'fixtures');
const HANGING = path.join(FIXTURES, 'hangingProcess.js');
const FLOODING = path.join(FIXTURES, 'floodingProcess.js');
const ENV_DUMP = path.join(FIXTURES, 'envDumpProcess.js');
const PRIORITY = path.join(FIXTURES, 'priorityProcess.js');
const STDIN_IGNORING = path.join(FIXTURES, 'stdinIgnoringProcess.js');

// macOS injects __CF_USER_TEXT_ENCODING into every process whatever env
// spawn() is given (see runners.test.ts); nothing else may appear.
const OS_INJECTED = new Set(['__CF_USER_TEXT_ENCODING']);

function childEnvKeys(out: string): string[] {
  return Object.keys(JSON.parse(out)).filter((k) => !OS_INJECTED.has(k)).sort();
}

// Each launch carries its own marker argument (the fixtures ignore their arguments), so a check
// for "gone" cannot see the same fixture started by another suite running in parallel
// (runners.test.ts launches hangingProcess.js too).
let launches = 0;
function marker(): string {
  return `runner-ext-${process.pid}-${++launches}`;
}

function processGone(needle: string): boolean {
  const { execSync } = require('child_process');
  return execSync(`ps -eo pid,command | grep ${JSON.stringify(needle)} | grep -v grep || true`)
    .toString()
    .trim() === '';
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe('runExtractorBuffer', () => {
  it('returns stdout bytes intact, including NUL and bytes that are not valid UTF-8', async () => {
    const input = Buffer.alloc(4096);
    for (let i = 0; i < input.length; i++) input[i] = i % 256;
    // A PNG signature in the middle: \x89 and \x1a would not survive a UTF-8 round trip.
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(input, 1000);

    const out = await runExtractorBuffer('cat', [], input, { timeoutMs: 5000 });

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(input)).toBe(true);
  });

  it('caps captured stdout, kills the tool and rejects well before the timeout', async () => {
    const start = Date.now();
    const id = marker();
    await expect(
      runExtractorBuffer('node', [FLOODING, id], Buffer.from('x'), { timeoutMs: 10000, maxOutputBytes: 200000 })
    ).rejects.toThrow(ExtractionOutputTooLargeError);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await waitUntil(() => processGone(id), 5000)).toBe(true);
  }, 15000);

  it('kills a SIGTERM-ignoring tool on timeout and rejects', async () => {
    const id = marker();
    await expect(
      runExtractorBuffer('node', [HANGING, id], Buffer.from('x'), { timeoutMs: 150 })
    ).rejects.toThrow(ExtractionTimeoutError);
    expect(await waitUntil(() => processGone(id), 6000)).toBe(true);
  }, 15000);

  it('surfaces a non-zero exit as an error, like the text variant', async () => {
    await expect(
      runExtractorBuffer('cat', ['/nonexistent/path/for/test/xyz'], Buffer.from(''), { timeoutMs: 5000 })
    ).rejects.toThrow(/cat exited with code/);
  });
});

describe('env allowlist', () => {
  it('allows exactly OMP_THREAD_LIMIT and TESSDATA_PREFIX', () => {
    expect([...ALLOWED_CHILD_ENV].sort()).toEqual(['OMP_THREAD_LIMIT', 'TESSDATA_PREFIX']);
  });

  it('passes an allowed variable to the child and nothing else from this process', async () => {
    process.env.FILE_SEARCH_TEST_SECRET = 'do-not-leak-me';
    try {
      const out = await runExtractor('node', [ENV_DUMP], Buffer.from('x'), {
        timeoutMs: 5000,
        env: { OMP_THREAD_LIMIT: '1', TESSDATA_PREFIX: '/usr/share/tessdata' },
      });
      expect(JSON.parse(out).OMP_THREAD_LIMIT).toBe('1');
      expect(JSON.parse(out).TESSDATA_PREFIX).toBe('/usr/share/tessdata');
      expect(childEnvKeys(out)).toEqual(['OMP_THREAD_LIMIT', 'TESSDATA_PREFIX']);
    } finally {
      delete process.env.FILE_SEARCH_TEST_SECRET;
    }
  });

  it('works for the Buffer variant too', async () => {
    const out = await runExtractorBuffer('node', [ENV_DUMP], Buffer.from('x'), {
      timeoutMs: 5000,
      env: { OMP_THREAD_LIMIT: '1' },
    });
    expect(childEnvKeys(out.toString('utf8'))).toEqual(['OMP_THREAD_LIMIT']);
  });

  it('keeps the environment empty when no env is given', async () => {
    const out = await runExtractor('node', [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000 });
    expect(childEnvKeys(out)).toEqual([]);
  });

  it.each(['PATH', 'LD_PRELOAD', 'HOME', 'omp_thread_limit', '__proto__'])(
    'throws at the call site for a variable outside the allowlist (%s)',
    (name) => {
      const env = JSON.parse(`{${JSON.stringify(name)}: "x"}`);
      expect(() => runExtractor('node', [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000, env })).toThrow(
        /not allowed/
      );
      expect(() => runExtractorBuffer('node', [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000, env })).toThrow(
        /not allowed/
      );
    }
  );

  it('throws for a non-string or NUL-carrying value', () => {
    expect(() =>
      runExtractor('node', [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000, env: { OMP_THREAD_LIMIT: 1 as any } })
    ).toThrow(/must be a string/);
    expect(() =>
      runExtractor('node', [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000, env: { OMP_THREAD_LIMIT: '1\u0000' } })
    ).toThrow(/must be a string/);
  });
});

describe('lowPriority', () => {
  const parentPriority = os.getPriority();

  it('runs the tool at a lower priority via nice when requested', async () => {
    const out = await runExtractor('node', [PRIORITY], Buffer.from(''), { timeoutMs: 5000, lowPriority: true });
    expect(Number(out)).toBe(Math.min(parentPriority + 10, 19));
  });

  it('leaves the priority unchanged when not requested', async () => {
    const out = await runExtractor('node', [PRIORITY], Buffer.from(''), { timeoutMs: 5000 });
    expect(Number(out)).toBe(parentPriority);
  });

  it('still reports the tool (not nice) in errors and still kills on timeout', async () => {
    const id = marker();
    await expect(
      runExtractor('node', [HANGING, id], Buffer.from('x'), { timeoutMs: 150, lowPriority: true })
    ).rejects.toThrow(/^node timed out/);
    expect(await waitUntil(() => processGone(id), 6000)).toBe(true);
  }, 15000);

  it('runs plainly when nice is not on PATH', async () => {
    // A PATH holding only node: resolveBinary finds the tool but no nice.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-no-nice-'));
    const savedPath = process.env.PATH;
    try {
      fs.symlinkSync(process.execPath, path.join(dir, 'node'));
      process.env.PATH = dir;
      let isolated: typeof import('../../src/fileSearch/extractors/runners') | undefined;
      jest.isolateModules(() => {
        isolated = require('../../src/fileSearch/extractors/runners');
      });
      const out = await isolated!.runExtractor('node', [PRIORITY], Buffer.from(''), {
        timeoutMs: 5000,
        lowPriority: true,
      });
      expect(Number(out)).toBe(parentPriority);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A tool that never reads its stdin and never exits (as a pdftotext waiting for an EOF that never
// comes): the timeout alone must end it, whatever the input size, the output variant or the nice
// wrapper, and the promise must settle at the timeout.
describe('a child that never reads stdin and never exits', () => {
  const BIG = Buffer.alloc(4 * 1024 * 1024, 0x41); // far beyond a pipe buffer: the write never completes
  for (const lowPriority of [false, true]) {
    for (const variant of ['text', 'buffer'] as const) {
      it(`is killed at the timeout (${variant}, lowPriority ${lowPriority})`, async () => {
        const run = variant === 'text' ? runExtractor : runExtractorBuffer;
        const id = marker();
        const started = Date.now();
        await expect(run('node', [STDIN_IGNORING, id], BIG, { timeoutMs: 300, lowPriority })).rejects.toBeInstanceOf(ExtractionTimeoutError);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(await waitUntil(() => processGone(id), 8000)).toBe(true);
      }, 20000);
    }
  }
  it('is killed at the timeout with an empty input too', async () => {
    const id = marker();
    await expect(runExtractor('node', [STDIN_IGNORING, id], Buffer.alloc(0), { timeoutMs: 300 })).rejects.toBeInstanceOf(ExtractionTimeoutError);
    expect(await waitUntil(() => processGone(id), 8000)).toBe(true);
  }, 20000);
});
