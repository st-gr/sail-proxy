import { isActive, jobStateText, jobStateColor, jobKindText, isReembedKind, progressText, formatTokens, formatIsoTime, toJobRow, jobForBatch, toReembedFailureRows, toBlobMigrationFailureRows, blobStorageText, hasAdminJobActions, isBlobMigrationKind, jobActionTextKey } from '../webapp/model/jobs';

const job = (over: any = {}) => ({
  id: 'job_1', kind: 'file_batch', store_id: 'vs_1', store_name: 'Docs', batch_id: 'vsfb_1', state: 'running',
  total: 5, done: 2, failed: 1, cancelled: 0, in_progress: 2, embedding_tokens: 12345, error: null,
  created_at: '2026-10-02T08:00:00.000Z', started_at: '2026-10-02T08:00:05.000Z', finished_at: null, started_by: 'ada@example.test', ...over
});

describe('state wording', () => {
  it('words and colours every state', () => {
    expect(jobStateText('queued')).toBe('Queued');
    expect(jobStateText('running')).toBe('Running');
    expect(jobStateText('cancelling')).toBe('Cancelling');
    expect(jobStateText('cancelled')).toBe('Cancelled');
    expect(jobStateText('completed')).toBe('Completed');
    expect(jobStateText('completed_with_errors')).toBe('Completed with errors');
    expect(jobStateText('failed')).toBe('Failed');
    expect(jobStateColor('queued')).toBe('Information');
    expect(jobStateColor('running')).toBe('Information');
    expect(jobStateColor('cancelling')).toBe('Warning');
    expect(jobStateColor('cancelled')).toBe('Warning');
    expect(jobStateColor('completed')).toBe('Success');
    expect(jobStateColor('completed_with_errors')).toBe('Warning');
    expect(jobStateColor('failed')).toBe('Error');
  });
  it('shows an unknown state as is and without colour', () => {
    expect(jobStateText('paused')).toBe('paused');
    expect(jobStateColor('paused')).toBe('None');
    expect(jobStateText(null)).toBe('');
  });
});

describe('isActive', () => {
  it('is true while the worker may still change the job', () => {
    for (const state of ['queued', 'running', 'cancelling']) expect(isActive(state)).toBe(true);
    for (const state of ['cancelled', 'completed', 'completed_with_errors', 'failed', '', null, undefined]) expect(isActive(state as any)).toBe(false);
  });
});

describe('progress and tokens', () => {
  it('shows done of total', () => {
    expect(progressText({ done: 2, total: 5 })).toBe('2/5');
    expect(progressText({ done: 0, total: 0 })).toBe('0/0');
    expect(progressText({} as any)).toBe('0/0');
  });
  it('groups token counts and accepts numeric strings', () => {
    expect(formatTokens(12345)).toBe('12,345');
    expect(formatTokens('1234567')).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(null)).toBe('0');
    expect(formatTokens(-4)).toBe('0');
  });
});

describe('formatIsoTime', () => {
  it('prints an ISO timestamp in UTC, like the Unix-second dates', () => {
    expect(formatIsoTime('2026-10-02T08:00:05.000Z')).toBe('Oct 2, 2026, 8:00 AM');
  });
  it('is empty for nothing or an unreadable value', () => {
    expect(formatIsoTime(null)).toBe('');
    expect(formatIsoTime('')).toBe('');
    expect(formatIsoTime('yesterday')).toBe('');
  });
});

describe('toJobRow', () => {
  it('maps a running job', () => {
    expect(toJobRow(job())).toEqual({
      id: 'job_1', kind: 'file_batch', kindText: 'File batch', storeId: 'vs_1', storeName: 'Docs', batchId: 'vsfb_1',
      state: 'running', stateText: 'Running', stateColor: 'Information', active: true,
      progress: '2/5', total: 5, done: 2, failed: 1, cancelled: 0, inProgress: 2, tokens: '12,345',
      created: 'Oct 2, 2026, 8:00 AM', started: 'Oct 2, 2026, 8:00 AM', finished: '', startedBy: 'ada@example.test',
      errorText: '', canCancel: true, canRetry: false,
      rechunk: false, targetChunkingText: '', contextual: false,
      contextInputTokens: '0', contextCachedTokens: '0', contextOutputTokens: '0', contextFailedChunks: '0',
      ocrPages: '0', ocrSkippedPages: '0', visionPages: '0', visionSkippedPages: '0'
    });
  });
  it('carries the OCR and vision page counters, grouped ("0" hides a counter on the detail page)', () => {
    expect(toJobRow(job({ ocr_pages: 1234, ocr_skipped_pages: '2', vision_pages: 7, vision_skipped_pages: 0 }))).toMatchObject({
      ocrPages: '1,234', ocrSkippedPages: '2', visionPages: '7', visionSkippedPages: '0'
    });
    expect(toJobRow(job({ ocr_pages: 1234 }), undefined, 'de-DE').ocrPages).toBe('1.234');
  });
  it('offers cancel for queued and retry only for a finished job with failures', () => {
    expect(toJobRow(job({ state: 'queued' })).canCancel).toBe(true);
    expect(toJobRow(job({ state: 'cancelling' })).canCancel).toBe(false);
    expect(toJobRow(job({ state: 'completed_with_errors', in_progress: 0 })).canRetry).toBe(true);
    expect(toJobRow(job({ state: 'completed_with_errors', failed: 0 })).canRetry).toBe(false);
    expect(toJobRow(job({ state: 'completed', failed: 0 })).canRetry).toBe(false);
    expect(toJobRow(job({ state: 'cancelled' })).canRetry).toBe(false);
  });
  it('falls back to the store id for a deleted store name and reads the job error message', () => {
    const row = toJobRow(job({ store_name: null, error: { message: 'boom' }, state: 'failed' }));
    expect(row.storeName).toBe('vs_1');
    expect(row.errorText).toBe('boom');
  });
  it('survives a sparse object', () => {
    const row = toJobRow({ id: 'job_x' });
    expect(row).toMatchObject({ id: 'job_x', progress: '0/0', tokens: '0', created: '', canCancel: false, canRetry: false, active: false });
  });
});

describe('re-chunk jobs', () => {
  const rechunk = (target: any, over: any = {}) => job({
    kind: 'reembed_store', batch_id: null, target_chunking: target,
    context_input_tokens: 2100000, context_cached_tokens: 1500000, context_output_tokens: 32000, context_failed_chunks: 3, ...over
  });
  it('shows a store job with a target setting as a re-chunk, with the target and the context counters', () => {
    expect(toJobRow(rechunk({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true }))).toMatchObject({
      kind: 'reembed_store', kindText: 'Re-chunk', rechunk: true, targetChunkingText: 'Structure (800/0), contextual', contextual: true,
      contextInputTokens: '2,100,000', contextCachedTokens: '1,500,000', contextOutputTokens: '32,000', contextFailedChunks: '3'
    });
  });
  it('hides the context counters of a re-chunk to a setting without context', () => {
    expect(toJobRow(rechunk({ type: 'static', max_tokens: 400, overlap_tokens: 100, contextual: false }))).toMatchObject({
      kindText: 'Re-chunk', rechunk: true, targetChunkingText: 'Static (400/100)', contextual: false
    });
  });
  it('names a re-extract (a re-chunk to the store\'s own setting) "Re-read files"', () => {
    const t = (key: string, args?: (string | number)[]) => (args ? `${key}(${args.join('|')})` : key);
    const setting = { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false };
    expect(toJobRow(rechunk(setting, { reextract: true }))).toMatchObject({ kindText: 'Re-read files', rechunk: true, targetChunkingText: 'Static (800/400)' });
    expect(toJobRow(rechunk(setting, { reextract: true }), t).kindText).toBe('jobKind_reextract');
    expect(toJobRow(rechunk(setting, { reextract: false })).kindText).toBe('Re-chunk');
  });
  it('keeps a plain re-embed as it was', () => {
    expect(toJobRow(rechunk(null))).toMatchObject({ kindText: 'Re-embed', rechunk: false, targetChunkingText: '', contextual: false });
    expect(toJobRow(job({ kind: 'reembed_store' }))).toMatchObject({ kindText: 'Re-embed', rechunk: false });
  });
  it('translates the kind and the target with the injected bundle', () => {
    const t = (key: string, args?: (string | number)[]) => (args ? `${key}(${args.join('|')})` : key);
    expect(toJobRow(rechunk({ type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: false }), t)).toMatchObject({
      kindText: 'jobKind_rechunk', targetChunkingText: 'chunkingSummary(chunkingType_structure|600|0)'
    });
  });
});

describe('re-embed jobs', () => {
  it('names the kinds and tells them from a file batch', () => {
    expect(jobKindText('reembed_store')).toBe('Re-embed');
    expect(jobKindText('reembed_bulk')).toBe('Re-embed of outdated stores');
    expect(jobKindText('file_batch')).toBe('File batch');
    expect([isReembedKind('reembed_store'), isReembedKind('reembed_bulk'), isReembedKind('file_batch'), isReembedKind(null)]).toEqual([true, true, false, false]);
  });
  it('offers retry for a failed re-embed with failed members, and for a bulk that completed with errors', () => {
    const reembed = (over: any) => toJobRow(job({ kind: 'reembed_store', batch_id: null, in_progress: 0, ...over }));
    expect(reembed({ state: 'failed', failed: 1 }).canRetry).toBe(true);
    expect(reembed({ state: 'failed', failed: 0 }).canRetry).toBe(false);
    expect(reembed({ state: 'cancelled', failed: 1 }).canRetry).toBe(false);
    expect(reembed({ state: 'completed', failed: 0 }).canRetry).toBe(false);
    expect(toJobRow(job({ kind: 'reembed_bulk', state: 'completed_with_errors', failed: 1 })).canRetry).toBe(true);
    expect(toJobRow(job({ kind: 'reembed_bulk', state: 'failed', failed: 2 })).canRetry).toBe(true);
    expect(reembed({ state: 'running' }).canCancel).toBe(true);
  });
  it('keeps the file batch rule: a batch is never failed, and retry needs completed_with_errors', () => {
    expect(toJobRow(job({ state: 'failed', failed: 1 })).canRetry).toBe(false);
  });
});

describe('jobForBatch', () => {
  it('finds the job a batch started', () => {
    expect(jobForBatch([job({ id: 'job_a', batch_id: 'vsfb_a' }), job({ id: 'job_b', batch_id: 'vsfb_b' })], 'vsfb_b')?.id).toBe('job_b');
    expect(jobForBatch([job()], 'vsfb_zzz')).toBeNull();
  });
});

describe('the cockpit language', () => {
  it('groups tokens and prints times in the locale the controller passes, still in UTC', () => {
    expect(formatTokens(1234567, 'de')).toBe('1.234.567');
    expect(formatIsoTime('2026-10-02T08:00:05.000Z', 'de')).toBe('02.10.2026, 08:00');
    expect(toJobRow({ id: 'job_1', embedding_tokens: 12345, created_at: '2026-10-02T08:00:05.000Z' }, undefined, 'de'))
      .toMatchObject({ tokens: '12.345', created: '02.10.2026, 08:00' });
  });
  it('keeps English byte-identical for the UI5 tag "en"', () => {
    expect(formatTokens(1234567, 'en')).toBe(formatTokens(1234567));
    expect(formatIsoTime('2026-10-02T08:00:05.000Z', 'en')).toBe(formatIsoTime('2026-10-02T08:00:05.000Z'));
  });
});

describe('toReembedFailureRows', () => {
  it('maps the gateway\'s failed items: store, file name, sanitised message and attempts', () => {
    expect(toReembedFailureRows([
      { id: 'job_c/file-1', job_id: 'job_c', store_id: 'vs_1', store_name: 'Docs', file_id: 'file-1', filename: 'a.txt', last_error: { message: 'Embedding failed.' }, attempts: 3 }
    ])).toEqual([{ key: 'job_c/file-1', storeName: 'Docs', filename: 'a.txt', error: 'Embedding failed.', attempts: 3 }]);
  });
  it('falls back to the ids for a deleted file or an unnamed store, and to no error text', () => {
    expect(toReembedFailureRows([
      { id: 'job_c/file-2', store_id: 'vs_2', store_name: null, file_id: 'file-2', filename: null, last_error: { message: null }, attempts: '2' }
    ])).toEqual([{ key: 'job_c/file-2', storeName: 'vs_2', filename: 'file-2', error: '', attempts: 2 }]);
    expect(toReembedFailureRows(null as any)).toEqual([]);
  });
});

describe('blob migration jobs', () => {
  it('names the kind and the storages, and admins may act on it', () => {
    expect(jobKindText('blob_migration')).toBe('Blob migration');
    expect([blobStorageText('db'), blobStorageText('s3'), blobStorageText('local'), blobStorageText(null)]).toEqual(['Database', 'S3', 'local', '']);
    expect([isBlobMigrationKind('blob_migration'), isBlobMigrationKind('reembed_bulk')]).toEqual([true, false]);
    expect(['blob_migration', 'reembed_store', 'reembed_bulk', 'file_batch'].map(hasAdminJobActions)).toEqual([true, true, true, false]);
  });

  it('retries a failed or partly failed migration', () => {
    const job = { id: 'job_m', kind: 'blob_migration', store_id: null, total: 3, done: 1, failed: 2 };
    expect(toJobRow({ ...job, state: 'failed' }).canRetry).toBe(true);
    expect(toJobRow({ ...job, state: 'completed_with_errors' }).canRetry).toBe(true);
    expect(toJobRow({ ...job, state: 'completed', failed: 0 }).canRetry).toBe(false);
  });

  it('maps the failed items: SHA-256, source storage, size, sanitised error, attempts', () => {
    const sha = 'ab'.repeat(32);
    expect(toBlobMigrationFailureRows([
      { id: sha, sha256: sha, source_storage: 's3', size_bytes: 2048, last_error: { message: 'S3 GetObject failed: HTTP 403 AccessDenied' }, attempts: 3 },
      { id: 'cd'.repeat(32), sha256: 'cd'.repeat(32), source_storage: 'local', size_bytes: null, last_error: null, attempts: 1 }
    ])).toEqual([
      { key: sha, sha256: sha, shortSha: 'abababababab', source: 'S3', size: '2.0 KB', error: 'S3 GetObject failed: HTTP 403 AccessDenied', attempts: 3 },
      { key: 'cd'.repeat(32), sha256: 'cd'.repeat(32), shortSha: 'cdcdcdcdcdcd', source: 'local', size: '', error: '', attempts: 1 }
    ]);
    expect(toBlobMigrationFailureRows(null as any)).toEqual([]);
  });
});

describe('jobActionTextKey', () => {
  it('speaks of blobs for a blob migration and of files otherwise', () => {
    expect(['cancel', 'retry'].map((a) => jobActionTextKey(a as any, 'blob_migration'))).toEqual(['jobCancelRequestedBlobs', 'jobRetriedBlobs']);
    for (const kind of ['file_batch', 'reembed_store', 'reembed_bulk', '', undefined]) {
      expect(['cancel', 'retry'].map((a) => jobActionTextKey(a as any, kind))).toEqual(['jobCancelRequested', 'jobRetried']);
    }
  });
});
