/**
 * My jobs: the first page, "More", and the refresh that keeps every loaded page. The UI5 modules are replaced
 * by minimal stand-ins; the controller logic and the model mappers are the real ones.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as jobs from '../webapp/model/jobs';
import * as paging from '../webapp/model/paging';

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
  async api(): Promise<any> { return this.apiStub; }
  async translator(): Promise<any> { return (key: string) => key; }
  locale(): string { return 'en-US'; }
  async showError(error: any): Promise<void> { this.shown.push(error); }
}

function loadController(): any {
  const file = path.join(__dirname, '../webapp/controller/Jobs.controller.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const modules: Record<string, any> = {
    'sap/ui/model/json/JSONModel': { __esModule: true, default: JSONModel },
    './BaseController': { __esModule: true, default: BaseController },
    '../model/jobs': jobs,
    '../model/paging': paging
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  }, module, module.exports);
  return module.exports.default;
}
const JobsController = loadController();

const jobIds = (n: number) => Array.from({ length: n }, (_v, i) => `job_${String(n - i).padStart(3, '0')}`);

/** The gateway's GET /grounding/jobs over a newest-first id list; every job is `state`. */
function gateway(ids: string[], state = 'completed', activeId = '') {
  const list = ids.slice();
  const api = {
    list,
    listJobs: jest.fn(async (options: { limit?: number; after?: string } = {}) => {
      const limit = options.limit ?? 20;
      // Like the gateway: a cursor that names no job answers an empty page.
      const gone = options.after !== undefined && list.indexOf(options.after) < 0;
      const start = options.after ? list.indexOf(options.after) + 1 : 0;
      const data = gone ? [] : list.slice(start, start + limit).map((id) => ({ id, kind: 'file_batch', state: id === activeId ? 'running' : state, store_id: 'vs_1' }));
      return { ok: true, status: 200, error: null, body: { data, has_more: !gone && start + limit < list.length, last_id: data.length ? data[data.length - 1].id : null } };
    })
  };
  return api;
}

function open(api: any): any {
  const c: any = new JobsController();
  c.apiStub = api;
  c.onInit();
  return c;
}
const model = (c: any) => c.getView().getModel();

describe('My jobs paging', () => {
  it('loads the first page of 20 and offers More', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    expect(api.listJobs).toHaveBeenCalledWith({ limit: 20 });
    expect(model(c).getProperty('/jobs')).toHaveLength(20);
    expect(model(c).getProperty('/hasMore')).toBe(true);
  });

  it('More adds the next page after the last shown job', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    await c.onMore();
    expect(api.listJobs).toHaveBeenLastCalledWith({ limit: 20, after: 'job_026' });
    const ids = model(c).getProperty('/jobs').map((r: any) => r.id);
    expect(ids).toEqual(jobIds(45).slice(0, 40));
    await c.onMore();
    expect(model(c).getProperty('/jobs')).toHaveLength(45);
    expect(model(c).getProperty('/hasMore')).toBe(false);
  });

  it('a job that arrives between two pages neither repeats nor drops a row', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    api.list.unshift('job_999');
    await c.onMore();
    const ids = model(c).getProperty('/jobs').map((r: any) => r.id);
    expect(ids).toEqual(jobIds(45).slice(0, 40));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('More after a deleted cursor starts again from the top', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    api.list.splice(api.list.indexOf('job_026'), 1);
    await c.onMore();
    const ids = model(c).getProperty('/jobs').map((r: any) => r.id);
    expect(ids).toEqual(api.list.slice(0, 20));
  });

  it('a manual refresh starts again from the first page', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    await c.onMore();
    await c.load();
    expect(model(c).getProperty('/jobs')).toHaveLength(20);
  });

  it('keeps the list and shows the error when a page fails', async () => {
    const api = gateway(jobIds(45));
    const c = open(api);
    await c.load();
    const error = { status: 500, code: 'boom' };
    api.listJobs.mockResolvedValueOnce({ ok: false, status: 500, body: null, error } as any);
    await c.onMore();
    expect(c.shown).toEqual([error]);
    expect(model(c).getProperty('/jobs')).toHaveLength(20);
  });
});

describe('My jobs refresh', () => {
  let hidden = false;
  let listener: (() => void) | null = null;
  beforeEach(() => {
    jest.useFakeTimers();
    hidden = false;
    listener = null;
    (globalThis as any).document = {
      get hidden() { return hidden; },
      addEventListener: (_n: string, f: () => void) => { listener = f; },
      removeEventListener: () => { listener = null; }
    };
  });
  afterEach(() => { jest.useRealTimers(); delete (globalThis as any).document; });

  async function loaded(api: any, rows: number): Promise<any> {
    const c = open(api);
    c.active = true;
    await c.load();
    while (model(c).getProperty('/jobs').length < rows) await c.onMore();
    api.listJobs.mockClear();
    return c;
  }
  const tick = async (ms = 3000) => { await jest.advanceTimersByTimeAsync(ms); };

  it('refreshes with one request per tick over 2,000 loaded rows and keeps the tail', async () => {
    const ids = ['job_active', ...jobIds(2000)];
    const api = gateway(ids, 'completed', 'job_active');
    const c = await loaded(api, 2000);
    await tick();
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    expect(api.listJobs).toHaveBeenCalledWith({ limit: 21 });
    const rows = model(c).getProperty('/jobs');
    expect(rows.map((r: any) => r.id)).toEqual(ids.slice(0, 2000));
    expect(model(c).getProperty('/lastId')).toBe(ids[1999]);
    expect(model(c).getProperty('/hasMore')).toBe(true);
    c.onExit();
  });

  it('makes no request while the browser tab is hidden and refreshes when it is shown again', async () => {
    const api = gateway(['job_active', ...jobIds(30)], 'completed', 'job_active');
    const c = await loaded(api, 21);
    hidden = true;
    await tick(60000);
    expect(api.listJobs).not.toHaveBeenCalled();
    hidden = false;
    listener!();
    await tick(0);
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    c.onExit();
  });

  it('backs off while nothing changes', async () => {
    const api = gateway(['job_active', ...jobIds(5)], 'completed', 'job_active');
    const c = await loaded(api, 6);
    await tick(3000);
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    await tick(3000);
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    await tick(3000);
    expect(api.listJobs).toHaveBeenCalledTimes(2);
    c.onExit();
  });

  it('keeps refreshing after a failed refresh and shows the error once', async () => {
    const api = gateway(['job_active', ...jobIds(5)], 'completed', 'job_active');
    const c = await loaded(api, 6);
    const error = { status: 500, code: 'boom' };
    api.listJobs.mockResolvedValue({ ok: false, status: 500, body: null, error } as any);
    await tick(3000);
    await tick(6000);
    await tick(12000);
    expect(api.listJobs.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(c.shown).toEqual([error]);
    expect(model(c).getProperty('/jobs')).toHaveLength(6);
    c.onExit();
  });
});
