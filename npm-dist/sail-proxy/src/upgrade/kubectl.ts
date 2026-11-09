import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import * as path from 'path';
import { Readable, Writable } from 'stream';

export type KubectlOptions = {
  input?: Buffer | string | Readable;
  /** stdout goes here instead of the result (a dump); the stream is ended. */
  stdout?: Writable;
  signal?: AbortSignal;
  /** extra environment variables for this child (on top of childEnv()) */
  env?: Record<string, string>;
  /** inherited variables this child does not get (before `env` is applied) */
  unsetEnv?: string[];
};
export type KubectlResult = { stdout: string; stderr: string };
/** A command (kubectl, docker, git) with an argument array; rejects with a KubectlError. */
export type Kubectl = (args: string[], options?: KubectlOptions) => Promise<KubectlResult>;
/** The same runner shape for any binary. */
export type CommandRunner = Kubectl;
/** Read-only, synchronous kubectl (setup-kyma.js's runKubectl): returns stdout, throws with .stderr. */
export type KubectlRead = (args: string[]) => string;
/** The command-string runner deploy-kyma.js and migration-jobs.js take. */
export type KubectlCommand = (command: string) => Promise<KubectlResult>;

const STDERR_LIMIT = 64 * 1024;

export class KubectlError extends Error {
  stderr: string;
  stdout: string;
  exitCode: number | null;
  constructor(args: string[], exitCode: number | null, stdout: string, stderr: string, binary = 'kubectl') {
    // Only the verb and one stderr line: arguments can be long, never secret (no credentials on a
    // command line), but the message stays readable. The line is the first that reads like an
    // error: docker compose writes progress lines ("dex Pulling") before its error.
    const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    const line = lines.find((l) => /error|failed|denied|unauthorized/i.test(l)) || lines[0];
    super(`${binary} ${args[0] || ''} failed: ${line || `exit code ${exitCode}`}`);
    this.name = 'KubectlError';
    this.stderr = stderr;
    this.stdout = stdout;
    this.exitCode = exitCode;
  }
}

export class AbortedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'AbortedError';
  }
}

/** Environment variables a child process never gets (a secret this process holds). */
export const SECRET_ENV = ['SAIL_PROXY_BACKUP_PASSPHRASE'];

/** process.env without SECRET_ENV, for every child the upgrade starts. */
export function childEnv(env: NodeJS.ProcessEnv = process.env, unset: string[] = []): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of [...SECRET_ENV, ...unset]) delete out[key];
  return out;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * A binary (kubectl, docker, git) spawned with an argument array (no shell). It runs detached on every platform: on POSIX
 * in its own process group, on Windows outside this console's Ctrl-C group (windowsHide keeps it
 * without a window), so a Ctrl-C reaches only this process (which decides) and never kills a
 * command of a running rollback; `signal` kills it on purpose. A failing stdout destination (a full
 * disk) or input stream kills the child and rejects with that error.
 */
export function spawnCommand(binary: string, spawnFn: SpawnFn = spawn as SpawnFn): CommandRunner {
  const name = path.basename(binary).replace(/\.(exe|cmd)$/i, '');
  return (args, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const child = spawnFn(binary, args, {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      env: { ...childEnv(process.env, options.unsetEnv), ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let streamError: Error | null = null;
    let settled = false;
    const finish = (error: Error | null, result?: KubectlResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const fail = (error: Error) => {
      if (!streamError) streamError = error;
      child.kill('SIGTERM');
    };
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Settles only after the destination finished or failed; never rejects by itself
    const piped = options.stdout
      ? new Promise<void>((done) => {
        const out = options.stdout!;
        out.once('finish', () => done());
        out.once('error', (error) => { child.stdout!.unpipe(out); fail(error); done(); });
        child.stdout!.pipe(out);
      })
      : Promise.resolve();
    if (!options.stdout) child.stdout!.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr!.on('data', (d: Buffer) => { if (stderr.length < STDERR_LIMIT) stderr += d.toString('utf8'); });
    if (options.input !== undefined) {
      const input = options.input;
      child.stdin!.on('error', () => { /* the exit code or the input error reports it */ });
      if (input instanceof Readable) {
        input.once('error', fail);
        input.pipe(child.stdin!);
      } else child.stdin!.end(input);
    }
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      piped.then(() => {
        if (streamError) finish(streamError);
        else if (aborted) finish(new AbortedError());
        else if (code === 0) finish(null, { stdout, stderr });
        else finish(new KubectlError(args, code, stdout, stderr, name));
      });
    });
  });
}

/** kubectl through spawnCommand. */
export function spawnKubectl(binary = 'kubectl', spawnFn: SpawnFn = spawn as SpawnFn): Kubectl {
  return spawnCommand(binary, spawnFn);
}

/** Splits a deploy-kyma.js command line ("kubectl apply -f \"<file>\"") into arguments. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted: string | null = null;
  let started = false;
  for (const ch of command) {
    if (quoted) {
      if (ch === quoted) quoted = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quoted = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quoted) throw new Error(`Unbalanced quote in kubectl command: ${command}`);
  if (started || current) out.push(current);
  return out;
}

/** deploy-kyma.js / migration-jobs.js command strings through an argument-array kubectl (no shell). */
export function commandAdapter(kubectl: Kubectl): KubectlCommand {
  return (command) => {
    const args = tokenize(command);
    if (args[0] !== 'kubectl') return Promise.reject(new Error(`Not a kubectl command: ${args[0]}`));
    return kubectl(args.slice(1));
  };
}

/** A command that no longer runs once `isStopped()` (the step phase of an interrupted run). */
export function guarded(kubectl: Kubectl, isStopped: () => boolean): Kubectl {
  return (args, options) => (isStopped() ? Promise.reject(new AbortedError()) : kubectl(args, options));
}

const AUTH_FAILURE = /Unauthorized|You must be logged in to the server|provide credentials|getting credentials|token (?:has |is )?expired|refresh token|oidc-login|executable kubectl-oidc_login/i;

/** Whether an error (kubectl's or one setup-kyma.js wrapped around it) says kubectl is not logged in. */
export function isAuthError(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string } | undefined;
  return AUTH_FAILURE.test(`${e?.stderr || ''}\n${e?.message || ''}`);
}

/** True for the API server's NotFound (an absent object). */
export function isNotFound(error: unknown): boolean {
  return /Error from server \(NotFound\)/.test(String((error as { stderr?: string })?.stderr || ''));
}
