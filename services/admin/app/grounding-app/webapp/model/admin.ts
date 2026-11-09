/**
 * Rows and tiles for the Administration screen. No UI5 imports: these run under jest. The controller
 * injects the resource bundle and passes the cockpit language as `locale`; jest passes neither.
 * Dates: stores, files and failed ingestions carry Unix seconds, jobs carry ISO strings.
 */
import { formatBytes, formatUnixSeconds } from './format';
import { toStoreRow, toFileRows, reembeddable, rechunkable, StoreRow, FileRow } from './rows';
import { toJobRow, hasAdminJobActions, blobStorageText, JobRow, Translator } from './jobs';
import { fileErrorText } from './status';
import type { ValueState } from './status';

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  adminTileStores: 'Vector Stores', adminTileFiles: 'Files', adminTileLogicalBytes: 'Uploaded Size',
  adminTilePhysicalBytes: 'Stored Size', adminTileSavings: 'Deduplication Savings', adminTileFailed: 'Failed Ingestions',
  adminTileOutdated: 'Outdated Stores',
  blobStorage_db: 'Database', blobStorage_s3: 'S3',
  blobS3Ready: 'Configured', blobS3NotConfigured: 'Not configured', blobS3NoCredentials: 'Configured, credentials missing',
  blobStorageAvailable: 'Reachable', blobStorageUnreachable: 'Not reachable',
  blobGarbageText: '{0} queued, {1} due',
  blobGarbageFailing: '{0} queued object deletion(s) failed and are being retried. Check the S3 permissions.',
  blobOutsidePrefix: '{0} blob(s) in S3 are stored under another prefix and cannot be read with the current one. Set the previous prefix again to read them.',
  blobMigrationTargetDiffers: 'New uploads still go to {0}. Set the blob storage backend to {1} in the configuration as well, or new files keep arriving in {0}.',
  blobTestOk: 'The S3 bucket answered: the connection works.',
  blobTestNotConfigured: 'S3 is not configured, or its credentials are missing.',
  blobTestFailed: 'The S3 connection test failed ({0}).',
  jobState_queued: 'Queued', jobState_running: 'Running', jobState_cancelling: 'Cancelling', jobState_cancelled: 'Cancelled', jobState_completed: 'Completed',
  jobState_completed_with_errors: 'Completed with errors', jobState_failed: 'Failed'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

export interface OverviewTile { key: string; label: string; value: string }

const count = (value: unknown, locale: string): string => (Number(value) || 0).toLocaleString(locale);

/** The overview's seven tiles, in display order. */
export function overviewTiles(overview: any, t: Translator = defaultTranslate, locale = 'en-US'): OverviewTile[] {
  const o = overview || {};
  return [
    { key: 'stores', label: t('adminTileStores'), value: count(o.stores, locale) },
    { key: 'files', label: t('adminTileFiles'), value: count(o.files, locale) },
    { key: 'logicalBytes', label: t('adminTileLogicalBytes'), value: formatBytes(o.logical_bytes, locale) },
    { key: 'physicalBytes', label: t('adminTilePhysicalBytes'), value: formatBytes(o.physical_bytes, locale) },
    { key: 'savings', label: t('adminTileSavings'), value: formatBytes(o.savings_bytes, locale) },
    { key: 'failedIngestions', label: t('adminTileFailed'), value: count(o.failed_ingestions, locale) },
    { key: 'outdated', label: t('adminTileOutdated'), value: count(o.outdated_stores, locale) }
  ];
}

export type AdminStoreRow = StoreRow;

/** A store of anyone: the shared-aware store object (owner, badge, status texts). An admin may re-embed any owner's outdated store and re-chunk any owner's store. */
export function toAdminStoreRow(store: any, t?: Translator, locale = 'en-US'): AdminStoreRow {
  const row = toStoreRow(store, t, locale);
  return {
    ...row,
    canReembed: reembeddable(row.embeddingState, store.status, row.reembedJobId),
    canChangeChunking: rechunkable(row.embeddingState, store.status, row.reembedJobId)
  };
}

export interface AdminFileRow extends FileRow { ownerEmail: string; attachments: number }

/** An admin file row: Unix-seconds date, size from `bytes`, the owner and how many stores hold it. */
export function toAdminFileRow(file: any, locale = 'en-US'): AdminFileRow {
  const [row] = toFileRows([file], {}, locale);
  return { ...row, ownerEmail: file.owner_email || '', attachments: Number(file.attachment_count) || 0, storeCount: Number(file.attachment_count) || 0 };
}

export interface FailedRow {
  id: string; storeId: string; storeName: string; fileId: string; filename: string; ownerEmail: string;
  message: string; attempts: number; batchId: string; created: string;
}

/** A failed ingestion: only the sanitised message is shown, never the error's class name or any raw body. */
export function toFailedRow(row: any, locale = 'en-US'): FailedRow {
  return {
    id: row.id || `${row.store_id}/${row.file_id}`,
    storeId: row.store_id || '',
    storeName: row.store_name || row.store_id || '',
    fileId: row.file_id || '',
    filename: row.filename || row.file_id || '',
    ownerEmail: row.owner_email || '',
    message: fileErrorText(row.last_error),
    attempts: Number(row.attempts) || 0,
    batchId: row.batch_id || '',
    created: formatUnixSeconds(row.created_at, locale)
  };
}

export interface StorageRow { ownerEmail: string; files: number; bytes: number; size: string }

export function toStorageRow(row: any, locale = 'en-US'): StorageRow {
  return {
    ownerEmail: row.owner_email || '',
    files: Number(row.file_count) || 0,
    bytes: Number(row.logical_bytes) || 0,
    size: formatBytes(row.logical_bytes, locale)
  };
}

export interface AdminJobRow extends JobRow { ownerEmail: string }

/**
 * Everyone's jobs. Only re-embed jobs and blob migrations can be cancelled and retried here (the admin routes act
 * on any owner's); a file batch stays read-only: only its owner may cancel or retry it.
 */
export function toAdminJobRow(job: any, t?: Translator, locale = 'en-US'): AdminJobRow {
  const row = toJobRow(job, t, locale);
  const actions = hasAdminJobActions(job.kind);
  return { ...row, ownerEmail: job.owner_email || '', canCancel: actions && row.canCancel, canRetry: actions && row.canRetry };
}

/** The Administration screen's tabs; the route's optional `tab` segment names one. */
export const ADMIN_TABS = ['overview', 'stores', 'files', 'failed', 'storage', 'jobs'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
export type AdminListTab = Exclude<AdminTab, 'overview'>;

/** The tab a route argument names; anything else opens the overview. */
export function adminTabOf(value: unknown): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value as string) ? value as AdminTab : 'overview';
}

export interface AdminFilters { owner?: string; status?: string; state?: string; shared?: string; embeddingState?: string }
export interface AdminListOptions { owner?: string; status?: string; state?: string; shared?: boolean; embedding_state?: string; after?: string; limit: number }

/**
 * How a list loads: `apply` starts from the first page with the filter fields as they stand (a filter
 * submitted or chosen, Refresh, the tab entered); `more` appends the next page; `quiet` reloads the shown
 * rows (the jobs refresh); `keep` reloads the first page after a delete or retry.
 */
export type AdminLoadMode = 'apply' | 'more' | 'quiet' | 'keep';

/**
 * The filters a load uses. Only `apply` reads the fields; the other loads reuse the filters the list's
 * last first page was loaded with, so a value typed into the owner field but not submitted does not
 * leak into "More" or a refresh of the rows already shown.
 */
export function filtersForLoad(mode: AdminLoadMode, live: AdminFilters, applied: AdminFilters | undefined): AdminFilters {
  if (mode !== 'apply' && applied) return applied;
  return { owner: live.owner || '', status: live.status || '', state: live.state || '', shared: live.shared || '', embeddingState: live.embeddingState || '' };
}

/**
 * One list page's query options, in the order owner, status|state, shared, embedding_state, after, limit. Only
 * the filters the list knows are passed (owner: stores, files, failed, jobs; status, shared and embedding_state:
 * stores; state: jobs); an empty filter is left out. `shared` comes from a select key: 'true', 'false' or '' for both.
 */
export function adminListOptions(tab: AdminListTab, filters: AdminFilters, after: string, limit: number): AdminListOptions {
  const options: AdminListOptions = {} as AdminListOptions;
  const owner = (filters.owner || '').trim();
  if (owner && tab !== 'storage') options.owner = owner;
  if (tab === 'stores' && filters.status) options.status = filters.status;
  if (tab === 'jobs' && filters.state) options.state = filters.state;
  if (tab === 'stores' && (filters.shared === 'true' || filters.shared === 'false')) options.shared = filters.shared === 'true';
  if (tab === 'stores' && filters.embeddingState) options.embedding_state = filters.embeddingState;
  if (after) options.after = after;
  options.limit = limit;
  return options;
}

// ---------------------------------------------------------------------------
// Blob storage panel (GET /admin/blob-storage)
// ---------------------------------------------------------------------------

/** The storages a migration can move blobs to. */
export const BLOB_MIGRATION_TARGETS = ['db', 's3'] as const;

export interface BlobStorageRow {
  storage: string; storageText: string; liveBlobs: string; liveSize: string; releasedBlobs: string; releasedSize: string;
  addressable: boolean; statusText: string; statusState: ValueState;
}

export interface BlobMigrationView {
  id: string; target: string; targetText: string; state: string; stateText: string; stateColor: ValueState; active: boolean;
  progress: string; percent: number; failed: number; canCancel: boolean;
}

export interface BlobPanel {
  backend: string; backendText: string;
  s3Text: string; s3State: ValueState; s3Configured: boolean; prefix: string;
  rows: BlobStorageRow[];
  /** Blobs sit in a storage this gateway cannot address (S3 not configured or without credentials, an unknown storage). */
  unreachable: boolean;
  garbageText: string; garbageFailing: number; garbageFailingText: string;
  /** S3 blobs stored under another prefix than the configured one (unreadable until it is set back). */
  outsidePrefix: number; outsidePrefixText: string;
  migration: BlobMigrationView | null;
  /** Set while a migration is active and its target is not the configured backend. */
  migrationWarning: string;
  /** No migration is active: a new one may start. */
  canMigrate: boolean;
}

const MIGRATION_ACTIVE = ['queued', 'running', 'cancelling'];

/** The panel's migration: progress counts every item that is settled (done, failed, cancelled). */
export function toBlobMigrationView(job: any, t: Translator = defaultTranslate): BlobMigrationView | null {
  if (!job || !job.id) return null;
  const row = toJobRow(job, t);
  const total = row.total;
  const settled = row.done + row.failed + row.cancelled;
  const target = String(job.target_storage || '');
  return {
    id: row.id, target, targetText: blobStorageText(target, t), state: row.state, stateText: row.stateText, stateColor: row.stateColor,
    active: MIGRATION_ACTIVE.includes(row.state), progress: row.progress,
    percent: total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : 0,
    failed: row.failed, canCancel: row.canCancel
  };
}

/** The warning that a migration's target differs from the backend new uploads go to; '' when they agree. */
export function migrationWarning(target: string, backend: string, t: Translator = defaultTranslate): string {
  if (!target || !backend || target === backend) return '';
  return t('blobMigrationTargetDiffers', [blobStorageText(backend, t), blobStorageText(target, t)]);
}

/** The gateway's blob storage overview as the panel shows it. */
export function toBlobPanel(overview: any, t: Translator = defaultTranslate, locale = 'en-US'): BlobPanel {
  const o = overview || {};
  const s3 = o.s3 || {};
  const backend = String(o.configured_backend || '');
  const rows: BlobStorageRow[] = (Array.isArray(o.storages) ? o.storages : []).map((r: any) => {
    const addressable = r.addressable === true;
    return {
      storage: String(r.storage || ''),
      storageText: blobStorageText(r.storage, t),
      liveBlobs: count(r.live_blobs, locale),
      liveSize: formatBytes(r.live_bytes, locale),
      releasedBlobs: count(r.released_blobs, locale),
      releasedSize: formatBytes(r.released_bytes, locale),
      addressable,
      statusText: t(addressable ? 'blobStorageAvailable' : 'blobStorageUnreachable'),
      statusState: addressable ? 'Success' : 'Error'
    };
  });
  const garbage: any[] = Array.isArray(o.garbage) ? o.garbage : [];
  const sum = (field: string) => garbage.reduce((total, g) => total + (Number(g[field]) || 0), 0);
  const garbageFailing = sum('failing');
  const s3Configured = s3.configured === true;
  const s3Ready = s3Configured && s3.credentials_present === true;
  const migration = toBlobMigrationView(o.migration, t);
  const outsidePrefix = Number(s3.outside_prefix_blobs) || 0;
  return {
    backend,
    backendText: blobStorageText(backend, t),
    s3Text: t(s3Ready ? 'blobS3Ready' : s3Configured ? 'blobS3NoCredentials' : 'blobS3NotConfigured'),
    s3State: s3Ready ? 'Success' : backend === 's3' ? 'Error' : 'None',
    s3Configured,
    prefix: s3Configured ? String(s3.prefix || '') : '',
    rows,
    unreachable: (Array.isArray(o.storages) ? o.storages : []).some((r: any) => r.addressable !== true
      && (Number(r.live_blobs) || 0) + (Number(r.released_blobs) || 0) > 0),
    garbageText: t('blobGarbageText', [count(sum('entries'), locale), count(sum('due'), locale)]),
    garbageFailing,
    garbageFailingText: garbageFailing > 0 ? t('blobGarbageFailing', [count(garbageFailing, locale)]) : '',
    outsidePrefix,
    outsidePrefixText: outsidePrefix > 0 ? t('blobOutsidePrefix', [count(outsidePrefix, locale)]) : '',
    migration,
    migrationWarning: migration && migration.active ? migrationWarning(migration.target, backend, t) : '',
    canMigrate: !(migration && migration.active)
  };
}

/** What a migration to `target` would move: every blob (released ones included) stored anywhere else. */
export function blobsToMove(overview: any, target: string): { blobs: number; bytes: number } {
  const storages: any[] = Array.isArray(overview?.storages) ? overview.storages : [];
  return storages.filter((r) => r.storage !== target).reduce((acc, r) => ({
    blobs: acc.blobs + (Number(r.live_blobs) || 0) + (Number(r.released_blobs) || 0),
    bytes: acc.bytes + (Number(r.live_bytes) || 0) + (Number(r.released_bytes) || 0)
  }), { blobs: 0, bytes: 0 });
}

/** The connection test's answer as a message strip: its text and type. */
export function connectionTestResult(result: any, t: Translator = defaultTranslate): { text: string; type: ValueState } {
  if (result && result.ok === true) return { text: t('blobTestOk'), type: 'Success' };
  const error = (result && result.error) || {};
  if (error.reason === 'not_configured') return { text: t('blobTestNotConfigured'), type: 'Warning' };
  const detail = [error.op, typeof error.status === 'number' ? `HTTP ${error.status}` : '', error.code || error.reason]
    .filter((part) => typeof part === 'string' && part !== '').join(' ');
  return { text: t('blobTestFailed', [detail]), type: 'Error' };
}
