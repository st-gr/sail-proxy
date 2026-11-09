// The Office reader's worker thread: files are read off the event loop, a file past its hard time
// limit stops the thread (the gateway's loop stays free), a file over the heap limit fails
// permanently, and a missing or broken entry file falls back to reading in-process.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { Worker } from 'worker_threads';
import { getDefaultLogger } from '@libs/logger';
import {
  __configureForTests, __lastRunOnThread, closeOfficeReaderThread, readOfficeOffThread, READER_RESOURCE_LIMITS, readerHeapLimitMb,
} from '../../src/fileSearch/extractors/ooxml/ooxmlThread';
import { readPptx } from '../../src/fileSearch/extractors/ooxml/pptx';
import { DocumentReadError } from '../../src/fileSearch/extractors/ooxml/limits';
import { ExtractionTimeoutError } from '../../src/fileSearch/extractors/runners';
import { pptx, xlsx } from './fixtures/ooxmlFixtures';

const DECK = pptx([{ shapes: [{ title: 'T' }, { text: ['body'] }], notes: ['n'] }]);

/** Runs `work` while a 1 ms interval measures the longest gap between its ticks. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ stallMs: number; result: T | Error }> {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  let result: T | Error;
  try {
    result = await work();
  } catch (error: any) {
    result = error;
  } finally {
    clearInterval(timer);
  }
  return { stallMs: worst, result };
}

let tmp: string;
let compiled: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-thread-'));
  // The reader compiled to JavaScript in its dist layout (extractors/ooxml/*.js beside ../runners.js).
  compiled = fs.mkdtempSync(path.join(__dirname, '../../node_modules/.cache-office-worker-'));
  const src = path.join(__dirname, '../../src/fileSearch/extractors');
  fs.mkdirSync(path.join(compiled, 'ooxml'));
  const files = ['runners', ...fs.readdirSync(path.join(src, 'ooxml')).filter((f) => f.endsWith('.ts')).map((f) => `ooxml/${f.slice(0, -3)}`)];
  for (const name of files) {
    const out = ts.transpileModule(fs.readFileSync(path.join(src, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    fs.writeFileSync(path.join(compiled, `${name}.js`), out.outputText);
  }
});

beforeEach(async () => {
  await closeOfficeReaderThread();
  __configureForTests({ entry: null, startBackoffMs: 1000, readyTimeoutMs: 30_000, resourceLimits: READER_RESOURCE_LIMITS });
});

afterAll(async () => {
  await closeOfficeReaderThread();
  __configureForTests({ entry: null, startBackoffMs: 1000, readyTimeoutMs: 30_000, resourceLimits: READER_RESOURCE_LIMITS });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(compiled, { recursive: true, force: true });
});

describe('the reader thread', () => {
  it('reads in the thread exactly like in-process; the caller\'s buffer stays usable', async () => {
    const text = await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    expect(__lastRunOnThread()).toBe(true);
    expect(text).toBe(await readPptx(DECK, {}));
    expect(DECK.length).toBeGreaterThan(0); // not detached by the transfer
    expect(await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 })).toBe(text);
  }, 60_000);

  it('a read error comes back as the same permanent DocumentReadError', async () => {
    const err = await readOfficeOffThread('xlsx', Buffer.from('not a zip'), { timeoutMs: 30_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentReadError);
    expect(err.message).toBe('Could not read the Excel file: it is not a valid zip archive');
    expect(__lastRunOnThread()).toBe(true);
  }, 60_000);

  it('the compiled JavaScript worker (as in dist) runs off-thread', async () => {
    __configureForTests({ entry: path.join(compiled, 'ooxml', 'ooxmlWorker.js') });
    const text = await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    expect(__lastRunOnThread()).toBe(true);
    expect(text).toBe(await readPptx(DECK, {}));
  }, 60_000);

  it('a file that never finishes is stopped at the hard limit, the event loop stays free, the next file gets a fresh thread', async () => {
    const entry = path.join(tmp, 'spin.js');
    // Reads like the real worker, but spins forever on a file named by its first byte 'S'.
    fs.writeFileSync(entry, `const { parentPort } = require('worker_threads');
const real = require(${JSON.stringify(path.join(compiled, 'ooxml', 'pptx.js'))});
parentPort.on('message', async (r) => {
  if (new Uint8Array(r.bytes)[0] === 83) for (;;) {}
  parentPort.postMessage({ ok: true, text: await real.readPptx(Buffer.from(r.bytes), {}), elapsedMs: 0 });
});
parentPort.postMessage({ ready: true });
`);
    __configureForTests({ entry });
    await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 }); // started and ready
    const started = Date.now();
    const { stallMs, result } = await longestStall(() => readOfficeOffThread('pptx', Buffer.from('S'), { timeoutMs: 500 }));
    expect(result).toBeInstanceOf(ExtractionTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 500 ms + the 1 s grace
    // On the main thread the spin would block the loop for the whole 1.4 s; 1 s leaves room for a loaded CI runner.
    expect(stallMs).toBeLessThan(1000);
    expect(await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 })).toBe(await readPptx(DECK, {}));
    expect(__lastRunOnThread()).toBe(true);
  }, 60_000);

  it('a terminate that never settles does not park the queue: the next file is read after the bounded wait', async () => {
    const entry = path.join(tmp, 'spin2.js');
    fs.writeFileSync(entry, `const { parentPort } = require('worker_threads');
const real = require(${JSON.stringify(path.join(compiled, 'ooxml', 'pptx.js'))});
parentPort.on('message', async (r) => {
  if (new Uint8Array(r.bytes)[0] === 83) for (;;) {}
  parentPort.postMessage({ ok: true, text: await real.readPptx(Buffer.from(r.bytes), {}), elapsedMs: 0 });
});
parentPort.postMessage({ ready: true });
`);
    __configureForTests({ entry, terminateWaitMs: 300 });
    await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    const real = Worker.prototype.terminate;
    const spy = jest.spyOn(Worker.prototype, 'terminate').mockImplementationOnce(function (this: Worker) {
      void real.call(this); // the thread does end, but the promise never tells
      return new Promise<number>(() => undefined);
    });
    try {
      const stuck = readOfficeOffThread('pptx', Buffer.from('S'), { timeoutMs: 200 }).catch((e) => e);
      const next = readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
      expect(await stuck).toBeInstanceOf(ExtractionTimeoutError);
      expect(await next).toBe(await readPptx(DECK, {}));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('a crafted file that runs past the reader\'s own time limit fails as a timeout without stalling the gateway', async () => {
    // Millions of line breaks in one paragraph: about a second of work for the reader.
    const { slideXml, pptxEntries, withEntry, zip } = jest.requireActual('./fixtures/ooxmlFixtures');
    const sp = `<p:sp><p:txBody><a:p>${'<a:br/>'.repeat(3_000_000)}<a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`;
    const bytes = zip(withEntry(pptxEntries([{ shapes: [] }]), {
      name: 'ppt/slides/slide1.xml', data: slideXml({ shapes: [] }).replace('</p:spTree>', `${sp}</p:spTree>`),
    }));
    await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    const { stallMs, result } = await longestStall(() => readOfficeOffThread('pptx', bytes, { timeoutMs: 200, limits: { maxRatio: 1e6 } }));
    expect(result).toBeInstanceOf(ExtractionTimeoutError);
    // The ceiling the other event-loop tests use: generous for a loaded CI runner, far below a read on the main thread.
    expect(stallMs).toBeLessThan(1000);
  }, 60_000);

  it('a file over the heap limit fails permanently and the gateway lives on', async () => {
    __configureForTests({ resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 } });
    const rows = Array.from({ length: 60_000 }, (_, i) => [i, `Customer ${i} ${'x'.repeat(40)}`, i * 1.5]);
    const err = await readOfficeOffThread('xlsx', xlsx([{ name: 'S', rows }]), { timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentReadError);
    expect(err.message).toMatch(/needs more memory than the reader may use \(24 MB\)/);
    __configureForTests({ resourceLimits: READER_RESOURCE_LIMITS });
    expect(await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 })).toBe(await readPptx(DECK, {}));
  }, 60_000);
});

describe('the reader thread\'s heap', () => {
  const GiB = 1024 ** 3;

  it('a fifth of the process\'s memory limit, between 256 and 384 MB; 384 when none is known', () => {
    expect(readerHeapLimitMb(2 * GiB)).toBe(384);
    expect(readerHeapLimitMb(1.5 * GiB)).toBe(307);
    expect(readerHeapLimitMb(1 * GiB)).toBe(256);
    expect(readerHeapLimitMb(512 * 1024 ** 2)).toBe(256);
    expect(readerHeapLimitMb(64 * GiB)).toBe(384);
    expect(readerHeapLimitMb(0)).toBe(384);
    expect(readerHeapLimitMb(2 ** 64)).toBe(384); // how some Node versions report "no limit"
    expect(READER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(readerHeapLimitMb());
    expect(READER_RESOURCE_LIMITS.maxYoungGenerationSizeMb).toBe(32);
  });

  it('the heaviest plausible workbook (500 000 cells, all distinct strings) reads at the 256 MB floor', async () => {
    // 56-character strings keep the text (~30 Mi characters) under the 32 Mi output cap.
    let seed = 1;
    const str = (): string => {
      let out = '';
      while (out.length < 56) { seed = (seed * 48271) % 2147483647; out += seed.toString(36); }
      return out.slice(0, 56);
    };
    const rows = Array.from({ length: 125_000 }, () => [str(), str(), str(), str()]);
    const bytes = xlsx([{ name: 'S', rows }]);
    __configureForTests({ resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    const text = await readOfficeOffThread('xlsx', bytes, { timeoutMs: 120_000 });
    expect(__lastRunOnThread()).toBe(true);
    expect(text.split('\n')).toHaveLength(125_000 + 4);
  }, 180_000);
});

describe('closing the reader', () => {
  it('rejects the file being read and every queued file', async () => {
    const entry = path.join(tmp, 'spin-all.js');
    fs.writeFileSync(entry, `const { parentPort } = require('worker_threads');
parentPort.on('message', () => { for (;;) {} });
parentPort.postMessage({ ready: true });
`);
    __configureForTests({ entry });
    const reads = [1, 2, 3].map(() => readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 }).catch((e) => e));
    await new Promise((r) => setTimeout(r, 300));
    await closeOfficeReaderThread();
    for (const err of await Promise.all(reads)) expect(err.message).toBe('The Office reader was closed');
  }, 60_000);
});

describe('when the reader thread cannot start', () => {
  it('a missing entry file: read in-process, with one warning', async () => {
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    __configureForTests({ entry: path.join(tmp, 'missing.js') });
    const first = await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    expect(__lastRunOnThread()).toBe(false);
    await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    expect(first).toBe(await readPptx(DECK, {}));
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('missing'))).toHaveLength(1);
  });

  it('an entry that fails while loading: in-process, and a start is retried after the back-off', async () => {
    const entry = path.join(tmp, 'broken.js');
    fs.writeFileSync(entry, "throw new Error('cannot load the reader');\n");
    __configureForTests({ entry, startBackoffMs: 300 });
    expect(await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 })).toBe(await readPptx(DECK, {}));
    expect(__lastRunOnThread()).toBe(false);
    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(compiled, 'ooxml', 'ooxmlWorker.js'))});\n`);
    await new Promise((r) => setTimeout(r, 400));
    await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 });
    expect(__lastRunOnThread()).toBe(true);
  }, 60_000);

  it('a thread that never says ready: its file is read in-process', async () => {
    const entry = path.join(tmp, 'silent.js');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
    __configureForTests({ entry, readyTimeoutMs: 200 });
    expect(await readOfficeOffThread('pptx', DECK, { timeoutMs: 30_000 })).toBe(await readPptx(DECK, {}));
    expect(__lastRunOnThread()).toBe(false);
  }, 60_000);
});
