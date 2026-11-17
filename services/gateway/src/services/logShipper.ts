import { getDefaultLogger } from '@libs/logger';
import type { LogEntry } from '@libs/logger';

/**
 * The gateway's log, handed to Valkey: the logger's sink queues entries in memory, a timer hands
 * the queue over in batches. A request never waits for any of it: the sink only pushes to an array
 * and returns, and under pressure entries are dropped and counted. This file knows nothing of
 * Valkey, Express or the configuration file; those come in through `deps`.
 */

export interface ShippedLogEntry {
  t: string;
  seq: number;
  level: string;
  component: string;
  requestId?: string;
  message: string;
  error?: string;
}

const MAX_QUEUED = 5000;
const BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 1000;
const DROPPED_WARNING_INTERVAL_MS = 60_000;
const MESSAGE_LIMIT = 2000;
const ERROR_LIMIT = 500;

const LEVEL_ORDER: Record<string, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };

// The access line of the health route, as accessLogMiddleware writes it (morgan, `"GET /health HTTP/1.1"`).
const HEALTH_ACCESS_LINE = /"(?:GET|HEAD) \/health(?:\?[^ "]*)? HTTP\/[\d.]+"/;

// A JSON.parse error quotes a piece of its input: `Unexpected token 'C', "CONTENT-MA"... is not valid
// JSON`, or `..."…"...` for a long input. That input can be model output, a tool call's arguments or
// a request or upstream body, so the stored entry says only that the input was not valid JSON. The
// console line keeps the quote.
const JSON_PARSE_QUOTE = /Unexpected token '[\s\S]{1,2}?', (?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/g;
// A RegExp SyntaxError quotes its pattern: `Invalid regular expression: /<pattern>/<flags>: <reason>`.
// A pattern from a request or a configuration (a masking allow-list) can name people.
// The pattern can hold a line break, a `/` or a `: `: the quote ends at the last `/flags: `.
const REGEXP_QUOTE = /Invalid regular expression: \/[\s\S]*\/[dgimsuvy]*: /g;
const withoutJsonInput = (text: string): string => text
  .replace(JSON_PARSE_QUOTE, 'Unexpected token in an input that is not valid JSON')
  .replace(REGEXP_QUOTE, 'Invalid regular expression: (pattern not stored): ');

// A shorter text ("error", "Bad Request" is 11) is not hunted through the line: it would match
// unrelated words. It is replaced only where the line ends with it, which is where an interpolated
// error message sits.
const MIN_SWAPPED_TEXT = 12;
const CLOSING_PUNCTUATION = '.)]"\'';

/**
 * The line with the error's text replaced by its logText where it was interpolated: every
 * occurrence of the text, and of its JSON-escaped form (a message that embeds JSON.stringify of an
 * object holding it); a short text only at the end of the line, before closing punctuation.
 * Replaced literally (no pattern, no `$` replacement syntax).
 */
function withLogText(message: string, text: string, logText: string): string {
  if (!text) return message;
  if (text.length < MIN_SWAPPED_TEXT) {
    let end = message.length;
    while (end > 0 && CLOSING_PUNCTUATION.includes(message[end - 1])) end--;
    const at = end - text.length;
    if (at >= 0 && message.slice(at, end) === text) return message.slice(0, at) + logText + message.slice(end);
    return message;
  }
  let out = message;
  for (const form of [text, JSON.stringify(text).slice(1, -1)]) out = out.split(form).join(logText);
  return out;
}

export function shippedEntryOf(entry: LogEntry, minLevel: string, seq: number): ShippedLogEntry | null {
  const level = entry.level.toUpperCase();
  if ((LEVEL_ORDER[level] ?? 0) < (LEVEL_ORDER[minLevel.toUpperCase()] ?? LEVEL_ORDER.INFO)) return null;
  if (entry.component === 'HTTP' && HEALTH_ACCESS_LINE.test(entry.message)) return null;
  // An error carrying an upstream's own text (utils/upstreamErrorLogText.ts) is stored as its
  // logText, also where its message was written into the log line.
  const logText = entry.error?.logText;
  let message = String(entry.message);
  if (logText && entry.error?.message) message = withLogText(message, entry.error.message, logText);
  const shipped: ShippedLogEntry = {
    t: entry.timestamp,
    seq,
    level,
    component: entry.component,
    message: withoutJsonInput(message).slice(0, MESSAGE_LIMIT),
  };
  if (entry.requestId) shipped.requestId = entry.requestId;
  if (entry.error) shipped.error = withoutJsonInput(`${entry.error.name}: ${logText ?? entry.error.message}`).slice(0, ERROR_LIMIT);
  return shipped;
}

export function logShippingAllowed(env: NodeJS.ProcessEnv, standalone: boolean): boolean {
  return !standalone && !!env.VALKEY_URL && env.GATEWAY_LOG_SHIPPING !== 'off';
}

/** One line on stderr; never through the logger the shipper listens to. */
export const warnToStderr = (line: string): void => { process.stderr.write(`${line}\n`); };

export function startLogShipper(deps: {
  publish: (batch: ShippedLogEntry[]) => Promise<void>;
  settings: () => { enabled: boolean; minLevel: string };
  warn: (line: string) => void;
}): () => void {
  let queue: ShippedLogEntry[] = [];
  let seq = 0;
  let dropped = 0;
  let lastWarning = 0;
  let flushing = false;
  let stopped = false;
  let current = { enabled: false, minLevel: 'INFO' };

  const refreshSettings = (): void => {
    try {
      current = deps.settings();
    } catch {
      // keep the previous settings (the configuration may not be ready yet)
    }
  };

  // Called inside every log call: it only pushes to an array and returns.
  const sink = (entry: LogEntry): void => {
    if (!current.enabled) return;
    // The filter first: an entry that would not be stored anyway is not a lost one.
    const shipped = shippedEntryOf(entry, current.minLevel, seq + 1);
    if (!shipped) return;
    if (queue.length >= MAX_QUEUED) { dropped++; return; }
    seq++;
    queue.push(shipped);
  };

  const warnAboutDrops = (): void => {
    const now = Date.now();
    if (dropped === 0 || now - lastWarning < DROPPED_WARNING_INTERVAL_MS) return;
    const count = dropped;
    dropped = 0;
    lastWarning = now;
    try { deps.warn(`log shipping: ${count} log entries dropped (the queue was full or Valkey was not reachable)`); } catch { /* nothing to do */ }
  };

  const flush = async (): Promise<void> => {
    if (flushing || stopped) return;
    flushing = true;
    try {
      refreshSettings();
      if (!current.enabled) { queue = []; return; }
      while (queue.length > 0 && !stopped) {
        const batch = queue.splice(0, BATCH_SIZE);
        try {
          await deps.publish(batch);
        } catch {
          // Keep the batch for the next flush; what no longer fits is dropped and counted.
          const room = MAX_QUEUED - queue.length;
          if (batch.length > room) { dropped += batch.length - room; batch.length = room; }
          queue = batch.concat(queue);
          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  refreshSettings();
  const removeSink = getDefaultLogger().addSink(sink);
  const timer = setInterval(() => { void flush(); warnAboutDrops(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    removeSink();
    // One last attempt at what is queued, not waited for.
    if (current.enabled) {
      while (queue.length > 0) {
        try { deps.publish(queue.splice(0, BATCH_SIZE)).catch(() => undefined); } catch { /* nothing to do */ }
      }
    }
    queue = [];
  };
}
