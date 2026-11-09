/** Maps the gateway's job summaries to table rows. No UI5 imports: these run under jest. */
import type { ValueState } from './status';
import { formatBytes } from './format';
import { chunkingText } from './chunking';

/**
 * Resolves an i18n key with optional {0} arguments — the controller injects the resource bundle;
 * jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  jobState_queued: 'Queued', jobState_running: 'Running', jobState_cancelling: 'Cancelling', jobState_cancelled: 'Cancelled',
  jobState_completed: 'Completed', jobState_completed_with_errors: 'Completed with errors', jobState_failed: 'Failed',
  jobKind_file_batch: 'File batch', jobKind_reembed_store: 'Re-embed', jobKind_reembed_bulk: 'Re-embed of outdated stores',
  jobKind_blob_migration: 'Blob migration', jobKind_rechunk: 'Re-chunk', jobKind_reextract: 'Re-read files', blobStorage_db: 'Database', blobStorage_s3: 'S3'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const COLOR: Record<string, ValueState> = {
  queued: 'Information', running: 'Information', cancelling: 'Warning', cancelled: 'Warning',
  completed: 'Success', completed_with_errors: 'Warning', failed: 'Error'
};
const ACTIVE = ['queued', 'running', 'cancelling'];

export interface JobRow {
  id: string; kind: string; kindText: string; storeId: string; storeName: string; batchId: string;
  state: string; stateText: string; stateColor: ValueState; active: boolean;
  progress: string; total: number; done: number; failed: number; cancelled: number; inProgress: number; tokens: string;
  created: string; started: string; finished: string; startedBy: string;
  errorText: string; canCancel: boolean; canRetry: boolean;
  /** A re-chunk (a store job with a target setting): the setting it switches the store to and its context counters. */
  rechunk: boolean; targetChunkingText: string;
  /** The re-chunk's target writes a context per chunk: the context counters are shown. */
  contextual: boolean;
  contextInputTokens: string; contextCachedTokens: string; contextOutputTokens: string; contextFailedChunks: string;
  /** PDF pages without a text layer: read by OCR, left without OCR text, written by the vision model, selected for
   *  vision but kept their text. Grouped like the tokens; "0" hides the counter on the detail page. */
  ocrPages: string; ocrSkippedPages: string; visionPages: string; visionSkippedPages: string;
}

export function jobStateText(state: string | null | undefined, t: Translator = defaultTranslate): string {
  if (!state) return '';
  const key = `jobState_${state}`;
  const text = t(key);
  // An unknown state has no key: show the raw state, as before.
  return text === key ? state : text;
}

export function jobKindText(kind: string | null | undefined, t: Translator = defaultTranslate): string {
  if (!kind) return '';
  const key = `jobKind_${kind}`;
  const text = t(key);
  return text === key ? kind : text;
}

/** A re-embed of one store or the bulk re-embed of every outdated store (admins may cancel and retry these for anyone). */
export function isReembedKind(kind: string | null | undefined): boolean {
  return kind === 'reembed_store' || kind === 'reembed_bulk';
}

/** A blob migration moves every blob between storage backends; only admins start, see and act on one. */
export function isBlobMigrationKind(kind: string | null | undefined): boolean {
  return kind === 'blob_migration';
}

/** The kinds an admin may cancel and retry for anyone on the admin routes: re-embeds and blob migrations. */
export function hasAdminJobActions(kind: string | null | undefined): boolean {
  return isReembedKind(kind) || isBlobMigrationKind(kind);
}

export function jobStateColor(state: string | null | undefined): ValueState {
  return (state && COLOR[state]) || 'None';
}

/** True while the worker may still change the job: the screen keeps polling. */
export function isActive(state: string | null | undefined): boolean {
  return !!state && ACTIVE.includes(state);
}

export function progressText(job: { done?: number; total?: number }): string {
  return `${Number(job.done) || 0}/${Number(job.total) || 0}`;
}

/** `locale` is the cockpit language the controller passes; jest passes none and gets 'en-US'. */
export function formatTokens(tokens: number | string | null | undefined, locale = 'en-US'): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '0';
  return Math.round(value).toLocaleString(locale);
}

/** A job timestamp (an ISO string, unlike the Unix seconds of files and stores) as a short UTC date and time. */
export function formatIsoTime(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
}

/** A store job with a target chunking setting re-chunks the store; a plain re-embed has none. */
export function isRechunkJob(job: any): boolean {
  return job?.kind === 'reembed_store' && typeof job.target_chunking === 'object' && job.target_chunking !== null;
}

/** `t` is the injected bundle; without one (jest) the English defaults of each module apply. */
export function toJobRow(job: any, translate?: Translator, locale = 'en-US'): JobRow {
  const t = translate ?? defaultTranslate;
  const rechunk = isRechunkJob(job);
  const state = String(job.state || '');
  const failed = Number(job.failed) || 0;
  // A file batch with failures completes with errors; a re-embed fails as a whole, a bulk re-embed or a blob
  // migration may do either.
  const retryable = hasAdminJobActions(job.kind) ? state === 'failed' || state === 'completed_with_errors' : state === 'completed_with_errors';
  return {
    id: job.id,
    kind: String(job.kind || ''),
    // A re-extract is a re-chunk to the store's own setting that reads only the files an older version read.
    kindText: rechunk ? t(job.reextract === true ? 'jobKind_reextract' : 'jobKind_rechunk') : jobKindText(job.kind, t),
    storeId: job.store_id || '',
    storeName: job.store_name || job.store_id || '',
    batchId: job.batch_id || '',
    state,
    stateText: jobStateText(state, t),
    stateColor: jobStateColor(state),
    active: isActive(state),
    progress: progressText(job),
    total: Number(job.total) || 0,
    done: Number(job.done) || 0,
    failed,
    cancelled: Number(job.cancelled) || 0,
    inProgress: Number(job.in_progress) || 0,
    tokens: formatTokens(job.embedding_tokens, locale),
    created: formatIsoTime(job.created_at, locale),
    started: formatIsoTime(job.started_at, locale),
    finished: formatIsoTime(job.finished_at, locale),
    startedBy: job.started_by || '',
    errorText: job.error && typeof job.error.message === 'string' ? job.error.message : '',
    canCancel: state === 'queued' || state === 'running',
    canRetry: retryable && failed > 0,
    rechunk,
    targetChunkingText: rechunk ? chunkingText(job.target_chunking, translate) : '',
    contextual: rechunk && job.target_chunking.contextual === true,
    contextInputTokens: formatTokens(job.context_input_tokens, locale),
    contextCachedTokens: formatTokens(job.context_cached_tokens, locale),
    contextOutputTokens: formatTokens(job.context_output_tokens, locale),
    contextFailedChunks: formatTokens(job.context_failed_chunks, locale),
    ocrPages: formatTokens(job.ocr_pages, locale),
    ocrSkippedPages: formatTokens(job.ocr_skipped_pages, locale),
    visionPages: formatTokens(job.vision_pages, locale),
    visionSkippedPages: formatTokens(job.vision_skipped_pages, locale)
  };
}

export interface ReembedFailureRow { key: string; storeName: string; filename: string; error: string; attempts: number }

/**
 * The gateway's failed re-embed items as table rows. A deleted file keeps its id as its name; the
 * error is the gateway's sanitised English message, shown as sent (like a batch's file errors).
 */
export function toReembedFailureRows(items: any[]): ReembedFailureRow[] {
  return (items || []).map((item) => ({
    key: String(item.id || ''),
    storeName: item.store_name || item.store_id || '',
    filename: item.filename || item.file_id || '',
    error: item.last_error && typeof item.last_error.message === 'string' ? item.last_error.message : '',
    attempts: Number(item.attempts) || 0
  }));
}

/** A storage's name ("db", "s3"); an unknown storage keeps its raw name. */
export function blobStorageText(storage: string | null | undefined, t: Translator = defaultTranslate): string {
  if (!storage) return '';
  const key = `blobStorage_${storage}`;
  const text = t(key);
  return text === key ? storage : text;
}

export interface BlobMigrationFailureRow { key: string; sha256: string; shortSha: string; source: string; size: string; error: string; attempts: number }

/**
 * The gateway's failed blob migration items: the content's SHA-256 (no file name: one blob may back many
 * files), the storage it was to be moved from, its size, the sanitised error and the attempts.
 */
export function toBlobMigrationFailureRows(items: any[], t: Translator = defaultTranslate, locale = 'en-US'): BlobMigrationFailureRow[] {
  return (items || []).map((item) => {
    const sha = String(item.sha256 || item.id || '');
    return {
      key: String(item.id || sha),
      sha256: sha,
      shortSha: sha.slice(0, 12),
      source: blobStorageText(item.source_storage, t),
      size: item.size_bytes === null || item.size_bytes === undefined ? '' : formatBytes(item.size_bytes, locale),
      error: item.last_error && typeof item.last_error.message === 'string' ? item.last_error.message : '',
      attempts: Number(item.attempts) || 0
    };
  });
}

/**
 * The i18n key of the toast after a cancel or retry: a blob migration moves blobs, every other job embeds files.
 * The retry text takes the number of retried items as {0}.
 */
export function jobActionTextKey(action: 'cancel' | 'retry', kind: string | null | undefined): string {
  const blobs = isBlobMigrationKind(kind);
  if (action === 'cancel') return blobs ? 'jobCancelRequestedBlobs' : 'jobCancelRequested';
  return blobs ? 'jobRetriedBlobs' : 'jobRetried';
}

/** The job a file batch started: the batch response names no job, the job list names the batch. */
export function jobForBatch(jobs: any[], batchId: string): any | null {
  return jobs.find((job) => job && job.batch_id === batchId) || null;
}
