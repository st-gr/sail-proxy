// A strictly-optional, low-latency wake-up hint for the file_search
// ingestion worker, published whenever a file is attached to a vector store.
// NEVER the source of truth — the `vector_store_files` row is (see the
// design doc: "the database row is the source of truth; valkey is an
// accelerator") — this exists purely so a newly-attached file doesn't have
// to wait out ingestWorker.ts's poll interval. Absent VALKEY_URL (or valkey
// unreachable), publish/subscribe are both silent no-ops and the worker
// drains entirely via polling, unaffected — see ingestWorker.test.ts and
// ingestHint.test.ts.
//
// Lives in its own module rather than inside repository.ts or
// ingestWorker.ts directly so the two can depend on this without depending
// on each other: repository.ts's enqueueIngestion publishes here,
// ingestWorker.ts subscribes here, and neither imports the other's module
// for this purpose (avoiding a repository.ts <-> ingestWorker.ts import
// cycle — ingestWorker.ts already imports repository.ts for
// assertStoreDimension).
import Redis from 'iovalkey';
import { shouldEnableDistributedCaching } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

const CHANNEL = 'file_search:ingest_hint';

// undefined = not yet attempted; null = valkey unavailable/disabled (a
// stable "don't try again" answer for this process's lifetime, matching how
// getPool() in db.ts caches its own "unavailable" answer).
let publisher: Redis | null | undefined;

function getPublisher(): Redis | null {
  if (publisher !== undefined) return publisher;
  if (!shouldEnableDistributedCaching()) {
    publisher = null;
    return publisher;
  }
  try {
    const client = new Redis(process.env.VALKEY_URL!);
    client.on('error', (err: any) => {
      logger.debug('IngestHint', `Valkey publisher error (accelerator only; polling still drains the queue): ${err?.message}`);
    });
    publisher = client;
  } catch (err: any) {
    logger.debug('IngestHint', `Failed to create valkey publisher (accelerator only): ${err?.message}`);
    publisher = null;
  }
  return publisher;
}

/**
 * Best-effort wake hint. Never throws — a failure here must never fail the
 * caller's request (attaching a file): the `vector_store_files` row it just
 * wrote is already the real signal, this is purely a latency shortcut.
 */
export async function publishIngestHint(storeId: string, fileId: string): Promise<void> {
  const client = getPublisher();
  if (!client) return;
  try {
    await client.publish(CHANNEL, JSON.stringify({ storeId, fileId }));
  } catch (err: any) {
    logger.debug('IngestHint', `Failed to publish an ingest hint (accelerator only): ${err?.message}`);
  }
}

export interface IngestHintSubscription {
  close(): Promise<void>;
}

/**
 * Best-effort subscription: calls `onHint` for every hint published on the
 * channel. Returns a no-op subscription (close() resolves immediately) when
 * valkey isn't configured — the caller (ingestWorker.ts) must keep polling
 * regardless of whether this ever fires; that property is what keeps this a
 * pure accelerator rather than a second source of truth.
 */
export function subscribeIngestHints(onHint: () => void): IngestHintSubscription {
  if (!shouldEnableDistributedCaching()) {
    return { async close() {} };
  }
  let client: Redis | null = null;
  try {
    client = new Redis(process.env.VALKEY_URL!);
    client.on('error', (err: any) => {
      logger.debug('IngestHint', `Valkey subscriber error (accelerator only; polling still drains the queue): ${err?.message}`);
    });
    client.on('message', (channel: string) => {
      if (channel === CHANNEL) onHint();
    });
    client.subscribe(CHANNEL).catch((err: any) => {
      logger.debug('IngestHint', `Failed to subscribe to ingest hints (accelerator only): ${err?.message}`);
    });
  } catch (err: any) {
    logger.debug('IngestHint', `Failed to create valkey subscriber (accelerator only): ${err?.message}`);
    client = null;
  }
  const subscribed = client;
  return {
    async close() {
      if (!subscribed) return;
      try {
        await subscribed.disconnect();
      } catch {
        // best-effort cleanup; nothing to react to
      }
    },
  };
}

/**
 * Disconnects the lazily-created publisher connection, if one was ever
 * opened. `publishIngestHint` reuses a single module-level connection
 * across calls (see `getPublisher`) rather than opening one per publish;
 * without this, that connection outlives `stopIngestWorker` (which only
 * closes the subscriber side) for the remaining life of the process —
 * harmless for a real process exit, but an accumulating handle across
 * repeated start/stop cycles (e.g. in tests, or a hot-reload). Safe to call
 * even if no connection was ever opened, or if valkey was never configured.
 */
export async function closePublisher(): Promise<void> {
  const client = publisher;
  publisher = undefined;
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    // best-effort cleanup; nothing to react to
  }
}

export function __resetForTests(): void {
  publisher = undefined;
}
