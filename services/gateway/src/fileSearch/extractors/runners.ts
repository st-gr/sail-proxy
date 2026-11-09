// Runs external text-extraction tools (pandoc, pdftotext, antiword) against untrusted,
// user-uploaded document bytes. This module owns every process-safety concern:
// PATH resolution done ourselves (so the child can be spawned with an empty
// environment), feeding bytes on stdin instead of via a temp file (except for a
// tool that must seek in its input: runExtractorOnFile), a wall-clock
// timeout that kills the whole process group (escalating to SIGKILL if the
// tool ignores SIGTERM), and a hard cap on captured stdout so a decompression
// bomb can't exhaust memory. No shell is ever involved: spawn() always gets an
// argv array, never a command string.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The only variables a caller may hand to the child. Everything else —
// PATH, credentials, LD_PRELOAD — stays out: the environment is otherwise
// empty (see resolveBinary). OMP_THREAD_LIMIT keeps tesseract on one core;
// TESSDATA_PREFIX is for a deployment whose language data is not where the
// tesseract build expects it.
export const ALLOWED_CHILD_ENV = ['OMP_THREAD_LIMIT', 'TESSDATA_PREFIX'] as const;
export type AllowedChildEnvName = (typeof ALLOWED_CHILD_ENV)[number];

export interface RunOptions {
  /** Wall-clock budget for the whole run, in milliseconds. */
  timeoutMs: number;
  /** Hard cap on captured stdout bytes. Defaults to DEFAULT_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
  /**
   * Variables to set in the child's otherwise empty environment. Only names
   * in ALLOWED_CHILD_ENV are accepted; anything else throws synchronously at
   * the call site (a programming error, not a document failure).
   */
  env?: Partial<Record<AllowedChildEnvName, string>>;
  /**
   * Run the tool via `nice -n 10` so request handling wins the CPU. `nice` is
   * resolved from this process's PATH like the tool itself; where it is not
   * available (e.g. Windows) the tool runs at normal priority.
   */
  lowPriority?: boolean;
}

// Niceness increment for lowPriority runs.
const LOW_PRIORITY_NICENESS = '10';

// A generous multiple of the largest file_search upload (32 MiB, see
// FILE_SEARCH_DEFAULTS.limits.maxFileBytes in configService.ts) so no
// legitimate document's extracted text is ever truncated, while still
// bounding how much memory a hostile zip/pdf decompression bomb can claim.
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// How long we give a tool to exit after SIGTERM before we escalate to
// SIGKILL. A tool that traps or ignores SIGTERM must not be able to hang the
// extraction pipeline forever.
const KILL_ESCALATION_MS = 3000;

// Stderr is only used to build a human-readable error message, never
// returned to the caller as extracted text — cap it independently and small.
const MAX_STDERR_BYTES = 64 * 1024;

// Bounds how much of that captured stderr is ever embedded into the
// rejected Error's message (and therefore reaches ingestWorker.ts's
// last_error column and error log). MAX_STDERR_BYTES above bounds memory
// during capture, not what's safe to surface in an error: pandoc/pdftotext
// error output can legitimately quote fragments of the document being
// parsed (e.g. "unexpected token near: <excerpt>"), so unlike this module's
// own diagnostics, stderr is not guaranteed free of document content —
// truncate hard and strip control characters (same reasoning as
// extractors/registry.ts's sanitizeExtensionForDisplay).
const MAX_STDERR_IN_ERROR_MESSAGE = 200;

function sanitizeStderrForError(rawStderr: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = rawStderr.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return stripped.length > MAX_STDERR_IN_ERROR_MESSAGE
    ? `${stripped.slice(0, MAX_STDERR_IN_ERROR_MESSAGE)}… [truncated]`
    : stripped;
}

export class ExtractionTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`${cmd} timed out after ${timeoutMs}ms and was killed`);
    this.name = 'ExtractionTimeoutError';
  }
}

export class ExtractionOutputTooLargeError extends Error {
  constructor(cmd: string, capBytes: number) {
    super(`${cmd} output exceeded the ${capBytes}-byte cap and was aborted`);
    this.name = 'ExtractionOutputTooLargeError';
  }
}

/** The tool ran and exited non-zero (it refused or failed on the input). Its `name` stays
 *  'Error', as before this class: a failed file's stored and returned last_error carries it. */
export class ExtractorExitError extends Error {
  constructor(cmd: string, readonly exitCode: number | null, stderrText: string) {
    super(`${cmd} exited with code ${exitCode}${stderrText ? `: ${stderrText}` : ''}`);
  }
}

const binaryPathCache = new Map<string, string>();

/**
 * Resolve `name` to an absolute path by scanning *this* process's PATH.
 *
 * The extractor subprocess is spawned with env: {} — no PATH, no credentials,
 * nothing inherited from the gateway's own environment — because it is about
 * to parse a hostile document. Node's spawn() does its executable lookup
 * using the *child's* env, so if we simply passed a bare command name like
 * "pandoc" alongside env: {}, the spawn would fail with ENOENT: there would
 * be no PATH for it to search. Doing the lookup here, in our own process
 * (which still has its real PATH), and handing spawn() only the resolved
 * absolute path, gets us both properties at once: the tool is found, and the
 * child never sees a PATH — or any other environment variable — at all.
 */
export function resolveBinary(name: string): string {
  const cached = binaryPathCache.get(name);
  if (cached) return cached;

  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        binaryPathCache.set(name, candidate);
        return candidate;
      }
    } catch {
      // Not in this directory; keep scanning.
    }
  }
  throw new Error(`Required extraction tool "${name}" was not found on PATH`);
}

/** Validate opts.env against ALLOWED_CHILD_ENV and copy it; throws on anything else. */
function buildChildEnv(env: RunOptions['env']): Record<string, string> {
  const childEnv: Record<string, string> = {};
  if (env == null) return childEnv;
  for (const name of Object.keys(env)) {
    if (!(ALLOWED_CHILD_ENV as readonly string[]).includes(name)) {
      throw new Error(`Environment variable "${name}" is not allowed for extractor processes`);
    }
    const value = (env as Record<string, unknown>)[name];
    if (typeof value !== 'string' || value.includes('\u0000')) {
      throw new Error(`Environment variable "${name}" must be a string without NUL characters`);
    }
    childEnv[name] = value;
  }
  return childEnv;
}

/** `nice`'s absolute path, or null where the platform has none on PATH. */
function resolveNice(): string | null {
  try {
    return resolveBinary('nice');
  } catch {
    return null;
  }
}

/**
 * Whether low-priority runs get `nice`; without it they run at normal priority. Said once by
 * ocrAvailability.ts: this module stays free of the logger, since the OOXML worker thread loads it
 * and the thread cannot resolve the `@libs` alias.
 */
export function niceAvailable(): boolean {
  return resolveNice() !== null;
}

/**
 * Run `binaryName args…`, feeding `input` on stdin and capturing stdout as
 * text. Never touches disk, never uses a shell, never inherits this
 * process's environment.
 *
 * Throws synchronously (before spawning) if opts.env names a variable
 * outside ALLOWED_CHILD_ENV.
 */
export function runExtractor(
  binaryName: string,
  args: string[],
  input: Buffer,
  opts: RunOptions
): Promise<string> {
  return runToBuffer(binaryName, args, input, opts).then((out) => out.toString('utf8'));
}

/**
 * Same as runExtractor, but resolves stdout as raw bytes (e.g. PNG pages from
 * pdftoppm). Same timeout, kill, output-cap and environment rules; stdin
 * takes any bytes.
 */
export function runExtractorBuffer(
  binaryName: string,
  args: string[],
  input: Buffer,
  opts: RunOptions
): Promise<Buffer> {
  return runToBuffer(binaryName, args, input, opts);
}

/** Name prefix of the private directories runExtractorOnFile creates under os.tmpdir(). */
const EXTRACT_DIR_PREFIX = 'fs-extract-';

/**
 * Removes the `fs-extract-*` directories under `baseDir` (os.tmpdir()) that a gateway killed
 * mid-run left behind, once they are older than `minAgeMs` — the extraction timeout, so a run
 * still alive (this gateway's or another's on the same host) is never touched. Only real
 * directories owned by this user are removed (lstat: a symlink is skipped, never followed).
 * Returns how many were removed; never throws on a single entry.
 */
export async function sweepStaleExtractDirs(minAgeMs: number, baseDir: string = os.tmpdir()): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(baseDir);
  } catch {
    return 0;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const cutoff = Date.now() - minAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(EXTRACT_DIR_PREFIX)) continue;
    const full = path.join(baseDir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const st = await fs.promises.lstat(full);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid) || st.mtimeMs > cutoff) continue;
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return removed;
}

/**
 * Same as runExtractor, for a tool that cannot read stdin (it seeks in its input): `input` is
 * written to a fresh private directory (mkdtemp, mode 0700; the file 0600, under a fixed name —
 * never the upload's) whose path is appended to `args`, and the directory is removed once the run
 * settles. stdin is empty. Same timeout, kill, output-cap and environment rules.
 */
export async function runExtractorOnFile(
  binaryName: string,
  args: string[],
  input: Buffer,
  opts: RunOptions
): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), EXTRACT_DIR_PREFIX));
  try {
    const file = path.join(dir, 'input');
    await fs.promises.writeFile(file, input, { mode: 0o600, flag: 'wx' });
    return await runExtractor(binaryName, [...args, file], Buffer.alloc(0), opts);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function runToBuffer(
  binaryName: string,
  args: string[],
  input: Buffer,
  opts: RunOptions
): Promise<Buffer> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const childEnv = buildChildEnv(opts.env);

  return new Promise((resolve, reject) => {
    let binaryPath: string;
    try {
      binaryPath = resolveBinary(binaryName);
    } catch (err) {
      reject(err);
      return;
    }

    // `nice -n 10 /abs/tool args…`: nice execs the tool in place, so the
    // process group (and the group kill below) is unchanged; the tool is
    // passed by absolute path because the child has no PATH to search.
    const nicePath = opts.lowPriority ? resolveNice() : null;
    const command = nicePath ?? binaryPath;
    const argv = nicePath ? ['-n', LOW_PRIORITY_NICENESS, binaryPath, ...args] : args;

    const child = spawn(command, argv, {
      env: childEnv, // no credentials, no PATH — see resolveBinary's doc comment; only ALLOWED_CHILD_ENV
      // An untrusted document must not be parsed from a directory the child
      // can read the gateway out of. os.tmpdir() is the narrowest choice
      // that always exists; the child needs no files from disk — input
      // arrives on stdin and output leaves on stdout, per this module's own
      // doc comment above.
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // never build a shell command string
      detached: true, // own process group, so timeout/cap kills any children the tool spawns too
    });

    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
    let killEscalationTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        // Negative pid == "the whole process group" (requires detached: true).
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone; nothing left to kill.
        }
      }
    };

    const startKillEscalation = () => {
      killGroup('SIGTERM');
      killEscalationTimer = setTimeout(() => killGroup('SIGKILL'), KILL_ESCALATION_MS);
    };

    // Settling the returned promise and reaping the process tree are
    // deliberately independent. Waiting for the child's 'close' event to
    // settle would let a hostile tool defeat the timeout entirely: a
    // "parser" that spawns a detached grandchild inheriting fd 1/2 and then
    // exits itself never fires 'close' on the immediate child — the pipe's
    // write end stays open for as long as the grandchild (which has escaped
    // into its own process group and so survives our group-kill) holds it.
    // So `settle` below rejects/resolves the promise exactly once, from
    // whichever source acts first — the timeout, the output cap, or a
    // genuine 'close' — while startKillEscalation/killGroup keep running
    // independently of whether the promise has already settled, so the
    // reachable part of the process tree is still reaped.
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Detach our side of the pipes once we've decided to reject on our own
    // authority (timeout or output cap) rather than wait on 'close': stop
    // buffering data that will never be used, and release our own fds
    // immediately instead of holding them open for the kill-escalation
    // grace period (or forever, if a descendant is still holding the other
    // end open).
    const detachStreams = () => {
      clearTimeout(timeoutTimer);
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      try { child.stdout.destroy(); } catch { /* already gone */ }
      try { child.stderr.destroy(); } catch { /* already gone */ }
      try { child.stdin.destroy(); } catch { /* already gone */ }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      startKillEscalation();
      detachStreams();
      settle(() => reject(new ExtractionTimeoutError(binaryName, opts.timeoutMs)));
    }, opts.timeoutMs);

    // Only safe to clear these once the child process itself is confirmed
    // gone (a genuine 'close' or launch 'error') — NOT from inside the
    // timeout/cap handlers above, which fire before the process is
    // necessarily dead and still need startKillEscalation's SIGKILL timer
    // to run to completion.
    const onChildGone = () => {
      clearTimeout(timeoutTimer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (outputExceeded || timedOut) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxOutputBytes) {
        outputExceeded = true;
        startKillEscalation();
        detachStreams();
        settle(() => reject(new ExtractionOutputTooLargeError(binaryName, maxOutputBytes)));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLen >= MAX_STDERR_BYTES) return;
      stderrLen += chunk.length;
      stderrChunks.push(chunk);
    });

    // If the child exits (or was never runnable) before we finish writing
    // stdin, or we destroy()ed the streams ourselves on timeout/cap, the
    // streams emit their own 'error' (EPIPE etc). Without listeners that
    // would crash the process; the real failure is reported via the
    // 'close'/'error'/settle() paths above, so these are intentionally
    // no-ops.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      onChildGone();
      settle(() => reject(new Error(`Failed to launch ${binaryName}: ${err.message}`)));
    });

    child.on('close', (code) => {
      onChildGone();
      settle(() => {
        if (outputExceeded) {
          reject(new ExtractionOutputTooLargeError(binaryName, maxOutputBytes));
          return;
        }
        if (timedOut) {
          reject(new ExtractionTimeoutError(binaryName, opts.timeoutMs));
          return;
        }
        if (code !== 0) {
          const stderrText = sanitizeStderrForError(Buffer.concat(stderrChunks).toString('utf8'));
          reject(new ExtractorExitError(binaryName, code, stderrText));
          return;
        }
        resolve(Buffer.concat(stdoutChunks));
      });
    });

    child.stdin.end(input);
  });
}
