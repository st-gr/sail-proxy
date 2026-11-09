/**
 * Structure-chunk thread memory (dev only, not shipped): how much heap the chunker thread needs for
 * the largest file the limits let through, and what the process's RSS does meanwhile. It sizes
 * CHUNKER_RESOURCE_LIMITS in src/fileSearch/structureChunkThread.ts.
 *
 * For each input shape it chunks a synthetic document through chunkStructuredOffThread with the
 * compiled worker (as in dist), samples the process's RSS and main heap every 50 ms, reads the
 * thread's heap when it replies (all chunks alive, before they are copied out; Node 20 has no
 * worker.getHeapStatistics, and the thread's own timers cannot fire while it chunks), and bisects
 * maxOldGenerationSizeMb to the smallest limit that passes (16 MB steps): that limit is the heap
 * the file needs. Each run is its own child process, so one run's garbage never counts in the next.
 *
 *   ts-node -r tsconfig-paths/register --transpile-only scripts/structure-chunk-memory.ts \
 *     [--shapes markdown,paragraph,tiny-sections,nospace] [--mb 32,64] [--two-byte] \
 *     [--max-tokens 100 --overlap 50] [--hi 1024] [--lo 16] [--out results.json]
 *
 * Shapes (each sized to --mb MiB and kept within the 5,000,000-token per-file estimate):
 * - markdown: nested headings six deep, prose, long tables (5,000 rows each) and one giant code
 *   block (an eighth of the document);
 * - paragraph: one paragraph with no line break;
 * - tiny-sections: hundreds of thousands of two-line sections;
 * - nospace: one "word" with no whitespace at all (the estimate counts it as one token).
 * --two-byte adds one character outside Latin-1, so V8 stores the text with two bytes per character.
 * 32 MiB is limits.max_file_bytes for a text upload; 64 MiB is the extractors' output cap (a
 * pandoc or pdftotext text may reach it from a smaller compressed file).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { estimateTokens } from '../src/fileSearch/chunker';
import {
  __configureForTests, __workerForTests, chunkStructuredOffThread, closeStructureChunkThread, StructureChunkOutOfMemoryError,
} from '../src/fileSearch/structureChunkThread';

const MiB = 1024 * 1024;
const MAX_TOKENS_PER_FILE = 5_000_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** A deterministic word of `len` lowercase letters. */
function wordAt(i: number, len: number): string {
  let out = '';
  let x = (i * 2654435761) >>> 0;
  for (let k = 0; k < len; k++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += String.fromCharCode(97 + (x >>> 16) % 26);
  }
  return out;
}

/** Word length scale: raised until the text fits the per-file token estimate (see child). */
let scale = 1;

/** Prose of about `bytes` characters. */
function prose(bytes: number, seed: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const w = wordAt(seed + i, Math.round((7 + (i % 6)) * scale)); // 7–12 letters (× scale) + a space
    parts.push(w);
    size += w.length + 1;
  }
  return parts.join(' ');
}

function build(shape: string, bytes: number): string {
  if (shape === 'nospace') return 'x'.repeat(bytes);
  if (shape === 'paragraph') return prose(bytes, 1);
  if (shape === 'tiny-sections') {
    const parts: string[] = [];
    let size = 0;
    for (let i = 0; size < bytes; i++) {
      const s = `# Section_${String(i).padStart(7, '0')}_${wordAt(i, Math.round(12 * scale))}\n${wordAt(i + 7, Math.round(14 * scale))}\n`;
      parts.push(s);
      size += s.length;
    }
    return parts.join('\n');
  }
  // markdown: an eighth giant code block, then nested chapters with prose and long tables.
  const parts: string[] = ['```js', Array.from({ length: Math.floor(bytes / 8 / 48) }, (_, i) => `const v${i} = compute_${wordAt(i, 10)}(v${i});`).join('\n'), '```'];
  let size = parts[1].length;
  for (let chapter = 0; size < bytes; chapter++) {
    for (let depth = 1; depth <= 6 && size < bytes; depth++) {
      const heading = `${'#'.repeat(depth)} Chapter ${chapter} level ${depth} ${wordAt(chapter * 7 + depth, 9)}`;
      const text = prose(4000, chapter * 1000 + depth);
      parts.push(heading, text);
      size += heading.length + text.length;
      if (depth === 3) {
        const rows = ['| Key | Value | Notes |', '| --- | --- | --- |'];
        for (let r = 0; r < 5000; r++) {
          rows.push(`| k${r}_${wordAt(r, Math.round(9 * scale))} | ${wordAt(r + 3, Math.round(11 * scale))} | ${wordAt(r + 5, Math.round(12 * scale))} |`);
        }
        const table = rows.join('\n');
        parts.push(table);
        size += table.length;
      }
    }
  }
  return parts.join('\n\n').slice(0, bytes);
}

/** The worker compiled to JavaScript, inside node_modules so it resolves gpt-tokenizer as dist does. */
function compileWorker(): string {
  const dir = fs.mkdtempSync(path.join(__dirname, '../node_modules/.cache-chunk-memory-'));
  const src = path.join(__dirname, '../src/fileSearch');
  for (const name of ['structureChunkWorker', 'structureChunker', 'structureScanner']) {
    const out = ts.transpileModule(fs.readFileSync(path.join(src, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    fs.writeFileSync(path.join(dir, `${name}.js`), out.outputText);
  }
  // The real entry, its replies stamped with the thread's heap at that moment.
  fs.writeFileSync(path.join(dir, 'measuredWorker.js'), `const v8 = require('v8');
const { parentPort } = require('worker_threads');
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (msg, transfer) => post(msg && msg.id ? { ...msg, heap: v8.getHeapStatistics() } : msg, transfer);
require('./structureChunkWorker.js');
`);
  return dir;
}

interface RunResult {
  shape: string; mb: number; twoByte: boolean; limitMb: number; ok: boolean; error?: string;
  chars: number; estimatedTokens: number; chunks?: number; elapsedMs: number;
  workerBaselineMb: number; /** The thread's heap when it replied (all chunks alive); 0 when it ran out of memory. */
  workerPeakUsedMb: number; workerPeakTotalMb: number;
  rssBeforeMb: number; rssPeakMb: number; mainHeapPeakMb: number;
}

/** One run in this process (the child side). */
async function child(): Promise<void> {
  const shape = arg('shape', 'markdown');
  const mb = Number(arg('mb', '32'));
  const limitMb = Number(arg('limit', '512'));
  const twoByte = flag('two-byte');
  const opts = { maxTokens: Number(arg('max-tokens', '100')), overlapTokens: Number(arg('overlap', '50')), format: 'markdown' as const };
  __configureForTests({
    entry: path.join(arg('compiled', ''), 'measuredWorker.js'),
    resourceLimits: { maxOldGenerationSizeMb: limitMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  await chunkStructuredOffThread('# warm up\nready', opts);
  const worker = __workerForTests();
  if (!worker) throw new Error('the chunker thread did not start');
  const toMb = (n: number) => Math.round(n / MiB);
  const heaps: Array<{ used_heap_size: number; total_heap_size: number }> = [];
  worker.on('message', (msg: any) => { if (msg?.heap) heaps.push(msg.heap); });
  await chunkStructuredOffThread('# warm up\nagain', opts);
  const baseline = heaps[0] ?? { used_heap_size: 0, total_heap_size: 0 };

  // The largest text the limits let through: the size asked, words lengthened until the estimate fits.
  let text = '';
  let estimatedTokens = Infinity;
  for (scale = 1; estimatedTokens > MAX_TOKENS_PER_FILE; scale *= 1.15) {
    text = build(shape, mb * MiB - (twoByte ? 1 : 0));
    estimatedTokens = estimateTokens(text);
  }
  if (twoByte) text = `€${text}`;

  const peak = { used: baseline.used_heap_size, total: baseline.total_heap_size, rss: 0, main: 0 };
  const rssBefore = process.memoryUsage().rss;
  let sampling = true;
  const sample = async () => {
    while (sampling) {
      const m = process.memoryUsage();
      peak.rss = Math.max(peak.rss, m.rss);
      peak.main = Math.max(peak.main, m.heapUsed);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const sampler = sample();
  const started = Date.now();
  const result: RunResult = {
    shape, mb, twoByte, limitMb, ok: false, chars: text.length, estimatedTokens, elapsedMs: 0,
    workerBaselineMb: toMb(baseline.used_heap_size), workerPeakUsedMb: 0, workerPeakTotalMb: 0,
    rssBeforeMb: toMb(rssBefore), rssPeakMb: 0, mainHeapPeakMb: 0,
  };
  try {
    const chunked = await chunkStructuredOffThread(text, opts, { countDocument: true });
    result.ok = chunked.offThread;
    result.chunks = chunked.chunks.length;
    if (!chunked.offThread) result.error = 'chunked in-process';
  } catch (error) {
    result.error = error instanceof StructureChunkOutOfMemoryError ? 'out of memory' : String((error as Error)?.message ?? error);
  }
  result.elapsedMs = Date.now() - started;
  sampling = false;
  await sampler;
  for (const h of heaps) {
    peak.used = Math.max(peak.used, h.used_heap_size);
    peak.total = Math.max(peak.total, h.total_heap_size);
  }
  Object.assign(result, {
    workerPeakUsedMb: toMb(peak.used), workerPeakTotalMb: toMb(peak.total), rssPeakMb: toMb(peak.rss), mainHeapPeakMb: toMb(peak.main),
  });
  await closeStructureChunkThread();
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

function runChild(compiled: string, shape: string, mb: number, limit: number): RunResult {
  const args = [
    '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', __filename, '--child',
    '--compiled', compiled, '--shape', shape, '--mb', String(mb), '--limit', String(limit),
    '--max-tokens', arg('max-tokens', '100'), '--overlap', arg('overlap', '50'), ...(flag('two-byte') ? ['--two-byte'] : []),
  ];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * MiB, cwd: path.join(__dirname, '..') });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`run ${shape} ${mb} MiB @ ${limit} MB printed no result: ${run.stderr?.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

async function main(): Promise<void> {
  if (flag('child')) { await child(); return; }
  const compiled = compileWorker();
  const shapes = arg('shapes', 'markdown,paragraph,tiny-sections,nospace').split(',');
  const sizes = arg('mb', '32,64').split(',').map(Number);
  const runs: RunResult[] = [];
  const summary: Array<Record<string, unknown>> = [];
  try {
    for (const shape of shapes) {
      for (const mb of sizes) {
        // Bisect: hi passes, lo fails; 16 MB steps.
        let hi = Number(arg('hi', '1024'));
        let lo = Number(arg('lo', '16'));
        const first = runChild(compiled, shape, mb, hi);
        runs.push(first);
        console.log(JSON.stringify(first));
        if (!first.ok) { summary.push({ shape, mb, smallestPassingMb: null, note: `fails at ${hi} MB: ${first.error}` }); continue; }
        let passing = first;
        while (hi - lo > 16) {
          const mid = Math.round((hi + lo) / 2 / 16) * 16;
          const r = runChild(compiled, shape, mb, mid);
          runs.push(r);
          console.log(JSON.stringify(r));
          if (r.ok) { hi = mid; passing = r; } else lo = mid;
        }
        summary.push({
          shape, mb, twoByte: flag('two-byte'), smallestPassingMb: hi, failsAtMb: lo, chars: passing.chars,
          estimatedTokens: passing.estimatedTokens, chunks: passing.chunks, elapsedMs: passing.elapsedMs,
          workerPeakUsedAtHiMb: first.workerPeakUsedMb, rssPeakAtHiMb: first.rssPeakMb, mainHeapPeakAtHiMb: first.mainHeapPeakMb,
        });
      }
    }
  } finally {
    fs.rmSync(compiled, { recursive: true, force: true });
  }
  console.table(summary);
  const out = arg('out', '');
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, runs }, null, 2));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
