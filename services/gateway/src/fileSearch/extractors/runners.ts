// Runs external text-extraction tools (pandoc, pdftotext) against untrusted,
// user-uploaded document bytes. This module owns every process-safety concern:
// PATH resolution done ourselves (so the child can be spawned with an empty
// environment), feeding bytes on stdin instead of via a temp file, a wall-clock
// timeout that kills the whole process group (escalating to SIGKILL if the
// tool ignores SIGTERM), and a hard cap on captured stdout so a decompression
// bomb can't exhaust memory. No shell is ever involved: spawn() always gets an
// argv array, never a command string.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RunOptions {
  /** Wall-clock budget for the whole run, in milliseconds. */
  timeoutMs: number;
  /** Hard cap on captured stdout bytes. Defaults to DEFAULT_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

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

/**
 * Run `binaryName args…`, feeding `input` on stdin and capturing stdout as
 * text. Never touches disk, never uses a shell, never inherits this
 * process's environment.
 */
export function runExtractor(
  binaryName: string,
  args: string[],
  input: Buffer,
  opts: RunOptions
): Promise<string> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    let binaryPath: string;
    try {
      binaryPath = resolveBinary(binaryName);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(binaryPath, args, {
      env: {}, // no credentials, no PATH — see resolveBinary's doc comment
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
          reject(new Error(`${binaryName} exited with code ${code}${stderrText ? `: ${stderrText}` : ''}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      });
    });

    child.stdin.end(input);
  });
}
