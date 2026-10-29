import {
  overviewTiles, toAdminStoreRow, toAdminFileRow, toFailedRow, toStorageRow, toAdminJobRow, adminTabOf, adminListOptions, filtersForLoad,
  toBlobPanel, toBlobMigrationView, migrationWarning, blobsToMove, connectionTestResult
} from '../webapp/model/admin';

const DE = (key: string) => ({ adminTileStores: 'Vektorspeicher', adminTileFiles: 'Dateien', adminTileLogicalBytes: 'Hochgeladene Größe',
  adminTilePhysicalBytes: 'Gespeicherte Größe', adminTileSavings: 'Einsparung', adminTileFailed: 'Fehlgeschlagen', sharedBadge: 'Freigegeben',
  jobState_running: 'Läuft' } as Record<string, string>)[key] ?? key;

const OVERVIEW = { stores: 1234, files: 56789, logical_bytes: 3 * 1024 * 1024 * 1.5, physical_bytes: 1024 * 1024, savings_bytes: 3.5 * 1024 * 1024, failed_ingestions: 2, outdated_stores: 1500 };

describe('overviewTiles', () => {
  it('formats the seven tiles in English', () => {
    expect(overviewTiles(OVERVIEW).map((tile) => [tile.key, tile.label, tile.value])).toEqual([
      ['stores', 'Vector Stores', '1,234'], ['files', 'Files', '56,789'], ['logicalBytes', 'Uploaded Size', '4.5 MB'],
      ['physicalBytes', 'Stored Size', '1.0 MB'], ['savings', 'Deduplication Savings', '3.5 MB'], ['failedIngestions', 'Failed Ingestions', '2'],
      ['outdated', 'Outdated Stores', '1,500']
    ]);
  });
  it('formats with the locale and translates the labels', () => {
    const tiles = overviewTiles(OVERVIEW, DE, 'de-DE');
    expect(tiles.map((tile) => tile.value)).toEqual(['1.234', '56.789', '4,5 MB', '1,0 MB', '3,5 MB', '2', '1.500']);
    expect(tiles[2].label).toBe('Hochgeladene Größe');
  });
  it('survives a missing overview', () => {
    expect(overviewTiles(null).map((tile) => tile.value)).toEqual(['0', '0', '0 B', '0 B', '0 B', '0', '0']);
  });
  it('shows a negative size (savings below zero, a bad sum) as 0 B', () => {
    const tiles = overviewTiles({ ...OVERVIEW, logical_bytes: -5, savings_bytes: -1024 });
    expect([tiles[2].value, tiles[4].value]).toEqual(['0 B', '0 B']);
  });
});

describe('toAdminStoreRow', () => {
  const store = { id: 'vs_1', name: 'Docs', status: 'failed', usage_bytes: 100, created_at: 1767225600, file_counts: { total: 2 }, is_shared: true, owned: false, owner_email: 'u@test.com' };
  it('shows owner, badge, status text and read-only for another admin\'s store', () => {
    expect(toAdminStoreRow(store)).toMatchObject({ ownerEmail: 'u@test.com', sharedText: 'Shared', statusText: 'Failed', statusState: 'Error', readOnly: true, files: 2 });
  });
  it('uses the German badge', () => { expect(toAdminStoreRow(store, DE, 'de-DE').sharedText).toBe('Freigegeben'); });
  it('offers an admin the re-embed of any owner\'s outdated store, unless one runs or the store expired', () => {
    const outdated = { ...store, status: 'completed', embedding_model: 'old-model', embedding_dim: 1536, embedding_state: 'outdated', reembed_job_id: null };
    expect(toAdminStoreRow(outdated)).toMatchObject({ readOnly: true, canReembed: true, embeddingModel: 'old-model', embeddingStateText: 'Outdated' });
    expect(toAdminStoreRow({ ...outdated, reembed_job_id: 'job_1' })).toMatchObject({ canReembed: false, reembedding: true });
    expect(toAdminStoreRow({ ...outdated, status: 'expired' }).canReembed).toBe(false);
    expect(toAdminStoreRow({ ...outdated, embedding_state: 'dimension_mismatch' }).canReembed).toBe(false);
    expect(toAdminStoreRow({ ...outdated, embedding_state: 'current' }).canReembed).toBe(false);
  });
});

describe('toAdminFileRow', () => {
  it('formats Unix-seconds dates and bytes and names the owner and attachments', () => {
    const row = toAdminFileRow({ id: 'file-a', object: 'file', bytes: 2048, created_at: 1767225600, filename: 'a.pdf', purpose: 'assistants', owner_email: 'u@test.com', attachment_count: 2 });
    expect(row).toMatchObject({ id: 'file-a', filename: 'a.pdf', size: '2.0 KB', ownerEmail: 'u@test.com', attachments: 2 });
    expect(row.created.replace(/\s/g, ' ')).toBe('Jan 1, 2026, 12:00 AM');
  });
  it('formats in German', () => {
    expect(toAdminFileRow({ id: 'f', bytes: 1536, created_at: 1767225600, filename: 'a', owner_email: 'u@test.com' }, 'de-DE')).toMatchObject({ size: '1,5 KB', created: '01.01.2026, 00:00' });
  });
});

describe('toFailedRow', () => {
  const row = { id: 'vs_1/file-a', store_id: 'vs_1', store_name: 'Docs', file_id: 'file-a', filename: 'a.pdf', owner_email: 'u@test.com',
    last_error: { message: 'Unsupported file type', name: 'UnsupportedTypeError' }, attempts: 3, batch_id: null, created_at: 1767225600 };
  it('shows only the sanitised message', () => {
    const out = toFailedRow(row);
    expect(out).toMatchObject({ id: 'vs_1/file-a', storeName: 'Docs', fileId: 'file-a', message: 'Unsupported file type', attempts: 3, batchId: '', ownerEmail: 'u@test.com' });
    expect(JSON.stringify(out)).not.toContain('UnsupportedTypeError');
  });
  it('shows no message when the error has none, and survives a missing store name', () => {
    expect(toFailedRow({ ...row, last_error: { message: null, name: 'X' }, store_name: null })).toMatchObject({ message: '', storeName: 'vs_1' });
    expect(toFailedRow({ ...row, last_error: null }).message).toBe('');
  });
  it('formats the Unix-seconds date with the locale', () => { expect(toFailedRow(row, 'de-DE').created).toBe('01.01.2026, 00:00'); });
});

describe('toStorageRow', () => {
  it('maps an owner\'s totals', () => {
    expect(toStorageRow({ owner_email: 'u@test.com', file_count: 3, logical_bytes: 1048576 })).toEqual({ ownerEmail: 'u@test.com', files: 3, bytes: 1048576, size: '1.0 MB' });
    expect(toStorageRow({ owner_email: 'u@test.com', file_count: 1, logical_bytes: 1572864 }, 'de-DE').size).toBe('1,5 MB');
  });
});

describe('toAdminJobRow', () => {
  const job = { id: 'job_1', kind: 'file_batch', store_id: 'vs_1', store_name: 'Docs', state: 'running', total: 4, done: 1, failed: 0, owner_email: 'u@test.com',
    created_at: '2026-01-01T00:00:00.000Z', started_at: null, finished_at: null, started_by: 'u@test.com', embedding_tokens: 1500 };
  it('keeps the ISO dates, shows the owner and offers no actions', () => {
    const row = toAdminJobRow(job);
    expect(row).toMatchObject({ ownerEmail: 'u@test.com', stateText: 'Running', progress: '1/4', canCancel: false, canRetry: false, tokens: '1,500' });
    expect(row.created.replace(/\s/g, ' ')).toBe('Jan 1, 2026, 12:00 AM');
  });
  it('offers no retry even for a job with failures', () => {
    expect(toAdminJobRow({ ...job, state: 'completed_with_errors', failed: 2 })).toMatchObject({ canCancel: false, canRetry: false });
  });
  it('offers cancel and retry for re-embed jobs of any owner, never for a file batch', () => {
    expect(toAdminJobRow({ ...job, kind: 'reembed_store' })).toMatchObject({ kind: 'reembed_store', kindText: 'Re-embed', canCancel: true, canRetry: false });
    expect(toAdminJobRow({ ...job, kind: 'reembed_store', state: 'failed', failed: 1 })).toMatchObject({ canCancel: false, canRetry: true });
    expect(toAdminJobRow({ ...job, kind: 'reembed_bulk', store_id: null, store_name: null, state: 'queued' })).toMatchObject({ canCancel: true, storeName: '' });
    expect(toAdminJobRow({ ...job, kind: 'file_batch', state: 'queued' }).canCancel).toBe(false);
    expect(toAdminJobRow({ ...job, kind: 'blob_migration', store_id: null, store_name: null, state: 'running' }))
      .toMatchObject({ kindText: 'Blob migration', canCancel: true, canRetry: false, storeName: '' });
    expect(toAdminJobRow({ ...job, kind: 'blob_migration', state: 'completed_with_errors', failed: 1 })).toMatchObject({ canCancel: false, canRetry: true });
    expect(toAdminJobRow({ ...job, kind: 'blob_migration', state: 'failed', failed: 3 }).canRetry).toBe(true);
  });
  it('translates and formats in German', () => {
    expect(toAdminJobRow(job, DE, 'de-DE')).toMatchObject({ stateText: 'Läuft', tokens: '1.500' });
  });
});

describe('adminTabOf', () => {
  it('keeps a known tab and falls back to the overview', () => {
    expect(['overview', 'stores', 'files', 'failed', 'storage', 'jobs'].map(adminTabOf)).toEqual(['overview', 'stores', 'files', 'failed', 'storage', 'jobs']);
    expect(adminTabOf(undefined)).toBe('overview');
    expect(adminTabOf('')).toBe('overview');
    expect(adminTabOf('blobs')).toBe('overview');
    expect(adminTabOf('constructor')).toBe('overview');
  });
});

describe('adminListOptions', () => {
  it('orders the keys owner, status, shared, embedding_state, after, limit and trims the owner', () => {
    const options = adminListOptions('stores', { owner: '  a@test.com ', status: 'expired', shared: 'false', embeddingState: 'outdated' }, 'vs_9', 50);
    expect(Object.keys(options)).toEqual(['owner', 'status', 'shared', 'embedding_state', 'after', 'limit']);
    expect(options).toEqual({ owner: 'a@test.com', status: 'expired', shared: false, embedding_state: 'outdated', after: 'vs_9', limit: 50 });
  });
  it('passes the embedding state filter to the store list only', () => {
    expect(adminListOptions('stores', { embeddingState: 'dimension_mismatch' }, '', 20)).toEqual({ embedding_state: 'dimension_mismatch', limit: 20 });
    expect(adminListOptions('jobs', { embeddingState: 'outdated' }, '', 20)).toEqual({ limit: 20 });
  });
  it('reads shared as a boolean and leaves empty filters out', () => {
    expect(adminListOptions('stores', { owner: ' ', status: '', shared: 'true' }, '', 20)).toEqual({ shared: true, limit: 20 });
    expect(adminListOptions('stores', { shared: '' }, '', 20)).toEqual({ limit: 20 });
  });
  it('passes only the filters a list knows', () => {
    expect(adminListOptions('files', { owner: 'a@test.com', status: 'expired', shared: 'true' }, 'file_1', 20)).toEqual({ owner: 'a@test.com', after: 'file_1', limit: 20 });
    expect(adminListOptions('failed', { owner: 'a@test.com' }, '', 20)).toEqual({ owner: 'a@test.com', limit: 20 });
    expect(adminListOptions('storage', { owner: 'a@test.com' }, 'b@test.com', 20)).toEqual({ after: 'b@test.com', limit: 20 });
    const jobs = adminListOptions('jobs', { owner: 'a@test.com', state: 'running', status: 'expired' }, 'job_1', 20);
    expect(Object.keys(jobs)).toEqual(['owner', 'state', 'after', 'limit']);
  });
});

describe('filtersForLoad', () => {
  // The live list carries the bound fields plus rows, hasMore, lastId and busy.
  const live = { owner: 'typed-not-submitted@test.com', status: 'expired', shared: 'true', embeddingState: 'outdated', rows: [], hasMore: true, lastId: 'vs_9', busy: false };
  const applied = { owner: 'a@test.com', status: '', state: '', shared: '', embeddingState: '' };

  it('a first page applies the fields as they stand, and only the filter fields', () => {
    expect(filtersForLoad('apply', live, applied)).toEqual({ owner: 'typed-not-submitted@test.com', status: 'expired', state: '', shared: 'true', embeddingState: 'outdated' });
  });
  it('More, the quiet refresh and the reload after an action keep the applied filters, not the typed value', () => {
    for (const mode of ['more', 'quiet', 'keep'] as const) expect(filtersForLoad(mode, live, applied)).toBe(applied);
    expect(adminListOptions('stores', filtersForLoad('more', live, applied), 'vs_9', 20)).toEqual({ owner: 'a@test.com', after: 'vs_9', limit: 20 });
  });
  it('falls back to the fields before any first page has loaded', () => {
    expect(filtersForLoad('more', { owner: 'b@test.com' }, undefined)).toEqual({ owner: 'b@test.com', status: '', state: '', shared: '', embeddingState: '' });
  });
});

const BLOBS = {
  configured_backend: 'db',
  s3: { configured: true, credentials_present: true, prefix: 'sail-proxy/blobs' },
  storages: [
    { storage: 'db', live_blobs: 1200, live_bytes: 3 * 1024 * 1024, released_blobs: 3, released_bytes: 2048, addressable: true },
    { storage: 's3', live_blobs: 7, live_bytes: 1536, released_blobs: 1, released_bytes: 10, addressable: true }
  ],
  garbage: [{ storage: 's3', entries: 4, due: 2, failing: 1 }],
  migration: null
};
const MIGRATION = { id: 'job_m', kind: 'blob_migration', store_id: null, state: 'running', total: 8, done: 3, failed: 1, cancelled: 0, in_progress: 4, target_storage: 's3' };

describe('toBlobPanel', () => {
  it('shows the backend, S3 readiness and prefix, live and released blobs apart, and the garbage queue', () => {
    const panel = toBlobPanel(BLOBS);
    expect(panel).toMatchObject({
      backend: 'db', backendText: 'Database', s3Text: 'Configured', s3State: 'Success', s3Configured: true, prefix: 'sail-proxy/blobs',
      unreachable: false, garbageText: '4 queued, 2 due', garbageFailing: 1,
      garbageFailingText: '1 queued object deletion(s) failed and are being retried. Check the S3 permissions.',
      migration: null, migrationWarning: '', canMigrate: true
    });
    expect(panel.rows).toEqual([
      { storage: 'db', storageText: 'Database', liveBlobs: '1,200', liveSize: '3.0 MB', releasedBlobs: '3', releasedSize: '2.0 KB', addressable: true, statusText: 'Reachable', statusState: 'Success' },
      { storage: 's3', storageText: 'S3', liveBlobs: '7', liveSize: '1.5 KB', releasedBlobs: '1', releasedSize: '10 B', addressable: true, statusText: 'Reachable', statusState: 'Success' }
    ]);
  });

  it('flags blobs in a storage the gateway cannot address, and S3 without credentials or configuration', () => {
    const noKeys = toBlobPanel({ ...BLOBS, s3: { configured: true, credentials_present: false, prefix: 'p' },
      storages: [{ ...BLOBS.storages[1], addressable: false }] });
    expect(noKeys).toMatchObject({ s3Text: 'Configured, credentials missing', s3State: 'None', unreachable: true });
    expect(noKeys.rows[0]).toMatchObject({ statusText: 'Not reachable', statusState: 'Error' });
    const unconfigured = toBlobPanel({ ...BLOBS, configured_backend: 's3', s3: { configured: false, credentials_present: true, prefix: 'p' } });
    expect(unconfigured).toMatchObject({ s3Text: 'Not configured', s3State: 'Error', prefix: '' });
    // An unreachable storage without any blob left is no reason for the warning.
    expect(toBlobPanel({ ...BLOBS, storages: [{ storage: 'local', live_blobs: 0, released_blobs: 0, addressable: false }] }).unreachable).toBe(false);
    expect(toBlobPanel({ ...BLOBS, storages: [{ storage: 'local', live_blobs: 0, released_blobs: 2, addressable: false }] }).rows[0].storageText).toBe('local');
  });

  it('a failing garbage count of zero shows no warning text; a missing overview is an empty panel', () => {
    expect(toBlobPanel({ ...BLOBS, garbage: [] })).toMatchObject({ garbageText: '0 queued, 0 due', garbageFailing: 0, garbageFailingText: '' });
    expect(toBlobPanel(BLOBS)).toMatchObject({ outsidePrefix: 0, outsidePrefixText: '' });
    expect(toBlobPanel({ ...BLOBS, s3: { ...BLOBS.s3, outside_prefix_blobs: 1200 } })).toMatchObject({
      outsidePrefix: 1200,
      outsidePrefixText: '1,200 blob(s) in S3 are stored under another prefix and cannot be read with the current one. Set the previous prefix again to read them.'
    });
    expect(toBlobPanel(null)).toMatchObject({ backend: '', rows: [], unreachable: false, migration: null, canMigrate: true, s3Text: 'Not configured' });
  });

  it('warns while a migration to another storage than the configured backend runs, and blocks a second start', () => {
    const panel = toBlobPanel({ ...BLOBS, migration: MIGRATION });
    expect(panel.migration).toEqual({
      id: 'job_m', target: 's3', targetText: 'S3', state: 'running', stateText: 'Running', stateColor: 'Information', active: true,
      progress: '3/8', percent: 50, failed: 1, canCancel: true
    });
    expect(panel.migrationWarning).toBe('New uploads still go to Database. Set the blob storage backend to S3 in the configuration as well, or new files keep arriving in Database.');
    expect(panel.canMigrate).toBe(false);
    expect(toBlobPanel({ ...BLOBS, configured_backend: 's3', migration: MIGRATION }).migrationWarning).toBe('');
  });

  it('a finished migration shows no warning and allows a new start', () => {
    const panel = toBlobPanel({ ...BLOBS, migration: { ...MIGRATION, state: 'completed', done: 8, failed: 0, in_progress: 0 } });
    expect(panel).toMatchObject({ migrationWarning: '', canMigrate: true });
    expect(panel.migration).toMatchObject({ active: false, percent: 100, canCancel: false, stateText: 'Completed' });
  });

  it('translates with the injected translator and formats with the locale', () => {
    const t = (key: string, args?: (string | number)[]) => `${key}${args ? `(${args.join('|')})` : ''}`;
    const panel = toBlobPanel({ ...BLOBS, migration: MIGRATION }, t, 'de-DE');
    // A translator that echoes the key has no text for a storage: the raw name is shown.
    expect(panel.backendText).toBe('db');
    expect(panel.s3Text).toBe('blobS3Ready');
    expect(panel.rows[0].liveBlobs).toBe('1.200');
    expect(panel.rows[0].liveSize).toBe('3,0 MB');
    expect(panel.migrationWarning).toBe('blobMigrationTargetDiffers(db|s3)');
  });
});

describe('toBlobMigrationView', () => {
  it('is null without a job, and counts every settled item into the percentage', () => {
    expect(toBlobMigrationView(null)).toBeNull();
    expect(toBlobMigrationView({ ...MIGRATION, total: 0, done: 0, failed: 0, in_progress: 0, state: 'completed' })?.percent).toBe(0);
    expect(toBlobMigrationView({ ...MIGRATION, state: 'cancelled', done: 2, failed: 0, cancelled: 6, in_progress: 0 }))
      .toMatchObject({ percent: 100, active: false, canCancel: false, stateText: 'Cancelled' });
    expect(toBlobMigrationView({ ...MIGRATION, target_storage: null })?.target).toBe('');
  });
});

describe('migrationWarning', () => {
  it('is empty when the target is the configured backend or one is unknown', () => {
    expect(migrationWarning('db', 'db')).toBe('');
    expect(migrationWarning('', 'db')).toBe('');
    expect(migrationWarning('s3', '')).toBe('');
    expect(migrationWarning('db', 's3')).toBe('New uploads still go to S3. Set the blob storage backend to Database in the configuration as well, or new files keep arriving in S3.');
  });
});

describe('blobsToMove', () => {
  it('counts every blob outside the target, released ones included', () => {
    expect(blobsToMove(BLOBS, 's3')).toEqual({ blobs: 1203, bytes: 3 * 1024 * 1024 + 2048 });
    expect(blobsToMove(BLOBS, 'db')).toEqual({ blobs: 8, bytes: 1546 });
    expect(blobsToMove(null, 'db')).toEqual({ blobs: 0, bytes: 0 });
  });
});

describe('connectionTestResult', () => {
  it('maps success, a missing configuration and a refused request', () => {
    expect(connectionTestResult({ ok: true })).toEqual({ text: 'The S3 bucket answered: the connection works.', type: 'Success' });
    expect(connectionTestResult({ ok: false, error: { reason: 'not_configured' } })).toEqual({ text: 'S3 is not configured, or its credentials are missing.', type: 'Warning' });
    expect(connectionTestResult({ ok: false, error: { reason: 'request_failed', op: 'PutObject', status: 403, code: 'AccessDenied' } }))
      .toEqual({ text: 'The S3 connection test failed (PutObject HTTP 403 AccessDenied).', type: 'Error' });
    expect(connectionTestResult({ ok: false, error: { reason: 'request_failed', op: 'GetObject', status: null, code: 'timeout' } }).text)
      .toBe('The S3 connection test failed (GetObject timeout).');
    expect(connectionTestResult(null).text).toBe('The S3 connection test failed ().');
  });
});
