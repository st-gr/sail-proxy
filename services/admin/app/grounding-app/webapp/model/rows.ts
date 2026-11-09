/** Maps the gateway's file and vector-store objects to table rows. No UI5 imports. */
import { formatBytes, formatUnixSeconds } from './format';
import { statusText, statusState, fileErrorText, ValueState, Translator } from './status';
import { embeddingStateText, embeddingStateColor } from './reembed';
import { chunkingText, isChunkingSetting, ChunkingSetting } from './chunking';

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  sharedBadge: 'Shared', sharedWithOneTeam: 'Shared with 1 team', sharedWithTeams: 'Shared with {0} teams', expiryNever: 'Never', expiryAfterLastUseOne: '{0} day after last use', expiryAfterLastUseMany: '{0} days after last use',
  fileContextIncompleteTooltip: 'Writing the contexts of this file reached its time limit, so some of its chunks have no context. Starting the re-chunk with the current setting tries once more.',
  fileContextIncompleteFinalTooltip: 'Writing the contexts of this file reached its time or token limit, so some of its chunks have no context. A re-chunk with the current setting does not try again.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

export interface StoreRow {
  id: string; name: string; status: string; statusText: string; statusState: ValueState;
  files: number; failedFiles: number; inProgressFiles: number; size: string;
  created: string; lastActive: string; expires: string;
  /** Shared with every user by an admin. */
  shared: boolean; sharedText: string;
  /** The teams the store is shared with (as far as the viewer may see them) and the badge text for them. */
  teamIds: string[]; teamSharedText: string;
  /** False for a store another admin shared: the views bind their edit actions to `!readOnly`. */
  owned: boolean; ownerEmail: string; readOnly: boolean;
  /** The store's own embedding model, dimension and active generation, and its state against the configured model. */
  embeddingModel: string; embeddingDim: number; generation: number;
  embeddingState: string; embeddingStateText: string; embeddingStateColor: ValueState;
  /** Outdated or a dimension mismatch: the lists mark the store. */
  embeddingAttention: boolean;
  /** The unfinished re-embed job ('' when none, or when the job is another owner's). */
  reembedJobId: string; reembedding: boolean;
  /** The Re-embed action: an outdated store that has not expired and has no re-embed running, for its owner (an admin row: for anyone). */
  canReembed: boolean;
  /** The stored chunking setting (null: a store from before the setting, static 800/400) and its summary. */
  chunking: ChunkingSetting | null; chunkingText: string;
  /** The Change Chunking action: a store that has not expired, has its configured dimension and no re-embed running, for its owner (an admin row: for anyone). */
  canChangeChunking: boolean;
}

/** The badge text for a shared store, '' otherwise. */
export function sharedText(shared: boolean, t: Translator = defaultTranslate): string {
  return shared ? t('sharedBadge') : '';
}

export function expiryText(expiresAfter: { days?: number; [key: string]: unknown } | null | undefined, expiresAt: number | null | undefined, t: Translator = defaultTranslate, locale = 'en-US'): string {
  const days = Number(expiresAfter?.days);
  if (!expiresAfter || !Number.isFinite(days) || days <= 0) return t('expiryNever');
  const policy = t(days === 1 ? 'expiryAfterLastUseOne' : 'expiryAfterLastUseMany', [days]);
  const date = formatUnixSeconds(expiresAt, locale);
  return date ? `${policy} (${date})` : policy;
}

/** An outdated store that has not expired and has no re-embed running (the gateway refuses the others). */
export function reembeddable(state: string, status: string | null | undefined, reembedJobId: string): boolean {
  return state === 'outdated' && status !== 'expired' && reembedJobId === '';
}

/** The gateway re-chunks a store that has not expired, has the configured dimension and no re-embed running. */
export function rechunkable(state: string, status: string | null | undefined, reembedJobId: string): boolean {
  return state !== 'dimension_mismatch' && status !== 'expired' && reembedJobId === '';
}

/** `locale` is the cockpit language the controller passes; jest passes none and gets 'en-US'. */
export function toStoreRow(store: any, t?: Translator, locale = 'en-US'): StoreRow {
  const counts = store.file_counts || {};
  const shared = store.is_shared === true;
  const teamIds: string[] = Array.isArray(store.team_ids) ? store.team_ids : [];
  // A store object without `owned` (the owner-only list) is the caller's own.
  const owned = store.owned !== false;
  const state = typeof store.embedding_state === 'string' ? store.embedding_state : '';
  const reembedJobId = typeof store.reembed_job_id === 'string' ? store.reembed_job_id : '';
  return {
    id: store.id,
    name: store.name || store.id,
    status: store.status || '',
    statusText: statusText(store.status, t),
    statusState: statusState(store.status),
    files: Number(counts.total) || 0,
    failedFiles: Number(counts.failed) || 0,
    inProgressFiles: Number(counts.in_progress) || 0,
    size: formatBytes(store.usage_bytes, locale),
    created: formatUnixSeconds(store.created_at, locale),
    lastActive: formatUnixSeconds(store.last_active_at, locale),
    expires: expiryText(store.expires_after, store.expires_at, t, locale),
    shared,
    sharedText: sharedText(shared, t),
    teamIds,
    teamSharedText: teamIds.length === 1 ? (t ?? defaultTranslate)('sharedWithOneTeam') : teamIds.length ? (t ?? defaultTranslate)('sharedWithTeams', [teamIds.length]) : '',
    owned,
    ownerEmail: typeof store.owner_email === 'string' ? store.owner_email : '',
    readOnly: !owned,
    embeddingModel: typeof store.embedding_model === 'string' ? store.embedding_model : '',
    embeddingDim: Number(store.embedding_dim) || 0,
    generation: Number(store.active_generation) || 0,
    embeddingState: state,
    embeddingStateText: embeddingStateText(state, t),
    embeddingStateColor: embeddingStateColor(state),
    embeddingAttention: state === 'outdated' || state === 'dimension_mismatch',
    reembedJobId,
    reembedding: reembedJobId !== '',
    canReembed: owned && reembeddable(state, store.status, reembedJobId),
    chunking: isChunkingSetting(store.chunking) ? store.chunking : null,
    chunkingText: chunkingText(store.chunking, t),
    canChangeChunking: owned && rechunkable(state, store.status, reembedJobId)
  };
}

export interface StoreFileRow {
  id: string; filename: string; status: string; statusText: string; statusState: ValueState; size: string; error: string;
  /** The context writer stopped at the file's time or token limit (the gateway's `context_stopped`): some chunks have no context. */
  contextIncomplete: boolean; contextIncompleteTooltip: string;
}

/** The tooltip of a file's "context incomplete" mark: whether a re-chunk with the same setting still retries it —
 *  only a first time-limit stop ('deadline'); a token-limit stop and a retried one are final. */
function contextStopTooltip(stopped: unknown, t: Translator): string {
  if (typeof stopped !== 'string' || stopped === '') return '';
  return t(stopped === 'deadline' ? 'fileContextIncompleteTooltip' : 'fileContextIncompleteFinalTooltip');
}

/** The store's file objects carry no filename; it comes from the caller's file list. */
export function toStoreFileRows(storeFiles: any[], filesById: Record<string, any>, t?: Translator, locale = 'en-US'): StoreFileRow[] {
  return storeFiles.map((entry) => {
    const file = filesById[entry.id];
    return {
      id: entry.id,
      filename: file ? file.filename : entry.id,
      status: entry.status || '',
      statusText: statusText(entry.status, t),
      statusState: statusState(entry.status),
      size: formatBytes(file ? file.bytes : entry.usage_bytes, locale),
      error: fileErrorText(entry.last_error),
      contextIncomplete: typeof entry.context_stopped === 'string' && entry.context_stopped !== '',
      contextIncompleteTooltip: contextStopTooltip(entry.context_stopped, t ?? defaultTranslate)
    };
  });
}

export interface FileRow {
  id: string; filename: string; size: string; bytes: number; created: string; stores: string; storeCount: number;
}

export function toFileRows(files: any[], attachments: Record<string, { store_id: string; store_name: string | null; status?: string }[]>, locale = 'en-US'): FileRow[] {
  return files.map((file) => {
    const attached = attachments[file.id] || [];
    return {
      id: file.id,
      filename: file.filename,
      size: formatBytes(file.bytes, locale),
      bytes: Number(file.bytes) || 0,
      created: formatUnixSeconds(file.created_at, locale),
      stores: attached.map((entry) => entry.store_name || entry.store_id).join(', '),
      storeCount: attached.length
    };
  });
}
