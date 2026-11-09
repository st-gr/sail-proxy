// The step runner of an upgrade: step order, failure injection for rehearsals, and what a signal
// does. Before the outage a signal ends the run (nothing has changed); from the outage on it only
// sets a flag: the current step finishes (or its abortable command is stopped), then the rollback
// runs to completion, and every further signal is ignored with a note.

export type StepId = 'read' | 'ask' | 'preflight' | 'outage' | 'backup' | 'apply' | 'migrate' | 'health' | 'record';
export const STEPS: StepId[] = ['read', 'ask', 'preflight', 'outage', 'backup', 'apply', 'migrate', 'health', 'record'];
/** Steps whose failure means the outage has started (a rollback follows). */
export const OUTAGE_STEPS: StepId[] = ['outage', 'backup', 'apply', 'migrate', 'health', 'record'];

/** A path as one copy-pasteable shell word: double quotes, with " $ ` and \\ escaped (POSIX); plain quotes on Windows. */
export function quotePath(p: string): string {
  if (process.platform === 'win32') return `"${p}"`;
  return `"${p.replace(/["$`\\]/g, '\\$&')}"`;
}

/** How often a running phase says it is still running. */
export const HEARTBEAT_MS = 15000;

/**
 * One phase of a rollback or restore: "<label>...", then "  still <label> (<n> s)" every intervalMs
 * while it runs (a database restore or a rollout can take minutes: silence looks like a hang), and
 * "  done in <n> s" when it succeeded. A failure ends the heartbeat and is passed on.
 */
export async function runPhase<T>(log: (message: string) => void, label: string, work: () => Promise<T>, { intervalMs = HEARTBEAT_MS } = {}): Promise<T> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  log(`${label}...`);
  const still = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const timer = setInterval(() => log(`  still ${still} (${seconds()} s)`), intervalMs);
  try {
    const result = await work();
    log(`  done in ${seconds()} s`);
    return result;
  } finally {
    clearInterval(timer);
  }
}

export const FAIL_AT_ENV = 'SAIL_PROXY_UPGRADE_FAIL_AT';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export class InjectedFailure extends Error {
  constructor(step: StepId) {
    super(`${FAIL_AT_ENV}=${step}: failure injected at step ${step}`);
    this.name = 'InjectedFailure';
  }
}

export class Interrupted extends Error {
  signal: string;
  constructor(signal: string) {
    super(`interrupted by ${signal}`);
    this.name = 'Interrupted';
    this.signal = signal;
  }
}

/** What the runner listens on (process, or a stand-in in tests). */
export interface SignalSource {
  on(event: string, listener: (signal: string) => void): unknown;
  removeListener(event: string, listener: (signal: string) => void): unknown;
}

export type Phase = 'before' | 'outage' | 'rollback' | 'done';

export class StepRunner {
  phase: Phase = 'before';
  current: StepId | null = null;
  interrupted: string | null = null;
  private readonly controller = new AbortController();
  private readonly listeners = new Map<string, (s: string) => void>();

  constructor(private readonly options: {
    signals: SignalSource;
    env: NodeJS.ProcessEnv;
    log: (message: string) => void;
    /** A signal before the outage: nothing changed, the run ends (cleanup, exit). */
    onEarlySignal: (signal: string) => void;
  }) {}

  start(): void {
    for (const name of SIGNALS) {
      const listener = () => this.handle(name);
      this.listeners.set(name, listener);
      this.options.signals.on(name, listener);
    }
  }

  stop(): void {
    for (const [name, listener] of this.listeners) this.options.signals.removeListener(name, listener);
    this.listeners.clear();
    this.phase = 'done';
  }

  /** Aborted once a signal arrived during the outage; given to abortable commands. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  enterOutage(): void {
    this.phase = 'outage';
  }

  enterRollback(): void {
    this.phase = 'rollback';
  }

  private handle(signal: string): void {
    if (this.phase === 'before') {
      this.options.onEarlySignal(signal);
    } else if (this.phase === 'outage' && !this.interrupted) {
      this.interrupted = signal;
      this.options.log(`\n${signal} received: the upgrade stops after the current step and rolls back.`);
      this.controller.abort();
    } else if (this.phase !== 'done') {
      this.options.log(`\n${signal} received: rollback in progress, it runs to completion (signal ignored).`);
    }
  }

  /** Runs one step: interrupted runs start no new step; an injected failure throws after its work. */
  async step<T>(id: StepId, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.current = id;
    if (this.interrupted) throw new Interrupted(this.interrupted);
    this.options.log(`\n=== Step: ${id} ===`);
    const result = await work(this.controller.signal);
    if (this.interrupted) throw new Interrupted(this.interrupted);
    if (this.options.env[FAIL_AT_ENV] === id) throw new InjectedFailure(id);
    return result;
  }
}
