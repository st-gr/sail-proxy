/**
 * JobDetail's re-embed failures table: the requests it makes while the user switches jobs, polls
 * a failing request, or presses "More" while the first page reloads. The UI5 modules are replaced
 * by minimal stand-ins; the controller logic and the pure model mappers are the real ones.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as jobs from '../webapp/model/jobs';
import * as rows from '../webapp/model/rows';

class JSONModel {
  private data: any;
  constructor(data: any) { this.data = data; }
  getProperty(p: string): any {
    return p.split('/').filter(Boolean).reduce((o: any, k) => (o == null ? undefined : o[k]), this.data);
  }
  setProperty(p: string, value: any): void {
    const keys = p.split('/').filter(Boolean);
    const last = keys.pop()!;
    const parent = keys.reduce((o: any, k) => (o[k] ??= {}), this.data);
    parent[last] = value;
  }
}

class BaseController {
  public readyApi: any = null;
  public apiStub: any = null;
  public shown: any[] = [];
  public isAdmin = false;
  public navigated: string[] = [];
  public actions: any[] = [];
  private model: any = null;
  appModel(): any { return new JSONModel({ isAdmin: this.isAdmin }); }
  async jobAction(...args: any[]): Promise<boolean> { this.actions.push(args); return true; }
  getView(): any {
    return { setModel: (m: any) => { this.model = m; }, getModel: () => this.model };
  }
  router(): any {
    return {
      getRoute: () => ({ attachPatternMatched() {}, detachPatternMatched() {} }), attachRouteMatched() {}, detachRouteMatched() {},
      navTo: (name: string) => { this.navigated.push(name); }
    };
  }
  async api(): Promise<any> { this.readyApi = this.apiStub; return this.apiStub; }
  async translator(): Promise<any> { return (key: string) => key; }
  locale(): string { return 'en-US'; }
  async text(key: string): Promise<string> { return key; }
  async showError(error: any): Promise<void> { this.shown.push(error); }
}

/**
 * The controller compiled without type checking (the UI5 type declarations are not installed for
 * jest), its UI5 imports answered by the stand-ins above and its model imports by the real modules.
 */
function loadController(): any {
  const file = path.join(__dirname, '../webapp/controller/JobDetail.controller.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const modules: Record<string, any> = {
    'sap/ui/model/json/JSONModel': { __esModule: true, default: JSONModel },
    './BaseController': { __esModule: true, default: BaseController },
    '../model/jobs': jobs,
    '../model/rows': rows
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  }, module, module.exports);
  return module.exports.default;
}

const JobDetailController = loadController();

function job(id: string, failed: number, kind = 'reembed_store'): any {
  return { ok: true, body: { id, kind, state: 'failed', store_id: 'vs_1', total: 3, done: 3 - failed, failed } };
}

function page(fileIds: string[], hasMore: boolean): any {
  return {
    ok: true,
    body: {
      data: fileIds.map(f => ({ id: `j/${f}`, file_id: f, store_id: 'vs_1', filename: `${f}.txt`, last_error: { message: 'boom' }, attempts: 1 })),
      has_more: hasMore,
      last_id: fileIds.length ? `j/${fileIds[fileIds.length - 1]}` : null
    }
  };
}

function deferred(): { promise: Promise<any>; resolve: (v: any) => void } {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}

function open(jobId: string, api: any): any {
  const c: any = new (JobDetailController as any)();
  c.apiStub = api;
  c.onInit();
  c.jobId = jobId;
  c.active = true;
  return c;
}

describe('JobDetail re-embed failures', () => {
  it('a job switch during the load never reads the failures of the newly opened job with the old one', async () => {
    const api = { getJob: jest.fn(async (id: string) => job(id, 1)), jobFailures: jest.fn(async () => page(['f1'], false)) };
    const c = open('job_a', api);
    // The user opens job B while A's summary is being formatted.
    c.text = async (key: string) => { c.jobId = 'job_b'; return key; };
    await c.load();
    expect(api.jobFailures).not.toHaveBeenCalled();
  });

  it('a failing failures request shows its error once, not on every poll', async () => {
    const error = { status: 500, code: 'boom' };
    const api = { getJob: jest.fn(async (id: string) => job(id, 1)), jobFailures: jest.fn(async () => ({ ok: false, status: 500, error })) };
    const c = open('job_a', api);
    await c.load();
    await c.load(true);
    await c.load(true);
    expect(c.shown).toEqual([error]);
  });

  it('a "More" answer is dropped when the first page reloaded meanwhile', async () => {
    let failed = 2;
    const more = deferred();
    const api = {
      getJob: jest.fn(async (id: string) => job(id, failed)),
      jobFailures: jest.fn(async (_id: string, options: any) => (options.after ? more.promise : page(failed === 2 ? ['f1'] : ['f1', 'f2', 'f3'], failed === 2)))
    };
    const c = open('job_a', api);
    await c.load();
    expect(c.getView().getModel().getProperty('/reembedFailures/lastId')).toBe('j/f1');

    const pending = c.onMoreFailures();
    failed = 3;
    await c.load(true);
    more.resolve(page(['f2'], false));
    await pending;

    const rows = c.getView().getModel().getProperty('/reembedFailures/rows');
    expect(rows.map((r: any) => r.key)).toEqual(['j/f1', 'j/f2', 'j/f3']);
    expect(c.getView().getModel().getProperty('/reembedFailures/lastId')).toBe('j/f3');
  });

  it('a blob migration reads its failed blobs through the admin route and shows them as blobs', async () => {
    const sha = 'ef'.repeat(32);
    const api = {
      getJob: jest.fn(async (id: string) => ({ ok: true, body: { id, kind: 'blob_migration', state: 'completed_with_errors', store_id: null, total: 3, done: 2, failed: 1 } })),
      jobFailures: jest.fn(),
      adminJobFailures: jest.fn(async () => ({ ok: true, body: { data: [{ id: sha, sha256: sha, source_storage: 'db', size_bytes: 10, last_error: { message: 'boom' }, attempts: 3 }], has_more: false, last_id: sha } }))
    };
    const c = open('job_m', api);
    await c.load();
    expect(api.jobFailures).not.toHaveBeenCalled();
    expect(api.adminJobFailures).toHaveBeenCalledWith('job_m', { limit: 50, after: undefined });
    const model = c.getView().getModel();
    expect([model.getProperty('/reembed'), model.getProperty('/blobMigration')]).toEqual([false, true]);
    expect(model.getProperty('/reembedFailures/rows')).toEqual([
      { key: sha, sha256: sha, shortSha: 'efefefefefef', source: 'db', size: '10 B', error: 'boom', attempts: 3 }
    ]);
  });
});

describe('JobDetail of another owner\'s job (an admin)', () => {
  const notFound = { ok: false, status: 404, error: { status: 404, code: 'not_found' } };
  const batchJob = (id: string) => ({
    ok: true,
    body: { id, kind: 'file_batch', state: 'completed_with_errors', store_id: 'vs_9', batch_id: 'vsfb_9', total: 3, done: 1, failed: 2, owner_email: 'other@example.test' }
  });

  it('reads the job and its failed batch members through the admin routes, and keeps polling there', async () => {
    const api = {
      getJob: jest.fn(async () => notFound),
      adminGetJob: jest.fn(async (id: string) => batchJob(id)),
      listBatchFiles: jest.fn(), listFiles: jest.fn(),
      adminBatchFailures: jest.fn(async () => ({
        ok: true,
        body: [
          { id: 'vs_9/file-a', store_id: 'vs_9', file_id: 'file-a', filename: 'scan.pdf', last_error: { message: 'Extraction timed out', name: 'E' }, attempts: 3, batch_id: 'vsfb_9' },
          { id: 'vs_9/file-b', store_id: 'vs_9', file_id: 'file-b', filename: 'b.docx', last_error: { message: 'Unsupported file type', name: null }, attempts: 1, batch_id: 'vsfb_9' }
        ]
      }))
    };
    const c = open('job_x', api);
    c.isAdmin = true;
    await c.load();
    await c.load(true);
    expect(c.shown).toEqual([]);
    expect(c.navigated).toEqual([]);
    expect(api.getJob).toHaveBeenCalledTimes(1);
    expect(api.adminGetJob).toHaveBeenCalledTimes(2);
    expect(api.listBatchFiles).not.toHaveBeenCalled();
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(api.adminBatchFailures).toHaveBeenCalledWith('vsfb_9');
    const model = c.getView().getModel();
    expect(model.getProperty('/failedFiles').map((r: any) => [r.id, r.filename, r.error])).toEqual([
      ['file-a', 'scan.pdf', 'Extraction timed out'], ['file-b', 'b.docx', 'Unsupported file type']
    ]);
    // The admin job routes take re-embeds and blob migrations only: no cancel or retry of another owner's batch.
    expect([model.getProperty('/job/canCancel'), model.getProperty('/job/canRetry')]).toEqual([false, false]);
    // The store page is the owner's (another owner's store is a 404 there): no link to it.
    expect(model.getProperty('/adminView')).toBe(true);
    c.onOpenStore();
    expect(c.navigated).toEqual([]);
  });

  it('an own job keeps the link to its store', async () => {
    const api = { getJob: jest.fn(async (id: string) => ({ ok: true, body: { ...batchJob(id).body, failed: 0 } })), adminGetJob: jest.fn() };
    const c = open('job_o', api);
    c.isAdmin = true;
    await c.load();
    expect(c.getView().getModel().getProperty('/adminView')).toBe(false);
    c.onOpenStore();
    expect(c.navigated).toEqual(['groundingStoreDetail']);
  });

  it('reads another owner\'s re-chunk failures and cancels it through the admin routes', async () => {
    const api = {
      getJob: jest.fn(async () => notFound),
      adminGetJob: jest.fn(async (id: string) => ({ ok: true, body: { ...job(id, 1).body, state: 'running', in_progress: 1, total: 4, done: 2 } })),
      jobFailures: jest.fn(),
      adminJobFailures: jest.fn(async () => page(['f1'], false))
    };
    const c = open('job_r', api);
    c.isAdmin = true;
    await c.load();
    expect(api.jobFailures).not.toHaveBeenCalled();
    expect(api.adminJobFailures).toHaveBeenCalledWith('job_r', { limit: 50, after: undefined });
    expect(c.getView().getModel().getProperty('/job/canCancel')).toBe(true);
    await c.onCancel();
    expect(c.actions).toEqual([['cancel', 'job_r', 'reembed_store', true]]);
  });

  it('a new job id starts on the owner route again', async () => {
    const api = {
      getJob: jest.fn(async () => notFound),
      adminGetJob: jest.fn(async (id: string) => batchJob(id)),
      adminBatchFailures: jest.fn(async () => ({ ok: true, body: [] }))
    };
    const c = open('job_x', api);
    c.isAdmin = true;
    await c.load();
    c.onJobMatched({ getParameter: () => ({ jobId: 'job_y' }) });
    await new Promise((r) => setImmediate(r));
    expect(api.getJob.mock.calls.map((call: any[]) => call[0])).toEqual(['job_x', 'job_y']);
  });

  it('anyone else gets the 404 and goes back, as before', async () => {
    const api = { getJob: jest.fn(async () => notFound), adminGetJob: jest.fn() };
    const c = open('job_x', api);
    await c.load();
    expect(api.adminGetJob).not.toHaveBeenCalled();
    expect(c.shown).toEqual([notFound.error]);
    expect(c.navigated).toEqual(['groundingJobs']);
  });

  it('an admin\'s own job stays on the owner routes', async () => {
    const api = { getJob: jest.fn(async (id: string) => job(id, 0)), adminGetJob: jest.fn(), jobFailures: jest.fn() };
    const c = open('job_o', api);
    c.isAdmin = true;
    await c.load();
    await c.onRetry();
    expect(api.adminGetJob).not.toHaveBeenCalled();
    expect(c.actions).toEqual([['retry', 'job_o', 'reembed_store', false]]);
  });
});
