/**
 * The Blob storage panel's controller logic with a stand-in host: target defaulting, the poll re-arm only while
 * the overview is shown and a migration is active, the 409 reload after a refused start, and the cancel.
 */
import { BlobPanelController, emptyBlob, BlobPanelHost } from '../webapp/controller/blobPanel';

const OVERVIEW = (extra: Record<string, unknown> = {}) => ({
  configured_backend: 'db',
  s3: { configured: true, credentials_present: true, prefix: 'p' },
  storages: [{ storage: 'db', live_blobs: 2, live_bytes: 20, released_blobs: 0, released_bytes: 0, addressable: true }],
  garbage: [],
  migration: null,
  ...extra
});
const RUNNING = { id: 'job_m', kind: 'blob_migration', state: 'running', total: 2, done: 1, failed: 0, cancelled: 0, in_progress: 1, target_storage: 's3' };
const ok = (body: any) => ({ ok: true, status: 200, body, error: null });
const refused = (status: number, code: string) => ({ ok: false, status, body: null, error: { status, code, message: code } });

function setup(options: { overviewShown?: boolean } = {}) {
  const data: any = { blob: emptyBlob() };
  const api = {
    adminBlobStorage: jest.fn(async () => ok(OVERVIEW())),
    adminBlobStorageTest: jest.fn(async () => ok({ ok: true })),
    adminBlobMigrate: jest.fn(async () => ok({ job: { id: 'job_m' } })),
    adminCancelJob: jest.fn(async () => ok({ id: 'job_m' }))
  };
  const calls = { errors: [] as any[], toasts: [] as string[], confirms: [] as string[], scheduled: [] as (() => void)[], opened: [] as string[] };
  const host: BlobPanelHost = {
    getProperty: (path) => path.split('/').filter(Boolean).reduce((o: any, k) => (o == null ? undefined : o[k]), data),
    setProperty: (path, value) => {
      const keys = path.split('/').filter(Boolean);
      const last = keys.pop()!;
      keys.reduce((o: any, k) => (o[k] ??= {}), data)[last] = value;
    },
    adminApi: async () => api as any,
    translator: async () => (key: string, args?: (string | number)[]) => `${key}${args ? `(${args.join('|')})` : ''}`,
    text: async (key, args) => `${key}${args ? `(${args.join('|')})` : ''}`,
    locale: () => 'en-US',
    showError: (error) => { calls.errors.push(error); },
    // The user confirms every dialog.
    confirm: (question, onOk) => { calls.confirms.push(question); void onOk(); },
    toast: (text) => { calls.toasts.push(text); },
    overviewShown: () => options.overviewShown ?? true,
    schedule: (refresh) => { calls.scheduled.push(refresh); },
    openJob: (jobId) => { calls.opened.push(jobId); }
  };
  return { panel: new BlobPanelController(host), api, data, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BlobPanelController.load', () => {
  it('defaults the target to the configured backend, and to db when that is no migration target', async () => {
    const s3 = setup();
    s3.api.adminBlobStorage.mockResolvedValue(ok(OVERVIEW({ configured_backend: 's3' })));
    await s3.panel.load();
    expect(s3.data.blob).toMatchObject({ loaded: true, busy: false, target: 's3', backend: 's3' });

    const local = setup();
    local.api.adminBlobStorage.mockResolvedValue(ok(OVERVIEW({ configured_backend: 'local' })));
    await local.panel.load();
    expect(local.data.blob.target).toBe('db');
  });

  it('keeps the target the admin chose, and the last connection test, across a reload', async () => {
    const { panel, data } = setup();
    await panel.load();
    data.blob.target = 's3';
    data.blob.test = { text: 'blobTestOk', type: 'Success' };
    await panel.load();
    expect(data.blob).toMatchObject({ target: 's3', test: { text: 'blobTestOk', type: 'Success' } });
  });

  it('re-arms the poll only while a migration is active and the overview is shown', async () => {
    const idle = setup();
    await idle.panel.load();
    expect(idle.calls.scheduled).toHaveLength(0);

    const running = setup();
    running.api.adminBlobStorage.mockResolvedValue(ok(OVERVIEW({ migration: RUNNING })));
    await running.panel.load();
    expect(running.calls.scheduled).toHaveLength(1);
    // The scheduled refresh is quiet: a failure shows no error.
    running.api.adminBlobStorage.mockResolvedValue(refused(500, 'boom') as any);
    running.calls.scheduled[0]();
    await settle();
    expect(running.calls.errors).toEqual([]);

    const otherTab = setup({ overviewShown: false });
    otherTab.api.adminBlobStorage.mockResolvedValue(ok(OVERVIEW({ migration: RUNNING })));
    await otherTab.panel.load();
    expect(otherTab.calls.scheduled).toHaveLength(0);
  });

  it('shows a failed load, and drops an answer that a newer load overtook', async () => {
    const { panel, api, data, calls } = setup();
    api.adminBlobStorage.mockResolvedValueOnce(refused(503, 'file_search_unavailable') as any);
    await panel.load();
    expect(calls.errors).toHaveLength(1);
    expect(data.blob.busy).toBe(false);

    let release!: (v: any) => void;
    api.adminBlobStorage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = panel.load();
    await settle();
    api.adminBlobStorage.mockResolvedValueOnce(ok(OVERVIEW({ configured_backend: 's3' })));
    await panel.load();
    release(ok(OVERVIEW({ configured_backend: 'db', storages: [] })));
    await first;
    expect(data.blob.backend).toBe('s3');
    expect(data.blob.rows).toHaveLength(1);
  });
});

describe('BlobPanelController.migrate', () => {
  it('confirms with the target and what moves, warns when it is not the configured backend, and starts', async () => {
    const { panel, api, data, calls } = setup();
    await panel.load();
    data.blob.target = 's3';
    await panel.migrate();
    await settle();
    expect(calls.confirms[0]).toBe('blobConfirmMigrate(s3|2|20 B)\n\nblobMigrationTargetDiffers(db|s3)');
    expect(api.adminBlobMigrate).toHaveBeenCalledWith('s3');
    expect(calls.toasts).toEqual(['blobMigrationStarted']);
    expect(api.adminBlobStorage).toHaveBeenCalledTimes(2);
  });

  it('a target equal to the configured backend asks without the warning; nothing to move has its own toast', async () => {
    const { panel, api, calls } = setup();
    await panel.load();
    api.adminBlobMigrate.mockResolvedValue(ok({ job: null }));
    await panel.migrate();
    await settle();
    expect(calls.confirms[0]).toBe('blobConfirmMigrate(db|0|0 B)');
    expect(calls.toasts).toEqual(['blobNothingToMigrate(db)']);
  });

  it('a 409 shows the refusal and reloads the panel; another refusal does not reload', async () => {
    const { panel, api, calls } = setup();
    await panel.load();
    api.adminBlobMigrate.mockResolvedValueOnce(refused(409, 'migration_running') as any);
    await panel.migrate();
    await settle();
    expect(calls.errors.map((e) => e.code)).toEqual(['migration_running']);
    expect(api.adminBlobStorage).toHaveBeenCalledTimes(2);

    api.adminBlobMigrate.mockResolvedValueOnce(refused(400, 'invalid_target') as any);
    await panel.migrate();
    await settle();
    expect(calls.errors.map((e) => e.code)).toEqual(['migration_running', 'invalid_target']);
    expect(api.adminBlobStorage).toHaveBeenCalledTimes(2);
    expect(calls.toasts).toEqual([]);
  });
});

describe('BlobPanelController: test, cancel, view job', () => {
  it('shows the connection test result as a strip', async () => {
    const { panel, api, data } = setup();
    api.adminBlobStorageTest.mockResolvedValue(ok({ ok: false, error: { reason: 'not_configured' } }));
    await panel.test();
    expect(data.blob.test).toEqual({ text: 'blobTestNotConfigured', type: 'Warning' });
    expect(data.blob.testBusy).toBe(false);
  });

  it('cancels the shown migration after asking, then reloads; without a migration nothing happens', async () => {
    const { panel, api, data, calls } = setup();
    await panel.cancel();
    expect(calls.confirms).toEqual([]);
    api.adminBlobStorage.mockResolvedValue(ok(OVERVIEW({ migration: RUNNING })));
    await panel.load();
    await panel.cancel();
    await settle();
    expect(calls.confirms).toEqual([`blobConfirmCancel(${data.blob.migration.targetText})`]);
    expect(api.adminCancelJob).toHaveBeenCalledWith('job_m');
    expect(calls.toasts).toEqual(['blobMigrationCancelled']);
    panel.viewJob();
    expect(calls.opened).toEqual(['job_m']);
  });
});
