/**
 * The app's calls to the admin service's Grounding layer. No UI5 imports and an injected fetch,
 * so it runs under jest. Every method resolves to a result and never rejects: the controllers
 * decide what a failure means for the screen.
 */

export type FetchLike = (input: string, init?: any) => Promise<any>;

/** `resetsAt`: when a refused quota resets (the gateway's `resets_at`, an ISO time), for the cockpit's text. */
export interface ApiError { status: number; code: string; message: string; resetsAt?: string }

/**
 * Resolves an i18n key with optional {0} arguments — the Component injects the resource bundle;
 * jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  apiFileTooLarge: 'The file is larger than the server accepts.',
  apiRequestFailedStatus: 'The request failed with status {0}.',
  apiServerUnreachable: 'The server could not be reached.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};
export interface ApiResult<T = any> { ok: boolean; status: number; body: T | null; error: ApiError | null }

const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const ATTACHMENT_IDS_PER_CALL = 100;

/** Behind nginx (Docker, Kyma) the admin service's /api is served under /admin/api. */
export function basePath(deployTarget: string | null | undefined): string {
  return deployTarget === 'docker' ? '/admin/api/grounding' : '/api/grounding';
}

/** The gateway answers `{ error: { code, message } }`; the admin layer answers `{ error: 'code', message }`. */
export function errorOf(status: number, body: any, t: Translator = defaultTranslate): ApiError {
  const nested = body && typeof body.error === 'object' && body.error !== null ? body.error : null;
  if (nested) {
    const code = String(nested.code || nested.type || `http_${status}`);
    const error: ApiError = { status, code, message: String(nested.message || code) };
    if (typeof nested.resets_at === 'string') error.resetsAt = nested.resets_at;
    return error;
  }
  const code = body && typeof body.error === 'string' ? body.error : `http_${status}`;
  // A 413 without a JSON body is the reverse proxy refusing the upload before the gateway sees it.
  const fallback = status === 413 ? t('apiFileTooLarge') : t('apiRequestFailedStatus', [status]);
  const message = body && typeof body.message === 'string' ? body.message : fallback;
  return { status, code, message };
}

const enc = encodeURIComponent;

/** A store's chunking setting, as the gateway stores and takes it (the cockpit's wording: model/chunking.ts). */
/** `vision`: which PDF pages a vision model transcribes; absent means off (the gateway leaves it out then). */
export type VisionMode = 'off' | 'no_text' | 'auto' | 'all';
export interface ChunkingSetting { type: 'static' | 'structure'; max_tokens: number; overlap_tokens: number; contextual: boolean; vision?: VisionMode }

/** A query string from the options that are set (an empty string or undefined is left out). */
function query(options: Record<string, string | number | undefined>): string {
  const parts = Object.entries(options).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}=${enc(String(value))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function chunkingQuery(setting: ChunkingSetting): string {
  return query({
    type: setting.type, max_tokens: setting.max_tokens, overlap_tokens: setting.overlap_tokens, contextual: String(setting.contextual),
    vision: setting.vision && setting.vision !== 'off' ? setting.vision : undefined
  });
}

export class GroundingApi {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly t: Translator;

  constructor(base: string, fetchImpl: FetchLike, t: Translator = defaultTranslate) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.t = t;
  }

  private async send<T>(path: string, init: any): Promise<ApiResult<T>> {
    let response: any;
    try {
      response = await this.fetchImpl(this.base + path, { credentials: 'include', ...init });
    } catch (error) {
      return { ok: false, status: 0, body: null, error: { status: 0, code: 'network_error', message: this.t('apiServerUnreachable') } };
    }
    let body: any = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (response.ok) return { ok: true, status: response.status, body, error: null };
    return { ok: false, status: response.status, body, error: errorOf(response.status, body, this.t) };
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    if (body === undefined) return this.send<T>(path, { method, headers: { Accept: 'application/json' } });
    return this.send<T>(path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async listAll(path: string, extraQuery = ''): Promise<ApiResult<any[]>> {
    const rows: any[] = [];
    let after = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request<any>('GET', `${path}?limit=${PAGE_LIMIT}&order=desc${extraQuery}${after ? `&after=${enc(after)}` : ''}`);
      if (!result.ok) return { ok: false, status: result.status, body: null, error: result.error };
      const data: any[] = Array.isArray(result.body?.data) ? result.body.data : [];
      rows.push(...data);
      if (!result.body?.has_more || data.length === 0) break;
      after = String(result.body.last_id || data[data.length - 1].id);
    }
    return { ok: true, status: 200, body: rows, error: null };
  }

  status(): Promise<ApiResult<any>> { return this.request('GET', '/status'); }

  listStores(): Promise<ApiResult<any[]>> { return this.listAll('/stores'); }
  getStore(id: string): Promise<ApiResult<any>> { return this.request('GET', `/stores/${enc(id)}`); }
  /** Without `chunking` the gateway gives the store the installation default. */
  createStore(name: string, expiresDays?: number, chunking?: ChunkingSetting): Promise<ApiResult<any>> {
    const body: any = { name };
    if (expiresDays && expiresDays > 0) body.expires_after = { anchor: 'last_active_at', days: expiresDays };
    if (chunking) body.chunking = chunking;
    return this.request('POST', '/stores', body);
  }
  /** changes.expiresDays: a number sets the policy, null removes it, undefined leaves it. */
  modifyStore(id: string, changes: { name?: string; expiresDays?: number | null }): Promise<ApiResult<any>> {
    const body: any = {};
    if (changes.name !== undefined) body.name = changes.name;
    if (changes.expiresDays === null) body.expires_after = null;
    else if (changes.expiresDays !== undefined) body.expires_after = { anchor: 'last_active_at', days: changes.expiresDays };
    return this.request('POST', `/stores/${enc(id)}`, body);
  }
  deleteStore(id: string): Promise<ApiResult<any>> { return this.request('DELETE', `/stores/${enc(id)}`); }

  listStoreFiles(storeId: string): Promise<ApiResult<any[]>> { return this.listAll(`/stores/${enc(storeId)}/files`); }
  attachFile(storeId: string, fileId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/files`, { file_id: fileId }); }
  detachFile(storeId: string, fileId: string): Promise<ApiResult<any>> { return this.request('DELETE', `/stores/${enc(storeId)}/files/${enc(fileId)}`); }

  retryFile(storeId: string, fileId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/files/${enc(fileId)}/retry`); }
  /** Owner only: { files, chunks, estimated_tokens, state } of the store's active generation. */
  reembedEstimate(storeId: string): Promise<ApiResult<any>> { return this.request('GET', `/stores/${enc(storeId)}/reembed/estimate`); }
  /** Owner only: starts the re-embed with the configured model and answers its job. */
  reembedStore(storeId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/reembed`); }
  /**
   * What `inputTokens` and `outputTokens` of `model` cost by the Model Library's current price, priced like a
   * usage event (answered by the admin, not the gateway): `{ priced, capacity_units, cost, currency }`;
   * `priced: false` when the model has no price.
   */
  modelCost(model: string, inputTokens: number, outputTokens: number): Promise<ApiResult<any>> {
    return this.request('GET', `/model-cost${query({ model, input_tokens: Math.round(inputTokens), output_tokens: Math.round(outputTokens) })}`);
  }

  /** Owner only: what re-chunking to `setting` would cost (every figure an estimate; no model call). */
  chunkingEstimate(storeId: string, setting: ChunkingSetting): Promise<ApiResult<any>> {
    return this.request('GET', `/stores/${enc(storeId)}/chunking/estimate${chunkingQuery(setting)}`);
  }
  /** Owner only: starts the re-chunk to `setting` and answers its job. */
  startChunking(storeId: string, setting: ChunkingSetting): Promise<ApiResult<any>> {
    return this.request('POST', `/stores/${enc(storeId)}/chunking`, { chunking: setting });
  }
  /** Owner only: which files would be read again (an older version read them) and what that costs; no model call. */
  reextractEstimate(storeId: string): Promise<ApiResult<any>> { return this.request('GET', `/stores/${enc(storeId)}/reextract/estimate`); }
  /** Owner only: reads those files again and queues the failed files this version reads: { job, retried_files }. */
  startReextract(storeId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/reextract`); }
  searchStore(storeId: string, body: unknown): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/search`, body); }
  createFileBatch(storeId: string, fileIds: string[]): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(storeId)}/file_batches`, { file_ids: fileIds }); }
  /** A batch's member files; `filter` is a file status such as "failed". */
  listBatchFiles(storeId: string, batchId: string, filter?: string): Promise<ApiResult<any[]>> {
    return this.listAll(`/stores/${enc(storeId)}/file_batches/${enc(batchId)}/files`, filter ? `&filter=${enc(filter)}` : '');
  }

  /** One page of the caller's jobs, newest first: the gateway's list envelope (data, has_more, last_id). */
  listJobs(options: { limit?: number; after?: string; state?: string } = {}): Promise<ApiResult<any>> {
    const query: string[] = [];
    if (options.limit) query.push(`limit=${options.limit}`);
    if (options.after) query.push(`after=${enc(options.after)}`);
    if (options.state) query.push(`state=${enc(options.state)}`);
    return this.request('GET', `/jobs${query.length ? `?${query.join('&')}` : ''}`);
  }
  getJob(id: string): Promise<ApiResult<any>> { return this.request('GET', `/jobs/${enc(id)}`); }
  cancelJob(id: string): Promise<ApiResult<any>> { return this.request('POST', `/jobs/${enc(id)}/cancel`); }
  retryJob(id: string): Promise<ApiResult<any>> { return this.request('POST', `/jobs/${enc(id)}/retry`); }
  /** One page of the files the caller's re-embed job could not re-embed (a bulk parent for an admin only): the list envelope. */
  jobFailures(id: string, options: { after?: string; limit?: number } = {}): Promise<ApiResult<any>> {
    return this.request('GET', `/jobs/${enc(id)}/failures${query(options)}`);
  }

  listFiles(): Promise<ApiResult<any[]>> { return this.listAll('/files'); }

  /** The caller's own file count and logical bytes (the Files screen header). */
  storage(): Promise<ApiResult<any>> { return this.request('GET', '/storage'); }

  // Administration. Every list answers ONE page (the gateway's envelope: data, has_more, first_id, last_id)
  // that the screen extends with "load more" (`after` = last_id); only the caller's own Vector Stores and
  // Files screens above read everything with listAll. The gateway refuses these routes for a non-admin.
  overview(): Promise<ApiResult<any>> { return this.request('GET', '/admin/overview'); }
  adminStores(options: { owner?: string; status?: string; shared?: boolean; embedding_state?: string; after?: string; limit?: number } = {}): Promise<ApiResult<any>> {
    return this.request('GET', `/admin/stores${query({ ...options, shared: options.shared === undefined ? undefined : String(options.shared) })}`);
  }
  adminFiles(options: { owner?: string; after?: string; limit?: number } = {}): Promise<ApiResult<any>> { return this.request('GET', `/admin/files${query(options)}`); }
  adminFailed(options: { owner?: string; after?: string; limit?: number } = {}): Promise<ApiResult<any>> { return this.request('GET', `/admin/failed${query(options)}`); }
  /** Paged on the owner's e-mail: `after` takes the previous page's last_id. */
  adminStorage(options: { after?: string; limit?: number } = {}): Promise<ApiResult<any>> { return this.request('GET', `/admin/storage${query(options)}`); }
  adminJobs(options: { owner?: string; state?: string; after?: string; limit?: number } = {}): Promise<ApiResult<any>> { return this.request('GET', `/admin/jobs${query(options)}`); }
  /** One job of any owner, with its owner_email (the job page of another owner's job). */
  adminGetJob(id: string): Promise<ApiResult<any>> { return this.request('GET', `/admin/jobs/${enc(id)}`); }
  /** Every failed member of one file batch of any owner, with its file name and sanitised error (all pages). */
  adminBatchFailures(batchId: string): Promise<ApiResult<any[]>> { return this.listAll('/admin/failed', `&batch_id=${enc(batchId)}`); }
  adminDeleteStore(id: string): Promise<ApiResult<any>> { return this.request('DELETE', `/admin/stores/${enc(id)}`); }
  /** Detaches the file from every store of its owner, then deletes it. */
  adminDeleteFile(id: string): Promise<ApiResult<any>> { return this.request('DELETE', `/admin/files/${enc(id)}`); }
  adminRetry(storeId: string, fileId: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/stores/${enc(storeId)}/files/${enc(fileId)}/retry`); }
  /** Any owner's outdated store; the job is the owner's (it shows in their Jobs), started by the admin. */
  adminReembedStore(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/stores/${enc(id)}/reembed`); }
  /** Any owner's store, the same figures as the owner's estimate: { files, chunks, estimated_tokens, state }. */
  adminReembedStoreEstimate(id: string): Promise<ApiResult<any>> { return this.request('GET', `/admin/stores/${enc(id)}/reembed/estimate`); }
  /** Any owner's store, the same estimate as the owner's. */
  adminChunkingEstimate(id: string, setting: ChunkingSetting): Promise<ApiResult<any>> {
    return this.request('GET', `/admin/stores/${enc(id)}/chunking/estimate${chunkingQuery(setting)}`);
  }
  /** Any owner's store; the job is the owner's, started by the admin. */
  adminStartChunking(id: string, setting: ChunkingSetting): Promise<ApiResult<any>> {
    return this.request('POST', `/admin/stores/${enc(id)}/chunking`, { chunking: setting });
  }
  /** Any owner's store, the same re-extract estimate as the owner's. */
  adminReextractEstimate(id: string): Promise<ApiResult<any>> { return this.request('GET', `/admin/stores/${enc(id)}/reextract/estimate`); }
  /** Any owner's store; the job is the owner's, started by the admin. */
  adminStartReextract(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/stores/${enc(id)}/reextract`); }
  /** Every owner's outdated stores: { stores, files, chunks, estimated_tokens, skipped: [{ store_id, owner_email, reason }] }. */
  adminReembedEstimate(): Promise<ApiResult<any>> { return this.request('GET', '/admin/reembed-outdated/estimate'); }
  /** Starts one bulk job over the stores the estimate includes: { job, skipped }. */
  adminReembedOutdated(): Promise<ApiResult<any>> { return this.request('POST', '/admin/reembed-outdated'); }
  /** Re-embed jobs of any owner only; a file batch answers 404. */
  adminCancelJob(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/jobs/${enc(id)}/cancel`); }
  adminRetryJob(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/jobs/${enc(id)}/retry`); }
  /** One page of the files a re-embed job of any owner could not re-embed; a file batch answers 404. */
  adminJobFailures(id: string, options: { after?: string; limit?: number } = {}): Promise<ApiResult<any>> {
    return this.request('GET', `/admin/jobs/${enc(id)}/failures${query(options)}`);
  }
  /** The configured backend, S3 readiness (never its bucket or keys), blobs per storage, the garbage queue and the latest migration. */
  adminBlobStorage(): Promise<ApiResult<any>> { return this.request('GET', '/admin/blob-storage'); }
  /** The S3 probe (PUT and GET of a fixed object under the prefix): { ok } or { ok: false, error: { reason, op, status, code } }. */
  adminBlobStorageTest(): Promise<ApiResult<any>> { return this.request('POST', '/admin/blob-storage/test'); }
  /** Moves every blob not stored in `target` there: { job }, or { job: null } when nothing is to be moved. */
  adminBlobMigrate(target: string): Promise<ApiResult<any>> { return this.request('POST', '/admin/blob-storage/migrate', { target }); }
  /** Only an admin on a store they own; anyone else gets a 404. */
  share(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/stores/${enc(id)}/share`); }
  unshare(id: string): Promise<ApiResult<any>> { return this.request('POST', `/admin/stores/${enc(id)}/unshare`); }
  /** The store's owner, for a team they administer (or any team, for a platform admin). */
  shareWithTeam(id: string, teamId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(id)}/share-team`, { teamId }); }
  unshareFromTeam(id: string, teamId: string): Promise<ApiResult<any>> { return this.request('POST', `/stores/${enc(id)}/unshare-team`, { teamId }); }

  async fileAttachments(ids: string[]): Promise<ApiResult<Record<string, any[]>>> {
    const merged: Record<string, any[]> = {};
    for (let start = 0; start < ids.length; start += ATTACHMENT_IDS_PER_CALL) {
      const group = ids.slice(start, start + ATTACHMENT_IDS_PER_CALL);
      const result = await this.request<any>('GET', `/file-attachments?file_ids=${enc(group.join(','))}`);
      if (!result.ok) return { ok: false, status: result.status, body: null, error: result.error };
      Object.assign(merged, result.body?.data || {});
    }
    return { ok: true, status: 200, body: merged, error: null };
  }

  uploadFile(file: Blob, filename: string): Promise<ApiResult<any>> {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', file, filename);
    // No Content-Type header: the browser sets the multipart boundary itself.
    return this.send('/files', { method: 'POST', headers: { Accept: 'application/json' }, body: form });
  }
  deleteFile(id: string, detach: boolean): Promise<ApiResult<any>> { return this.request('DELETE', `/files/${enc(id)}${detach ? '?detach=true' : ''}`); }
  downloadUrl(id: string): string { return `${this.base}/files/${enc(id)}/content`; }
}
