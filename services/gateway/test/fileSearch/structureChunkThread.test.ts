// The structure chunker run in its worker thread: the same chunks as in-process,
// each chunk's document offset, the main event loop free while a large file is
// chunked, and a timeout that stops the thread without breaking the next call.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { getDefaultLogger } from '@libs/logger';
import { chunkStructured, countTokens } from '../../src/fileSearch/structureChunker';
import {
  CHUNKER_RESOURCE_LIMITS, chunkerHeapLimitMb, chunkStructuredOffThread, closeStructureChunkThread, IN_PROCESS_MAX_CHARS,
  StructureChunkOutOfMemoryError, StructureChunkThreadUnavailableError, StructureChunkTimeoutError, __configureForTests,
} from '../../src/fileSearch/structureChunkThread';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The slowest 1 MB shape (~1.4 s): long enough to be in the thread while others queue.
const SLOW = '\u00a0\u200b x'.repeat(250_000);

const DOC = [
  '# Guide',
  'Intro paragraph about the gateway and what it does for its users, with enough words to count.',
  '## Install',
  ...Array.from({ length: 40 }, (_, i) => `Step ${i}: run the installer and check the output of step ${i} carefully.\n`),
  '## Ports',
  '| Port | Service |',
  '| --- | --- |',
  ...Array.from({ length: 80 }, (_, i) => `| ${8000 + i} | service-${i} |`),
  '## Repeated',
  'Same sentence. Same sentence. Same sentence.',
  '## Repeated again',
  'Same sentence. Same sentence. Same sentence.',
].join('\n');

const OPTS = { maxTokens: 200, overlapTokens: 50, format: 'markdown' as const };

describe('chunkStructuredOffThread', () => {
  afterAll(async () => {
    await closeStructureChunkThread();
    __configureForTests({ entry: null, startBackoffMs: 1000 });
  });

  it('returns exactly the in-process chunks, each placed at its document offset', async () => {
    const result = await chunkStructuredOffThread(DOC, OPTS, { countDocument: true });
    expect(result.offThread).toBe(true);
    expect(result.chunks).toEqual(chunkStructured(DOC, OPTS));
    expect(result.starts).toHaveLength(result.chunks.length);
    result.chunks.forEach((c, i) => expect(DOC.startsWith(c.text, result.starts[i])).toBe(true));
    // Repeated text: the two identical sections are told apart by their offsets.
    const repeated = result.chunks.filter((c) => c.text.includes('Same sentence.'));
    expect(new Set(repeated.map((c) => result.starts[result.chunks.indexOf(c)])).size).toBe(repeated.length);
    expect(result.documentTokens).toBe(countTokens(DOC));
  }, 60_000);

  it('leaves the event loop free while a 1 MB file is chunked', async () => {
    await chunkStructuredOffThread('warm up', OPTS); // thread started and compiled
    // 1 MB of a no-break-space / zero-width-space mix, the chunker's slowest shape
    // (~1.4 s in-process on an idle machine, blocking the event loop for all of it).
    const big = '\u00a0\u200b x'.repeat(250_000);
    let ticks = 0;
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks += 1;
    }, 5);
    const started = Date.now();
    const result = await chunkStructuredOffThread(big, { maxTokens: 800, overlapTokens: 400, format: 'markdown' });
    const wall = Date.now() - started;
    clearInterval(timer);
    expect(result.offThread).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(10);
    // In-process, the timer could not fire once during the call. Off-thread it keeps firing.
    expect(ticks).toBeGreaterThan(Math.min(10, wall / 20));
    expect(maxGap).toBeLessThan(Math.max(250, wall / 2));
  }, 120_000);

  it('a timeout fails only that file; the files queued behind it go to a fresh thread', async () => {
    const results = await Promise.allSettled([
      chunkStructuredOffThread(SLOW, { maxTokens: 800, overlapTokens: 0, format: 'plain' }, { timeoutMs: 50 }),
      chunkStructuredOffThread(DOC, OPTS, { timeoutMs: 30_000 }),
      chunkStructuredOffThread(DOC, OPTS),
    ]);
    expect(results[0].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(StructureChunkTimeoutError);
    for (const r of results.slice(1)) {
      expect(r.status).toBe('fulfilled');
      expect((r as PromiseFulfilledResult<any>).value.offThread).toBe(true);
      expect((r as PromiseFulfilledResult<any>).value.chunks).toEqual(chunkStructured(DOC, OPTS));
    }
  }, 60_000);

  it('a file\'s time limit starts when the thread takes it, not while it waits behind another', async () => {
    await chunkStructuredOffThread('warm up', OPTS);
    const started = Date.now();
    const [slow, waiting] = await Promise.all([
      chunkStructuredOffThread(SLOW, { maxTokens: 800, overlapTokens: 0, format: 'plain' }),
      chunkStructuredOffThread(DOC, OPTS, { timeoutMs: 300 }),
    ]);
    expect(slow.offThread).toBe(true);
    expect(waiting.offThread).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(300); // it waited longer than its own limit
  }, 60_000);

  it('an invalid option rejects with the chunker\'s message, and the thread stays usable', async () => {
    await expect(chunkStructuredOffThread(DOC, { ...OPTS, maxTokens: 3 })).rejects.toThrow(/maxTokens/);
    const after = await chunkStructuredOffThread(DOC, OPTS);
    expect(after.offThread).toBe(true);
  }, 60_000);
});

describe('when the chunker thread cannot start', () => {
  let tmp: string;
  let compiled: string;

  // Created here, not at collection time, so a run filtered with -t leaves nothing behind.
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-thread-'));
    // Inside node_modules, so the compiled chunker resolves gpt-tokenizer as it does in dist.
    compiled = fs.mkdtempSync(path.join(__dirname, '../../node_modules/.cache-chunk-worker-'));
    const src = path.join(__dirname, '../../src/fileSearch');
    for (const name of ['structureChunkWorker', 'structureChunker', 'structureScanner']) {
      const out = ts.transpileModule(fs.readFileSync(path.join(src, `${name}.ts`), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      });
      fs.writeFileSync(path.join(compiled, `${name}.js`), out.outputText);
    }
  });
  beforeEach(async () => {
    await closeStructureChunkThread();
    __configureForTests({ resourceLimits: CHUNKER_RESOURCE_LIMITS });
  });
  afterAll(async () => {
    await closeStructureChunkThread();
    __configureForTests({ entry: null, startBackoffMs: 1000, readyTimeoutMs: 30_000, resourceLimits: CHUNKER_RESOURCE_LIMITS });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(compiled, { recursive: true, force: true });
  });

  it('a missing entry file: every file is chunked in-process, with one warning', async () => {
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    __configureForTests({ entry: path.join(tmp, 'missing.js') });
    const first = await chunkStructuredOffThread(DOC, OPTS);
    const second = await chunkStructuredOffThread(DOC, OPTS, { countDocument: true });
    expect([first.offThread, second.offThread]).toEqual([false, false]);
    expect(first.chunks).toEqual(chunkStructured(DOC, OPTS));
    expect(second.documentTokens).toBe(countTokens(DOC));
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('missing'))).toHaveLength(1);
  });

  it('without a thread, a text over the in-process limit is refused as transient instead of chunked on the event loop', async () => {
    __configureForTests({ entry: path.join(tmp, 'missing.js') });
    const over = 'word '.repeat(Math.ceil((IN_PROCESS_MAX_CHARS + 1) / 5));
    const err = await chunkStructuredOffThread(over, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(StructureChunkThreadUnavailableError);
    expect(err.message).toMatch(/chunker thread is not available/);
    const under = await chunkStructuredOffThread(DOC, OPTS); // small texts still chunk in-process
    expect(under.offThread).toBe(false);
    expect(IN_PROCESS_MAX_CHARS).toBe(2 * 1024 * 1024);
  });

  it('a thread that runs out of memory before it is ready fails the file it holds as out of memory (permanent)', async () => {
    const entry = path.join(tmp, 'hog.js');
    fs.writeFileSync(entry, 'const keep = []; for (;;) keep.push(new Array(100000).fill(1.5));\n');
    __configureForTests({ entry, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 } });
    const err = await chunkStructuredOffThread(DOC, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(StructureChunkOutOfMemoryError);
    expect(err.message).toBe('Chunking the file needs more memory than the chunker may use (16 MB)');
  }, 60_000);

  it('the compiled JavaScript worker (as in dist) runs off-thread', async () => {
    __configureForTests({ entry: path.join(compiled, 'structureChunkWorker.js') });
    const result = await chunkStructuredOffThread(DOC, OPTS, { countDocument: true });
    expect(result.offThread).toBe(true);
    expect(result.chunks).toEqual(chunkStructured(DOC, OPTS));
    expect(result.documentTokens).toBe(countTokens(DOC));
  }, 60_000);

  it('a file over the heap limit fails permanently, naming the limit; the files behind it go to a fresh thread', async () => {
    __configureForTests({
      entry: path.join(compiled, 'structureChunkWorker.js'), resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 },
    });
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    warn.mockClear();
    // ~10 MB of two-line sections: the scan's per-line and per-section objects need ~17 MB of heap a MB.
    const big = Array.from({ length: 400_000 }, (_, i) => `# Section ${i}\nalpha_beta_${i}\n`).join('\n');
    const [over, behind] = await Promise.allSettled([
      chunkStructuredOffThread(big, { maxTokens: 100, overlapTokens: 50, format: 'markdown' }, { countDocument: true }),
      chunkStructuredOffThread(DOC, OPTS),
    ]);
    expect(over.status).toBe('rejected');
    const err = (over as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StructureChunkOutOfMemoryError);
    expect(err.message).toBe('Chunking the file needs more memory than the chunker may use (64 MB)');
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('more memory than the chunker thread may use (64 MB)'))).toHaveLength(1);
    expect(behind.status).toBe('fulfilled');
    expect((behind as PromiseFulfilledResult<any>).value.offThread).toBe(true); // a fresh thread, not in-process
    expect((behind as PromiseFulfilledResult<any>).value.chunks).toEqual(chunkStructured(DOC, OPTS));
  }, 120_000);

  it('an entry that fails while loading (Node says "online" first): files run in-process; a start is retried after a back-off', async () => {
    const entry = path.join(tmp, 'entry.js');
    fs.writeFileSync(entry, "throw new Error('cannot load the chunker');\n");
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    __configureForTests({ entry, startBackoffMs: 300 });
    const [a, b] = await Promise.all([chunkStructuredOffThread(DOC, OPTS, { timeoutMs: 5000 }), chunkStructuredOffThread(DOC, OPTS)]);
    expect([a.offThread, b.offThread]).toEqual([false, false]);
    expect(a.chunks).toEqual(chunkStructured(DOC, OPTS));
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('could not start'))).toHaveLength(1);

    // The cause goes away: within the back-off still in-process, after it the thread runs again.
    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(compiled, 'structureChunkWorker.js'))});\n`);
    expect((await chunkStructuredOffThread(DOC, OPTS)).offThread).toBe(false);
    await sleep(400);
    const later = await chunkStructuredOffThread(DOC, OPTS);
    expect(later.offThread).toBe(true);
    expect(later.chunks).toEqual(chunkStructured(DOC, OPTS));
  }, 60_000);

  it('a thread that never says ready is a failed start: stopped, its file in-process, a start retried after a back-off', async () => {
    const entry = path.join(tmp, 'silent.js');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);\n'); // alive, never posts ready
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    warn.mockClear();
    __configureForTests({ entry, startBackoffMs: 300, readyTimeoutMs: 200 });
    const started = Date.now();
    const [a, b] = await Promise.all([chunkStructuredOffThread(DOC, OPTS, { timeoutMs: 100 }), chunkStructuredOffThread(DOC, OPTS)]);
    expect([a.offThread, b.offThread]).toEqual([false, false]);
    expect(a.chunks).toEqual(chunkStructured(DOC, OPTS));
    expect(Date.now() - started).toBeGreaterThanOrEqual(190); // waited for the ready limit, not the file's own 100 ms
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('did not become ready'))).toHaveLength(1);

    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(compiled, 'structureChunkWorker.js'))});\n`);
    expect((await chunkStructuredOffThread(DOC, OPTS)).offThread).toBe(false); // within the back-off
    await sleep(400);
    __configureForTests({ readyTimeoutMs: 30_000 });
    const later = await chunkStructuredOffThread(DOC, OPTS);
    expect(later.offThread).toBe(true);
  }, 60_000);
});

describe('the chunker thread\'s heap', () => {
  const GiB = 1024 ** 3;

  it('a fifth of the process\'s memory limit, between 256 and 384 MB; 384 when none is known', () => {
    expect(chunkerHeapLimitMb(2 * GiB)).toBe(384);
    expect(chunkerHeapLimitMb(1.5 * GiB)).toBe(307);
    expect(chunkerHeapLimitMb(1 * GiB)).toBe(256);
    expect(chunkerHeapLimitMb(512 * 1024 ** 2)).toBe(256);
    expect(chunkerHeapLimitMb(64 * GiB)).toBe(384);
    expect(chunkerHeapLimitMb(0)).toBe(384);
    expect(chunkerHeapLimitMb(2 ** 64)).toBe(384); // how some Node versions report "no limit"
    expect(CHUNKER_RESOURCE_LIMITS).toEqual({ maxOldGenerationSizeMb: chunkerHeapLimitMb(), maxYoungGenerationSizeMb: 32, stackSizeMb: 4 });
  });
});
