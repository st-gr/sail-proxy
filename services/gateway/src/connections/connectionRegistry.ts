/**
 * The gateway's in-memory Connections snapshot (spec 2026-10-23 §4.2). Refetched when the admin's
 * change marker arrives (markStale, wired in index.ts) or once it is older than SNAPSHOT_TTL_MS,
 * which also catches a list price that expired by date. Single-flight; a failed refetch keeps the
 * last snapshot - an admin outage must not take external models down - and is retried after
 * RETRY_AFTER_FAILURE_MS. The snapshot holds credentials: log names and counts, never content.
 *
 * Imports nothing but types and the logger: modelService and the entitlement rules load it, and
 * neither may pull in configService or the admin client (index.ts attaches the admin backend).
 */
import { getDefaultLogger } from '@libs/logger';
import type { Connection, ConnectionBackend, ConnectionModel } from './types';

const logger = getDefaultLogger();

export const SNAPSHOT_TTL_MS = 60_000;
export const RETRY_AFTER_FAILURE_MS = 10_000;
/** The longest a request waits for a refetch the change marker asked for. */
export const FRESH_WAIT_MS = 1_500;

export class ConnectionRegistry {
  private snapshot: Connection[] = [];
  private fetchedAt: number | null = null;
  private failedAt: number | null = null;
  private stale = true;
  private inFlight: Promise<void> | null = null;
  /** Bumped by markStale; a fetch that started before a bump does not count as fresh. */
  private generation = 0;
  private inFlightGeneration = 0;
  private shadowed = new Set<string>();
  private refreshListeners: Array<(connections: Connection[]) => void> = [];

  constructor(private backend: ConnectionBackend | null, private readonly now: () => number = Date.now) {}

  /** Attach the snapshot's source; index.ts does this at startup: the admin backend, or connections.json when standalone. */
  setBackend(backend: ConnectionBackend | null): void {
    this.backend = backend;
    this.markStale();
  }

  /** Called after every successful snapshot refresh with the new snapshot (the SAP target follows it). */
  onRefresh(listener: (connections: Connection[]) => void): void {
    this.refreshListeners.push(listener);
  }

  /** Refetches when stale or past the TTL; never rejects. */
  ensureFresh(): Promise<void> {
    if (!this.backend) return Promise.resolve();
    // A change marked after the in-flight fetch started is not in its result: fetch again after it.
    if (this.inFlight) return this.inFlightGeneration === this.generation ? this.inFlight : this.inFlight.then(() => this.ensureFresh());
    const t = this.now();
    if (this.failedAt !== null && t - this.failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
    const expired = this.fetchedAt === null || t - this.fetchedAt >= SNAPSHOT_TTL_MS;
    if (!this.stale && !expired) return Promise.resolve();
    this.inFlightGeneration = this.generation;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * For the request path (getModels runs on every inference request): waits only for the very
   * first load; once a snapshot exists a due refetch runs in the background and the caller goes on
   * with the current one, so a slow admin never adds latency to a request.
   */
  refreshInBackground(): Promise<void> {
    if (this.fetchedAt === null && this.failedAt === null) return this.ensureFresh();
    void this.ensureFresh();
    return Promise.resolve();
  }

  /**
   * For the per-request dispatch decision (upstreams/externalTarget.ts): a refetch the change
   * marker asked for is waited for, because the admin has just changed something and a model
   * published a moment ago would otherwise be unknown to this request and fall to SAP. A refetch
   * that is only due by TTL runs in the background, as for the model list.
   *
   * Every inference route asks, SAP traffic included, so the wait is bounded: never while the last
   * fetch failed (the admin is in trouble; SAP requests must not wait on it) and at most
   * FRESH_WAIT_MS for a slow admin. Before the first load this is refreshInBackground's first-load wait.
   */
  refreshForRequest(): Promise<void> {
    if (!this.stale || this.fetchedAt === null || this.failedAt !== null) return this.refreshInBackground();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, FRESH_WAIT_MS); });
    return Promise.race([this.ensureFresh(), cap]).finally(() => clearTimeout(timer));
  }

  private async refresh(): Promise<void> {
    const generation = this.generation;
    try {
      const connections = await this.backend!.fetch();
      this.snapshot = Array.isArray(connections) ? connections : [];
      this.fetchedAt = this.now();
      this.failedAt = null;
      this.stale = this.generation !== generation;
      logger.debug('ConnectionRegistry', `Connections snapshot: ${this.snapshot.length} connection(s), ${this.publishedModels().length} published model(s)`);
    } catch (error) {
      this.failedAt = this.now();
      // The error's name only: a response body or message could echo the snapshot.
      logger.warn('ConnectionRegistry', `Connections snapshot refresh failed (${(error as Error)?.name ?? 'Error'}); keeping ${this.snapshot.length} connection(s) from the last one`);
      return;
    }
    for (const listener of this.refreshListeners) {
      try {
        listener(this.snapshot);
      } catch (error) {
        logger.warn('ConnectionRegistry', `A snapshot listener failed (${(error as Error)?.name ?? 'Error'})`);
      }
    }
  }

  markStale(): void {
    this.generation++;
    this.stale = true;
    this.failedAt = null;
  }

  connections(): Connection[] {
    return this.snapshot;
  }

  /** The models of active connections: what the model list shows. */
  publishedModels(): Array<{ connection: Connection; model: ConnectionModel }> {
    return this.snapshot.filter((c) => c.isActive !== false)
      .flatMap((connection) => (connection.models || []).map((model) => ({ connection, model })));
  }

  /**
   * A published Connection model id that no SAP model shadows, active connection or not: an id of a
   * switched-off connection stays opt-in and stays off the SAP path (it answers 503).
   */
  isExternalModelId(id: string): boolean {
    return this.resolveExternal(id) !== undefined;
  }

  /** The connection and model serving `id`, active or not; undefined for any other id, or a shadowed one. */
  resolveExternal(id: string): { connection: Connection; model: ConnectionModel } | undefined {
    if (this.shadowed.has(id)) return undefined;
    for (const connection of this.snapshot) {
      const model = (connection.models || []).find((m) => m.modelId === id);
      if (model) return { connection, model };
    }
    return undefined;
  }

  /** The external ids the last model-list merge dropped because an SAP model has the same id. */
  setShadowed(ids: Iterable<string>): void {
    this.shadowed = new Set(ids);
  }

  getConnection(id: string): Connection | undefined {
    return this.snapshot.find((c) => c.id === id);
  }
}

/** Empty until index.ts attaches a backend (the admin, or connections.json when standalone); a non-standalone gateway without an admin has none. */
export const connectionRegistry = new ConnectionRegistry(null);
