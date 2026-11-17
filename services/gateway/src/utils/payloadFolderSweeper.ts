/**
 * Keeps the payload folder (the JSON files payloadLogger.ts writes for debugging) from growing
 * without end: files older than PAYLOAD_LOG_RETENTION_HOURS go, then the oldest files go while the
 * folder holds more than PAYLOAD_LOG_MAX_MB. 0 switches a limit off; with both 0 (the standalone
 * CLI's default, which its user can change) the sweeper does not start.
 *
 * Only regular files named *.json, and the Anthropic stream dumps (*_04_client_native_stream_response.txt),
 * inside the payload folder are touched. Links are never followed
 * or deleted (lstat), and the walk never leaves the folder. The work runs on a timer, never in a
 * request, with asynchronous calls in portions that yield to the event loop.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
import { getLogDir, isStreamDumpFile } from './payloadLogger';

const logger = getDefaultLogger();

const DEFAULT_RETENTION_HOURS = 48;
const DEFAULT_MAX_MB = 1024;
const DEFAULT_SWEEP_MINUTES = 15;
const MB = 1024 * 1024;
const HOUR_MS = 3600 * 1000;
// A gateway restarted more often than the interval would never sweep: one sweep soon after start.
const FIRST_SWEEP_DELAY_MS = 30 * 1000;
// Entries handled between two yields to the event loop.
const PORTION = 200;

export interface PayloadSweepLimits {
  retentionHours: number;
  maxBytes: number;
}

interface Candidate {
  file: string;
  dir: string;
  mtimeMs: number;
  size: number;
}

function numberOrDefault(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function payloadSweepLimits(env: NodeJS.ProcessEnv): PayloadSweepLimits & { everyMinutes: number } {
  return {
    retentionHours: numberOrDefault(env.PAYLOAD_LOG_RETENTION_HOURS, DEFAULT_RETENTION_HOURS, 0),
    maxBytes: numberOrDefault(env.PAYLOAD_LOG_MAX_MB, DEFAULT_MAX_MB, 0) * MB,
    everyMinutes: numberOrDefault(env.PAYLOAD_LOG_SWEEP_MINUTES, DEFAULT_SWEEP_MINUTES, 1),
  };
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lists the *.json files and stream dumps below `root` (regular files only, links skipped) and its subfolders. */
async function listCandidates(root: string): Promise<{ files: Candidate[]; folders: string[] }> {
  const files: Candidate[] = [];
  const folders: string[] = [];
  const pending = [root];
  let handled = 0;
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let handle: fs.Dir;
    try {
      handle = await fs.promises.opendir(current);
    } catch (error: any) {
      if (current === root && error?.code === 'ENOENT') return { files, folders };
      continue;
    }
    try {
      for await (const entry of handle) {
        if (++handled % PORTION === 0) await yieldToEventLoop();
        const full = path.join(current, entry.name);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.lstat(full);
        } catch {
          continue; // gone since the listing
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          folders.push(full);
          pending.push(full);
        } else if (stat.isFile() && (entry.name.endsWith('.json') || isStreamDumpFile(entry.name))) {
          files.push({ file: full, dir: current, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    } catch {
      // the folder vanished or could not be read while listing: work with what was seen
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return { files, folders };
}

/**
 * Deletes payload files older than `retentionHours`, then the oldest files while the rest is larger
 * than `maxBytes`. Returns how many went for each reason. A limit of 0 is off.
 */
export function sweepPayloadFolder(
  dir: string,
  limits: PayloadSweepLimits,
  now: Date,
): Promise<{ byAge: number; bySize: number }> {
  // Sweeps of this process run one after the other, so two calls never unlink the same file at once.
  const run = sweepQueue.then(() => sweepNow(dir, limits, now));
  sweepQueue = run.then(() => undefined, () => undefined);
  return run;
}

let sweepQueue: Promise<void> = Promise.resolve();

async function sweepNow(
  dir: string,
  limits: PayloadSweepLimits,
  now: Date,
): Promise<{ byAge: number; bySize: number }> {
  const result = { byAge: 0, bySize: 0 };
  const root = path.resolve(dir || '');
  // An empty folder setting resolves to the working directory and a bare root is never a payload folder.
  if (!dir || root === path.parse(root).root) return result;

  const ageOn = limits.retentionHours > 0;
  const sizeOn = limits.maxBytes > 0;
  if (!ageOn && !sizeOn) return result;

  const { files, folders } = await listCandidates(root);
  const touched = new Set<string>();
  let failed = 0;
  let handled = 0;

  const remove = async (candidate: Candidate): Promise<boolean> => {
    if (++handled % PORTION === 0) await yieldToEventLoop();
    try {
      await fs.promises.unlink(candidate.file);
      touched.add(candidate.dir);
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT') touched.add(candidate.dir); // someone else deleted it
      else failed++;
      return false;
    }
  };

  let remaining = files;
  if (ageOn) {
    const cutoff = now.getTime() - limits.retentionHours * HOUR_MS;
    const kept: Candidate[] = [];
    for (const candidate of files) {
      if (candidate.mtimeMs < cutoff) {
        if (await remove(candidate)) result.byAge++;
        else if (await exists(candidate.file)) kept.push(candidate);
      } else {
        kept.push(candidate);
      }
    }
    remaining = kept;
  }

  if (sizeOn) {
    let total = remaining.reduce((sum, c) => sum + c.size, 0);
    if (total > limits.maxBytes) {
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const candidate of remaining) {
        if (total <= limits.maxBytes) break;
        if (await remove(candidate)) result.bySize++;
        // gone (deleted by someone else) or stuck: either way count it off only when it is gone
        if (!(await exists(candidate.file))) total -= candidate.size;
      }
    }
  }

  // Remove subfolders this sweep emptied, deepest first; the payload folder itself stays.
  for (const folder of folders.sort((a, b) => b.length - a.length)) {
    if (!touched.has(folder)) continue;
    try {
      await fs.promises.rmdir(folder); // fails when not empty
      touched.add(path.dirname(folder));
    } catch {
      // not empty, or already gone
    }
  }

  if (failed > 0) {
    logger.warn('PayloadFolderSweeper', `${failed} payload file(s) could not be deleted`);
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Timer driver, in the shape of fileSearch/jobSweeper.ts
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;

async function runSweep(): Promise<void> {
  if (sweeping) return; // the previous sweep is still running: skip this tick
  sweeping = true;
  try {
    const dir = getLogDir();
    // The payload folder is always <log folder>/payloads; anything else is not ours to sweep.
    if (path.basename(dir) !== 'payloads') return;
    const { retentionHours, maxBytes } = payloadSweepLimits(process.env);
    const { byAge, bySize } = await sweepPayloadFolder(dir, { retentionHours, maxBytes }, new Date());
    if (byAge + bySize > 0) {
      logger.info('PayloadFolderSweeper', `Deleted ${byAge} payload file(s) by age and ${bySize} by size`);
    }
  } catch (error) {
    logger.error('PayloadFolderSweeper', 'Sweep failed', error instanceof Error ? error : new Error(String(error)));
  } finally {
    sweeping = false;
  }
}

/**
 * Starts the periodic sweep and returns true, or returns false (and starts nothing) when both
 * limits are 0. It runs whether or not payload logging is on right now: files of an earlier
 * debugging session must still age out.
 */
export function startPayloadFolderSweeper(): boolean {
  if (sweepTimer) return true;
  const { retentionHours, maxBytes, everyMinutes } = payloadSweepLimits(process.env);
  if (retentionHours === 0 && maxBytes === 0) {
    logger.info('PayloadFolderSweeper', 'Payload files are not deleted automatically (both limits are 0)');
    return false;
  }
  const parts: string[] = [];
  if (retentionHours > 0) parts.push(`payload files older than ${retentionHours} h are deleted`);
  if (maxBytes > 0) parts.push(`the folder is kept under ${Math.round(maxBytes / MB)} MB`);
  logger.info('PayloadFolderSweeper', `${parts.join(', ')}, checked every ${everyMinutes} min`);
  sweepTimer = setInterval(() => void runSweep(), everyMinutes * 60 * 1000);
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    void runSweep();
  }, FIRST_SWEEP_DELAY_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  if (typeof firstSweepTimer.unref === 'function') firstSweepTimer.unref();
  return true;
}

/** Stops the periodic sweep. Safe to call when never started. */
export function stopPayloadFolderSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (firstSweepTimer) {
    clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
  }
}
