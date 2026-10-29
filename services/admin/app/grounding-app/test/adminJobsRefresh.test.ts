/**
 * The admin Jobs tab's quiet refresh: only the head of a long list is asked for again, the loaded tail stays, a
 * hidden browser tab makes no request, and a failing refresh keeps polling. The UI5 modules are replaced by minimal
 * stand-ins; the controller logic and the model modules are the real ones.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

class JSONModel {
  private data: any;
  constructor(data: any) { this.data = data; }
  getProperty(p: string): any { return p.split('/').filter(Boolean).reduce((o: any, k) => (o == null ? undefined : o[k]), this.data); }
  setProperty(p: string, value: any): void {
    const keys = p.split('/').filter(Boolean);
    const last = keys.pop()!;
    keys.reduce((o: any, k) => (o[k] ??= {}), this.data)[last] = value;
  }
}

class BaseController {
  public apiStub: any = null;
  public shown: any[] = [];
  private model: any = null;
  getView(): any { return { setModel: (m: any) => { this.model = m; }, getModel: () => this.model }; }
  router(): any { return { getRoute: () => ({ attachPatternMatched() {}, detachPatternMatched() {} }), attachRouteMatched() {}, detachRouteMatched() {}, navTo() {} }; }
  appModel(): any { return new JSONModel({ isAdmin: true }); }
  async api(): Promise<any> { return this.apiStub; }
  async translator(): Promise<any> { return (key: string) => key; }
  locale(): string { return 'en-US'; }
  async text(key: string): Promise<string> { return key; }
  async showError(error: any): Promise<void> { this.shown.push(error); }
}

class Stub { constructor(..._args: any[]) {} }

function loadController(): any {
  const file = path.join(__dirname, '../webapp/controller/Admin.controller.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const modules: Record<string, any> = {
    'sap/ui/model/json/JSONModel': { __esModule: true, default: JSONModel },
    'sap/m/MessageBox': { __esModule: true, default: { confirm() {}, Action: { OK: 'OK' } } },
    'sap/m/MessageToast': { __esModule: true, default: { show() {} } },
    './BaseController': { __esModule: true, default: BaseController },
    '../model/api': {},
    '../model/admin': require('../webapp/model/admin'),
    '../model/jobs': require('../webapp/model/jobs'),
    '../model/paging': require('../webapp/model/paging'),
    '../model/reembed': require('../webapp/model/reembed'),
    '../model/reextract': require('../webapp/model/reextract'),
    './blobPanel': { BlobPanelController: Stub, emptyBlob: () => ({}) },
    './chunkingFlow': { ChunkingFlow: Stub, emptyChunking: () => ({}) },
    './chunkingDialogs': { openChangeChunkingDialog() {} },
    './reextractFlow': { ReextractFlow: Stub, emptyReextract: () => ({}) },
    './reextractDialog': { openReextractDialog() {} }
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  }, module, module.exports);
  return module.exports.default;
}
const AdminController = loadController();

const jobIds = (n: number) => Array.from({ length: n }, (_v, i) => `job_${String(n - i).padStart(4, '0')}`);

/** GET /grounding/admin/jobs over a newest-first id list; a cursor that names no job answers an empty page. */
function gateway(ids: string[], activeId: string) {
  return {
    adminJobs: jest.fn(async (options: { limit?: number; after?: string } = {}) => {
      const limit = options.limit ?? 20;
      const gone = options.after !== undefined && ids.indexOf(options.after) < 0;
      const start = options.after ? ids.indexOf(options.after) + 1 : 0;
      const data = gone ? [] : ids.slice(start, start + limit).map((id) => ({ id, kind: 'file_batch', state: id === activeId ? 'running' : 'completed', store_id: 'vs_1' }));
      return { ok: true, status: 200, error: null, body: { data, has_more: !gone && start + limit < ids.length, last_id: data.length ? data[data.length - 1].id : null } };
    })
  };
}

describe('Admin Jobs tab refresh', () => {
  let hidden = false;
  beforeEach(() => {
    jest.useFakeTimers();
    hidden = false;
    (globalThis as any).document = { get hidden() { return hidden; }, addEventListener() {}, removeEventListener() {} };
  });
  afterEach(() => { jest.useRealTimers(); delete (globalThis as any).document; });

  async function open(api: any, rows: number): Promise<any> {
    const c: any = new AdminController();
    c.apiStub = api;
    c.onInit();
    c.active = true;
    c.getView().getModel().setProperty('/tab', 'jobs');
    await c.loadList('jobs');
    while (c.getView().getModel().getProperty('/jobs/rows').length < rows) await c.loadList('jobs', 'more');
    api.adminJobs.mockClear();
    return c;
  }

  it('asks one request per tick over a long list and keeps the loaded tail', async () => {
    const ids = ['job_active', ...jobIds(1000)];
    const api = gateway(ids, 'job_active');
    const c = await open(api, 1000);
    await jest.advanceTimersByTimeAsync(3000);
    expect(api.adminJobs).toHaveBeenCalledTimes(1);
    expect(api.adminJobs).toHaveBeenCalledWith({ limit: 21 });
    const model = c.getView().getModel();
    expect(model.getProperty('/jobs/rows').map((r: any) => r.id)).toEqual(ids.slice(0, 1000));
    expect(model.getProperty('/jobs/lastId')).toBe(ids[999]);
    expect(model.getProperty('/jobs/hasMore')).toBe(true);
    c.onExit();
  });

  it('makes no request while the browser tab is hidden', async () => {
    const api = gateway(['job_active', ...jobIds(30)], 'job_active');
    const c = await open(api, 21);
    hidden = true;
    await jest.advanceTimersByTimeAsync(60000);
    expect(api.adminJobs).not.toHaveBeenCalled();
    c.onExit();
  });

  it('keeps refreshing after a failure and shows the error once', async () => {
    const api = gateway(['job_active', ...jobIds(5)], 'job_active');
    const c = await open(api, 6);
    const error = { status: 500, code: 'boom' };
    api.adminJobs.mockResolvedValue({ ok: false, status: 500, body: null, error } as any);
    await jest.advanceTimersByTimeAsync(3000);
    await jest.advanceTimersByTimeAsync(6000);
    await jest.advanceTimersByTimeAsync(12000);
    expect(api.adminJobs.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(c.shown).toEqual([error]);
    c.onExit();
  });

  it('a stale answer for an older filter does not become the applied filter', async () => {
    const ids = jobIds(30);
    const pending: Record<string, () => void> = {};
    const api: any = {
      adminJobs: jest.fn((options: any) => new Promise((resolve) => {
        if (options.after) {
          resolve({ ok: true, status: 200, error: null, body: { data: [{ id: 'job_more', state: 'completed' }], has_more: false, last_id: 'job_more' } });
        } else {
          pending[options.owner] = () => resolve({ ok: true, status: 200, error: null, body: { data: ids.slice(0, 20).map((id) => ({ id, state: 'completed' })), has_more: true, last_id: ids[19] } });
        }
      }))
    };
    const c: any = new AdminController();
    c.apiStub = api;
    c.onInit();
    c.active = true;
    const model = c.getView().getModel();
    model.setProperty('/tab', 'jobs');
    model.setProperty('/jobs/owner', 'a@test.com');
    const a = c.loadList('jobs');
    await jest.advanceTimersByTimeAsync(0);
    model.setProperty('/jobs/owner', 'b@test.com');
    const b = c.loadList('jobs');
    await jest.advanceTimersByTimeAsync(0);
    pending['b@test.com']();
    await b;
    pending['a@test.com']();
    await a;
    // The typed filter is edited again, but More must use the filter the shown rows were loaded with: B's.
    model.setProperty('/jobs/owner', 'c@test.com');
    api.adminJobs.mockClear();
    await c.loadList('jobs', 'more');
    expect(api.adminJobs).toHaveBeenCalledWith({ owner: 'b@test.com', after: ids[19], limit: 20 });
    c.onExit();
  });
});
