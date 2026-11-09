/**
 * The durable SIEM outbox: Postgres is the system of record for a normalized SiemEvent, and
 * `SiemDelivery` tracks per-sink delivery state so a sink that is down cannot block the
 * others. Valkey (securityEventSubscriber.ts) is transport, not storage — it has persistence
 * disabled, so once an event is XACKed off the stream it exists nowhere else but here.
 */
import { v4 as uuidv4 } from 'uuid';
import { SiemEvent } from './siemEvent';
import { safeStringify } from './sink';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export interface OutboxRow {
  ID: string;
  payload: SiemEvent;
}

/**
 * Write the normalized event once, plus one pending SiemDelivery row per sink. Called from
 * the ingest path (securityEventSubscriber.ts) after the domain event has been persisted and
 * before the stream entry is acked.
 */
export async function writeToOutbox(event: SiemEvent, sinks: string[]): Promise<void> {
  const db = await cds.connect.to('db');
  const outboxId = uuidv4();

  await db.run(
    cds.ql.INSERT.into('sap.llm.gateway.admin.SiemOutbox').entries({
      ID: outboxId,
      eventId: event.event_id,
      category: event.category,
      eventType: event.type,
      severity: event.severity,
      occurredAt: event.timestamp,
      // safeStringify (sink.ts), not raw JSON.stringify: defense-in-depth against a value it
      // cannot serialize failing this INSERT. toSiemEvent's typed construction path (and,
      // separately, this ingest path's own JSON.parse of the incoming stream entry) means
      // nothing reaching here today can actually carry a BigInt/circular-ref/throwing-getter
      // — see siem-serialization-safety.test.ts's write-up — but this guard costs nothing on
      // the common path and this is exactly the kind of INSERT a future change could regress.
      payload: safeStringify(event),
    })
  );

  if (sinks.length === 0) return;

  await db.run(
    cds.ql.INSERT.into('sap.llm.gateway.admin.SiemDelivery').entries(
      sinks.map(sink => ({
        ID: uuidv4(),
        event_ID: outboxId,
        sinkName: sink,
        status: 'pending',
        attempts: 0,
      }))
    )
  );
}

/**
 * Rows still pending delivery to `sink`, oldest event first. Two queries rather than an
 * expand/path-expression join: this codebase's cds.ql call sites (securityEventService.ts,
 * usageEventProcessor.ts) consistently read an association's foreign key column and do a
 * second lookup by ID list, so this follows that precedent instead of an untested join.
 */
export async function readUndelivered(sink: string, limit: number): Promise<OutboxRow[]> {
  const db = await cds.connect.to('db');
  const { SELECT } = cds.ql;

  // `limit` must bound the SiemDelivery scan itself, not just the final result: pulling
  // every pending row's SiemOutbox payload (a LargeString) before slicing in JS measured at
  // 12000 rows fetched to return 10 against a 3000-row backlog, and a backlog that large also
  // risks the follow-up `ID in (...)` blowing past Postgres's 65535-parameter cap — exactly
  // when a sink has been down and the backlog matters most. SiemDelivery.createdAt (from the
  // `managed` aspect) tracks write order closely enough to order+limit here without needing
  // SiemOutbox.occurredAt, which the second query fetches only for the already-bounded set.
  const pending: Array<{ event_ID: string }> = await db.run(
    SELECT.from('sap.llm.gateway.admin.SiemDelivery')
      .columns('event_ID')
      .where({ status: 'pending', sinkName: sink })
      .orderBy('createdAt asc')
      .limit(limit)
  );
  if (pending.length === 0) return [];

  const eventIds = [...new Set(pending.map(p => p.event_ID))];
  const outboxRows: Array<{ ID: string; occurredAt: string; payload: string }> = await db.run(
    SELECT.from('sap.llm.gateway.admin.SiemOutbox')
      .columns('ID', 'occurredAt', 'payload')
      .where({ ID: { in: eventIds } })
  );

  return outboxRows
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
    .map(r => ({ ID: r.ID, payload: JSON.parse(r.payload) }));
}

/**
 * Rows of SiemOutbox read per chunk, and the size of the `event_ID in (...)` list issued
 * against SiemDelivery for that chunk. A prior version read every SiemOutbox.ID with no
 * limit, then issued one `event_ID in (...)` against SiemDelivery sized to the *entire*
 * backlog — measured at 12,002 rows fetched against a 3000-row backlog, and it hard-fails
 * once the backlog passes Postgres's ~65535-parameter cap (`bind message has N parameter
 * formats but 0 parameters`). Chunking bounds both the rows fetched per query and the
 * parameter count per query to this constant (plus sinkNames.length for the sink filter),
 * regardless of how large SiemOutbox grows.
 */
export const RECONCILE_CHUNK_SIZE = 500;

/**
 * Default `reconcile_lookback_ms` (siemConfigResolver.ts reads the `siem` block's own
 * setting; this is what applies when it is absent). 24 hours: long enough to cover a sink
 * outage or a missed deploy window, short enough that the scan below stays bounded by
 * "how much landed recently" rather than by the outbox's total retained history — see
 * reconcileOutbox's doc comment for the backfill trade this implies.
 */
export const DEFAULT_RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Self-heals SiemOutbox rows that are missing a SiemDelivery row for a currently-enabled
 * sink — whatever the cause: a config-read failure at ingest (securityEventSubscriber.ts)
 * that wrote the outbox row with no sinks, or a sink added to configuration after older rows
 * were already written. readUndelivered only ever looks at SiemDelivery, so an outbox row
 * with no delivery row for a sink is otherwise invisible to that sink forever. Called once per
 * dispatcher tick, before dispatch, so an orphan is repaired on the very next tick after it
 * (or the enabling config) exists.
 *
 * Only ID columns are read here — never the LargeString payload — so scanning the outbox and
 * delivery ID sets each tick stays cheap even as the table grows into the millions of rows.
 * The scan itself is paged in RECONCILE_CHUNK_SIZE-row windows (ordered by createdAt, ID for a
 * stable cursor) so no single query's row count or `in (...)` parameter count grows with the
 * backlog — see RECONCILE_CHUNK_SIZE.
 *
 * `lookbackMs` additionally filters the scan to `SiemOutbox.createdAt >= now - lookbackMs`
 * (default DEFAULT_RECONCILE_LOOKBACK_MS). Two problems this fixes, both measured against
 * this function's pre-lookback version: (1) with no filter, every tick pages the *entire*
 * retained outbox regardless of how much of it is already fully delivered — 35 ms at 2k rows
 * rising to 292 ms at 10k on in-memory sqlite, and real Postgres over a network only gets
 * slower as the table grows, eventually not finishing before the next tick fires; (2) enabling
 * a brand-new sink backfills a delivery row for *every* retained outbox row in one pass —
 * 48,000 created in a single measured call — replaying the entire retained history to a SIEM
 * endpoint that has never seen it before.
 *
 * **Filtered on `createdAt` (when the row actually landed in this table), not `occurredAt`
 * (the event's own upstream-supplied timestamp) — deliberately.** This is a repair pass over
 * SiemOutbox rows that are *already here*; the question it answers is "how far back in this
 * table's own arrival order is it still worth looking for an orphan," which is exactly what
 * `createdAt` means, and exactly what the paging `orderBy('createdAt asc', ...)` above already
 * sorts by — filtering and ordering on the same clock keeps the scan a single consistent walk.
 * `occurredAt` is not that clock: it is supplied by the event source and can be arbitrarily
 * stale relative to when the row actually landed — a stream entry left unacked and reclaimed
 * by XAUTOCLAIM a day later, or a gateway with a skewed clock, both write a row with an old
 * `occurredAt` but a fresh `createdAt`. Filtering on `occurredAt` would make exactly that row —
 * freshly landed, still well within reach of a repair pass — permanently invisible to
 * reconcile if its ingest-time config read had failed and it needed healing; that defeats the
 * reason this function exists.
 *
 * **The trade this makes, stated explicitly**: an outbox row that landed (by `createdAt`)
 * before the lookback window is *not* backfilled to a sink enabled after that row was
 * written — it heals only if it is still within the lookback window at the time reconcile next
 * runs. This is intentional, not an oversight: a newly enabled sink is meant to start receiving
 * events going forward (plus a bounded recent-history catch-up), not replay months of retained
 * audit history on its first tick. An operator who genuinely needs the older history backfilled
 * to a new sink must widen `reconcile_lookback_ms` (or run a one-off backfill) — this function
 * will not do it silently.
 *
 * A chunk that fails (e.g. a transient DB error) is logged at `error` — loud enough that an
 * operator notices, unlike the tick-level `warn` this replaces — and reconciliation continues
 * with the remaining chunks rather than aborting the whole pass. Aborting on the first bad
 * chunk would mean one persistently-failing chunk blocks every *other* orphan from healing on
 * every tick, forever; continuing means only that chunk's rows stay unhealed until they
 * succeed on a later tick (this function re-scans from the start every call, so a failed chunk
 * is retried, not skipped permanently), while unrelated orphans still heal on schedule.
 */
export async function reconcileOutbox(
  sinkNames: string[],
  lookbackMs: number = DEFAULT_RECONCILE_LOOKBACK_MS
): Promise<number> {
  if (sinkNames.length === 0) return 0;
  const db = await cds.connect.to('db');
  const { SELECT, INSERT } = cds.ql;
  const cutoff = new Date(Date.now() - lookbackMs).toISOString();

  let created = 0;
  let offset = 0;

  for (;;) {
    const outboxRows: Array<{ ID: string }> = await db.run(
      SELECT.from('sap.llm.gateway.admin.SiemOutbox')
        .columns('ID')
        .where({ createdAt: { '>=': cutoff } })
        .orderBy('createdAt asc', 'ID asc')
        .limit(RECONCILE_CHUNK_SIZE, offset)
    );
    if (outboxRows.length === 0) break;
    const outboxIds = outboxRows.map(r => r.ID);

    try {
      const existing: Array<{ event_ID: string; sinkName: string }> = await db.run(
        SELECT.from('sap.llm.gateway.admin.SiemDelivery')
          .columns('event_ID', 'sinkName')
          .where({ event_ID: { in: outboxIds }, sinkName: { in: sinkNames } })
      );
      const existingKeys = new Set(existing.map(e => `${e.event_ID}::${e.sinkName}`));

      const toCreate: Array<{ ID: string; event_ID: string; sinkName: string; status: string; attempts: number }> = [];
      for (const id of outboxIds) {
        for (const sink of sinkNames) {
          if (!existingKeys.has(`${id}::${sink}`)) {
            toCreate.push({ ID: uuidv4(), event_ID: id, sinkName: sink, status: 'pending', attempts: 0 });
          }
        }
      }

      if (toCreate.length > 0) {
        await db.run(INSERT.into('sap.llm.gateway.admin.SiemDelivery').entries(toCreate));
        created += toCreate.length;
      }
    } catch (error) {
      logger.error(
        'SiemOutboxReconcile',
        'Failed to reconcile a chunk of outbox rows; continuing with remaining chunks',
        error as Error,
        { chunkOffset: offset, chunkRows: outboxIds.length }
      );
    }

    if (outboxRows.length < RECONCILE_CHUNK_SIZE) break;
    offset += RECONCILE_CHUNK_SIZE;
  }

  return created;
}

/** Mark the delivery row for each event/sink pair as delivered. */
export async function markDelivered(ids: string[], sink: string): Promise<void> {
  if (ids.length === 0) return;
  const db = await cds.connect.to('db');
  await db.run(
    cds.ql.UPDATE('sap.llm.gateway.admin.SiemDelivery')
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where({ event_ID: { in: ids }, sinkName: sink })
  );
}

/**
 * A row's delivery is given up on after this many failed attempts and marked `expired`
 * instead of retried forever. 10 spans a real outage without giving up prematurely: with the
 * dispatcher's own retryable backoff (1s doubling to a 5-minute cap), 10 attempts covers well
 * over an hour of retrying a sink that is merely down. For a permanently-rejecting endpoint
 * (a 400, non-retryable, backoff x4) it still reaches the cap within a handful of attempts, so
 * a poison event that keeps failing on its own stops accruing attempts eventually rather than
 * forever — dispatcher.ts's per-row settlement (see settleIndividually) already keeps a poison
 * event from blocking its batchmates; this cap bounds how long it keeps being retried at all.
 */
export const DEFAULT_MAX_ATTEMPTS = 10;

export interface ExpiredRow {
  ID: string;
  attempts: number;
}

/**
 * Record a failed delivery attempt. A row that has now reached `maxAttempts` is marked
 * `expired` (its `lastError` retained) and excluded from readUndelivered's `status: 'pending'`
 * filter, so one permanently-rejected event can no longer block every event behind it in the
 * batch forever. Reads current `attempts` first (rather than a raw `attempts = attempts + 1`
 * SQL expression) so the same call can also set `lastError` and `lastAttemptAt`. Returns the
 * rows that expired on this call so the caller can log a warning — an expired row is a
 * silently dropped audit event, the thing this whole design exists to prevent.
 */
export async function markFailed(
  ids: string[],
  sink: string,
  error: string,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<ExpiredRow[]> {
  if (ids.length === 0) return [];
  const db = await cds.connect.to('db');
  const { SELECT, UPDATE } = cds.ql;

  const rows: Array<{ ID: string; attempts: number }> = await db.run(
    SELECT.from('sap.llm.gateway.admin.SiemDelivery')
      .columns('ID', 'attempts')
      .where({ event_ID: { in: ids }, sinkName: sink })
  );

  const now = new Date();
  const expired: ExpiredRow[] = [];
  for (const row of rows) {
    const attempts = (row.attempts || 0) + 1;
    const isExpired = attempts >= maxAttempts;
    await db.run(
      UPDATE('sap.llm.gateway.admin.SiemDelivery')
        .set({
          attempts,
          lastError: error,
          lastAttemptAt: now,
          ...(isExpired ? { status: 'expired' } : {}),
        })
        .where({ ID: row.ID })
    );
    if (isExpired) expired.push({ ID: row.ID, attempts });
  }

  return expired;
}
