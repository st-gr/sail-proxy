/**
 * The delivery dispatcher: connects the durable outbox (outbox.ts) to the sinks that ship
 * events to external SIEM endpoints (sink.ts). On each tick it reads a batch of undelivered
 * rows for every configured sink and attempts to send it — per Task 3's per-sink delivery
 * state, a sink that is down or misconfigured cannot block delivery to the others.
 *
 * Concurrency note: readUndelivered does no row locking, so two dispatchers running at the
 * same time could both read and act on the same pending rows. kyma/manifests/core/admin.yaml
 * pins replicas: 1, so this can only happen briefly during a rolling update, and at-least-once
 * delivery with event_id dedup downstream makes an occasional duplicate delivery acceptable.
 * Documented here rather than solved with locking.
 */
import { getDefaultLogger } from '@libs/logger';
import { SiemSink, SinkError } from './sink';
import { OutboxRow, readUndelivered, markDelivered, markFailed, reconcileOutbox } from './outbox';
import { SiemEvent, redactForSink } from './siemEvent';

const logger = getDefaultLogger();

export interface DispatcherConfig {
  /** Rows read per sink, per tick. Overridable per sink via `perSink`. */
  batchSize: number;
  /** How often each sink is checked. Overridable per sink via `perSink`. */
  intervalMs: number;
  /** Delay before the first tick. Defaults to 0 (fires on the next event loop turn). */
  startupDelayMs?: number;
  /**
   * How far back reconcileOutbox (outbox.ts) scans/backfills, in ms. Passed straight through
   * to reconcileOutbox — see its doc comment for the bound this puts on tick cost and the
   * backfill trade it implies for newly enabled sinks. Undefined uses
   * outbox.ts's own DEFAULT_RECONCILE_LOOKBACK_MS.
   */
  reconcileLookbackMs?: number;
  /**
   * Per-sink overrides, keyed by sink name. An S3 sink wants large infrequent objects
   * while a webhook wants small frequent posts, so one global pair cannot serve both.
   *
   * Interval is honoured by tracking a per-sink `lastRunAt` against a single timer rather
   * than creating one timer per sink — `stop()` would otherwise have to track them all,
   * and a leaked timer hangs jest.
   */
  perSink?: Record<string, { batchSize?: number; intervalMs?: number }>;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// A retryable error (a 503 that may recover) grows more gently than a non-retryable one
// (a 400 the endpoint will reject forever): retrying sooner cannot fix the latter, so it
// backs off harder rather than hammering an endpoint that will never accept the payload.
const RETRYABLE_BACKOFF_MULTIPLIER = 2;
const NON_RETRYABLE_BACKOFF_MULTIPLIER = 4;

interface BackoffState {
  delayMs: number;
  nextAttemptAt: number;
}

/**
 * Starts the background delivery worker. Follows the startup-delay-then-setInterval shape
 * used by costRecalculationService.ts (services/admin/src/services/costRecalculationService.ts:27-38).
 * Returns a handle whose stop() clears both timers — required so tests and shutdown can end
 * the worker cleanly instead of leaving a handle that hangs the process.
 */
export function startDispatcher(sinks: SiemSink[], cfg: DispatcherConfig): { stop(): void } {
  const backoff = new Map<string, BackoffState>();
  const lastRunAt = new Map<string, number>();
  const inFlightSinks = new Set<string>();
  let reconcileInFlight = false;
  let intervalHandle: NodeJS.Timeout | undefined;

  // Every sink is still driven by one timer (see the doc comment on `perSink`): the period
  // is the shortest of the global interval and any per-sink override. Sinks with a longer
  // interval are skipped on ticks that fire before their own `lastRunAt` window has elapsed.
  //
  // The sink-dispatch phase below runs on EVERY tick, unguarded at the tick level — only
  // each sink's own `inFlightSinks` entry can hold it back. So a sink whose `send()`
  // outlasts its own interval cannot get a second, overlapping dispatch of itself (that's
  // what the guard is for), but it also cannot delay any other sink's dispatch: the other
  // sinks are checked and, if ready, started on this same tick regardless of what the slow
  // sink is doing. A tick where every sink is either mid-flight or still inside its interval
  // window does almost no work and returns immediately, so ticks overlapping is not a
  // problem worth guarding against here. What a slow sink CAN still do is stretch its own
  // cadence beyond its configured interval, by exactly its own overrun — that is intrinsic
  // to "don't start a second copy of yourself," not something this guard removes.
  const tickPeriodMs = Math.min(
    cfg.intervalMs,
    ...Object.values(cfg.perSink ?? {}).map(o => o.intervalMs ?? Infinity)
  );

  /**
   * Repairs SiemOutbox rows left without a SiemDelivery row for one of these sinks — e.g. a
   * config-read failure at ingest time wrote the outbox row with no sinks at all, which
   * would otherwise leave the event permanently invisible to readUndelivered. Guarded by its
   * own flag (not awaited by the tick that kicks it off — see `tick` below) so a reconcile
   * pass slower than the tick period cannot re-enter itself, and so a hung reconcile cannot
   * wedge sink dispatch behind it.
   */
  const runReconcile = async (): Promise<void> => {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      await reconcileOutbox(sinks.map(s => s.name), cfg.reconcileLookbackMs);
    } catch (error) {
      // reconcileOutbox already logs per-chunk failures at 'error' and keeps going; reaching
      // here means the whole call threw (e.g. the DB connection itself is unavailable),
      // which is at least as serious, so it gets the same visibility rather than a quieter
      // 'warn'.
      logger.error(
        'SiemDispatcher',
        'Failed to reconcile outbox deliveries; will retry next tick',
        error as Error
      );
    } finally {
      reconcileInFlight = false;
    }
  };

  const tick = async (): Promise<void> => {
    // Not awaited: reconcile has its own re-entrancy guard above, and letting a slow (or
    // hung) reconcile pass block this tick's sink dispatch would recreate the exact bug this
    // round of fixes removed, just one call up.
    void runReconcile();

    // Dispatched concurrently rather than awaited one at a time: the per-sink work only
    // touches this sink's own entries in `backoff`/`lastRunAt`/`inFlightSinks`, so sinks are
    // independent. Serial dispatch let one slow sink's timeout push every later sink in the
    // array past its own configured interval. allSettled (not all) so one sink's rejection
    // cannot cancel the others' in-flight sends.
    await Promise.allSettled(sinks.map(async sink => {
      const override = cfg.perSink?.[sink.name];
      const sinkInterval = override?.intervalMs ?? cfg.intervalMs;
      const last = lastRunAt.get(sink.name) ?? 0;
      if (Date.now() - last < sinkInterval) return;
      // A sink whose previous dispatch is still running is skipped rather than started
      // again — without this, a send() slower than its own interval gets a second,
      // concurrent dispatch of the same outbox rows on the next tick (duplicate sends,
      // and the retry budget burning several times faster than intended). This is the ONLY
      // guard on this sink's cadence; it never holds back any other sink.
      if (inFlightSinks.has(sink.name)) return;
      lastRunAt.set(sink.name, Date.now());
      inFlightSinks.add(sink.name);

      try {
        await dispatchOne(sink, override?.batchSize ?? cfg.batchSize, backoff);
      } catch {
        // dispatchOne handles sink.send() failures itself (markFailed + backoff); this
        // only guards an unexpected failure reading/updating the outbox so trouble with
        // one sink never stops the others from being dispatched.
      } finally {
        inFlightSinks.delete(sink.name);
      }
    }));
  };

  const startupTimer = setTimeout(() => {
    void tick();
    intervalHandle = setInterval(() => { void tick(); }, tickPeriodMs);
  }, cfg.startupDelayMs ?? 0);

  return {
    stop(): void {
      clearTimeout(startupTimer);
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}

/** Reads, sends and settles one batch for one sink, applying that sink's own backoff. */
async function dispatchOne(
  sink: SiemSink,
  batchSize: number,
  backoff: Map<string, BackoffState>
): Promise<void> {
  const state = backoff.get(sink.name);
  if (state && Date.now() < state.nextAttemptAt) return;

  const rows = await readUndelivered(sink.name, batchSize);
  if (rows.length === 0) return;

  const ids = rows.map(r => r.ID);
  // Strip credential_material and content unless THIS sink has explicitly opted in to each
  // — a single outbox row can be delivered to multiple sinks with different
  // include_credential_material / include_content / allow_unmasked_content settings, so
  // redaction happens per sink here rather than once at normalization. redactForSink
  // returns a copy whenever it removes anything: `rows` is the shared batch every sink in
  // this tick reads, and mutating it would leak a field to a sink that never opted in (or
  // take it from one that did, depending on dispatch order).
  const payloads = rows.map(r => redactForSink(r.payload, sink));
  try {
    await sink.send(payloads);
    await markDelivered(ids, sink.name);
    backoff.delete(sink.name);
  } catch (error) {
    const retryable = error instanceof SinkError ? error.retryable : true;
    // Isolating by re-sending each row individually only makes sense when (a) there is more
    // than one row to isolate among, and (b) retrying the identical payload again cannot
    // help — i.e. the failure is non-retryable, so SOME row's content is genuinely rejected
    // rather than the sink itself being transiently down. Gating on retryable matters: a
    // retryable failure (503) previously still bisected, turning one struggling-sink tick
    // into up to batchSize extra requests aimed at the endpoint that's already failing
    // (measured: an 8-row batch with a retryable 503 produced 9 send calls before this
    // gate). A retryable failure — or a one-row batch, where there is nothing to isolate —
    // settles the whole batch instead: identical to the pre-isolation behavior, all rows
    // stay pending and eligible for retry once the sink recovers.
    if (!retryable && rows.length > 1) {
      await settleIndividually(sink, rows, payloads, backoff);
    } else {
      await settleWholeBatch(sink, ids, error, backoff);
    }
  }
}

/**
 * Settles every row in the batch on the same outcome — used when there is only one row (no
 * isolation possible) or the failure is retryable (bisecting a struggling sink wouldn't find
 * a poison event, only amplify load against it while it's already failing).
 */
async function settleWholeBatch(
  sink: SiemSink,
  ids: string[],
  error: unknown,
  backoff: Map<string, BackoffState>
): Promise<void> {
  const retryable = error instanceof SinkError ? error.retryable : true;
  const message = error instanceof Error ? error.message : String(error);
  const expired = await markFailed(ids, sink.name, message);
  if (expired.length > 0) {
    logger.warn('SiemDispatcher', 'Expiring event(s) after exhausting delivery attempts', {
      sink: sink.name,
      ids: expired.map(r => r.ID),
      attempts: expired[0]?.attempts,
      lastError: message,
    });
  }

  const state = backoff.get(sink.name);
  const multiplier = retryable ? RETRYABLE_BACKOFF_MULTIPLIER : NON_RETRYABLE_BACKOFF_MULTIPLIER;
  const delayMs = Math.min((state?.delayMs ?? BASE_BACKOFF_MS) * multiplier, MAX_BACKOFF_MS);
  backoff.set(sink.name, { delayMs, nextAttemptAt: Date.now() + delayMs });
}

/**
 * Re-sends each row of a failed batch on its own so settlement tracks the event that
 * actually failed, not the whole batch. Applies one sink-level backoff decision afterward:
 * if every row ends up delivered individually, the failure was about the batch shape or a
 * transient hiccup rather than the sink being down, so backoff clears; otherwise it grows on
 * the same retryable/non-retryable schedule as before, driven by whether any individual
 * failure was retryable.
 */
async function settleIndividually(
  sink: SiemSink,
  rows: OutboxRow[],
  payloads: SiemEvent[],
  backoff: Map<string, BackoffState>
): Promise<void> {
  let sawFailure = false;
  let sawRetryableFailure = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await sink.send([payloads[i]]);
      await markDelivered([row.ID], sink.name);
    } catch (error) {
      sawFailure = true;
      const retryable = error instanceof SinkError ? error.retryable : true;
      if (retryable) sawRetryableFailure = true;

      // Neither this branch nor the try above marks a row delivered without actually
      // sending it: a retryable failure means try again later, a non-retryable one means
      // retrying cannot help, but nothing here may claim the SIEM received the event.
      const message = error instanceof Error ? error.message : String(error);
      const expired = await markFailed([row.ID], sink.name, message);
      if (expired.length > 0) {
        // Silently dropping an audit event is the thing this whole design exists to
        // prevent — expiry must be loud even though it is the correct outcome for a
        // poison event.
        logger.warn('SiemDispatcher', 'Expiring event(s) after exhausting delivery attempts', {
          sink: sink.name,
          ids: expired.map(r => r.ID),
          attempts: expired[0]?.attempts,
          lastError: message,
        });
      }
    }
  }

  if (!sawFailure) {
    backoff.delete(sink.name);
    return;
  }

  const state = backoff.get(sink.name);
  const multiplier = sawRetryableFailure ? RETRYABLE_BACKOFF_MULTIPLIER : NON_RETRYABLE_BACKOFF_MULTIPLIER;
  const delayMs = Math.min((state?.delayMs ?? BASE_BACKOFF_MS) * multiplier, MAX_BACKOFF_MS);
  backoff.set(sink.name, { delayMs, nextAttemptAt: Date.now() + delayMs });
}
