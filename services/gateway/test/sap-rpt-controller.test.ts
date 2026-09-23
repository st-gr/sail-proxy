/**
 * The SAP-RPT route is a pass-through. It resolves the model to its deployment, adds the SAP
 * credentials, forwards the body verbatim, relays SAP's answer verbatim - status, content type,
 * inference id, body - and bills the cells the response reports. The captured shapes (spec §3)
 * are reproduced here: a 200 with predictions, the 422 for eleven targets, the 400 for 130
 * query rows. Nothing is re-validated, no hook runs, nothing streams.
 */
const posted: Array<{ url: string; body: any; cfg: any }> = [];
let upstream: { status: number; data: any; headers: Record<string, string> } = { status: 200, data: {}, headers: {} };
jest.mock('axios', () => ({ __esModule: true, default: { post: async (url: string, body: any, cfg: any) => { posted.push({ url, body, cfg }); return upstream; } } }));

const catalogue: Record<string, any> = {
  // sap-rpt-1.6: only the --deployed twin is published (the live list carries no bare entry for it).
  'sap-rpt-1.6--deployed': { id: 'sap-rpt-1.6--deployed', deploymentUrl: 'https://ai.example.invalid/v2/inference/deployments/dep16', owned_by: 'SAP' },
  // sap-rpt-1.6-large: both the bare orchestration entry (no deploymentUrl) and its twin exist.
  'sap-rpt-1.6-large': { id: 'sap-rpt-1.6-large', deploymentUrl: null, owned_by: 'SAP' },
  'sap-rpt-1.6-large--deployed': { id: 'sap-rpt-1.6-large--deployed', deploymentUrl: 'https://ai.example.invalid/v2/inference/deployments/depL', owned_by: 'SAP' },
  // sap-rpt-1-small: a bare entry with neither it nor its twin carrying a deploymentUrl.
  'sap-rpt-1-small': { id: 'sap-rpt-1-small', deploymentUrl: null, owned_by: 'SAP' }
};
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  getModelDetails: async (id: string) => catalogue[id] ?? null,
  getAuthToken: async () => 'sap-token'
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getSAPAICoreConfig: () => ({ resourceGroup: 'default' }), getTimeout: () => 42000, getSubstitutedModel: (_e: string, m: string) => m },
  getTrustForwardedFor: () => false
}));
const emitted: any[] = [];
jest.mock('../src/utils/usageTracker', () => {
  const real = jest.requireActual('../src/utils/usageTracker');
  return { ...real, emitUsageEvent: async (_req: any, metrics: any, model: string, statusCode: number) => { emitted.push({ metrics, model, statusCode }); } };
});
const plugins = { before: jest.fn(), after: jest.fn() };
jest.mock('../src/services/pluginExecutor', () => ({ executeBeforePlugins: plugins.before, executeAfterPlugins: plugins.after }));

import { predict } from '../src/controllers/sapRptController';

const OK = { id: 'r1', metadata: { num_columns: 5, num_predictions: 4, num_query_rows: 2, num_rows: 14 },
  predictions: [{ 'Ticket ID': 'T-2001', 'Open Days': [{ prediction: 3.98, confidence: null, confidence_interval: [3.97, 4.19] }], 'Priority': [{ prediction: 'Low', confidence: 1, confidence_interval: null }] }],
  status: { code: 0, message: 'ok' } };
const BODY = { prediction_config: { target_columns: [{ name: 'Priority', task_type: 'classification', prediction_placeholder: '[PREDICT]' }] }, index_column: 'Ticket ID',
  rows: [{ 'Ticket ID': 'T-1000', Region: 'North', Priority: 'High' }, { 'Ticket ID': 'T-2001', Region: 'West', Priority: '[PREDICT]' }] };

function makeReq(model: string, body: any = BODY, entitlement?: any) {
  return { params: { model }, body, headers: {}, method: 'POST', originalUrl: `/sap/v1/rpt/${model}/predict`, get: () => undefined,
    unifiedAuth: { authType: 'api_key', data: { keyId: 'k1', email: 'user@example.invalid', ...(entitlement ? { entitlement } : {}) } }, socket: {} } as any;
}
function makeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined, locals: {} as Record<string, any> };
  res.status = (s: number) => { res.statusCode = s; return res; };
  res.set = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.send = (b: any) => { res.body = b; return res; };
  return res;
}

beforeEach(() => { posted.length = 0; emitted.length = 0; plugins.before.mockClear(); plugins.after.mockClear(); });

describe('sapRptController.predict', () => {
  it('forwards the body verbatim to the deployment and relays the response, headers and status', async () => {
    upstream = { status: 200, data: OK, headers: { 'content-type': 'application/json', 'ai-inference-id': 'inf-1', 'x-upstream-service-time': '860' } };
    const req = makeReq('sap-rpt-1.6'); const res = makeRes();
    await predict(req, res);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://ai.example.invalid/v2/inference/deployments/dep16/predict');
    expect(posted[0].body).toEqual(BODY);
    expect(posted[0].cfg.headers).toMatchObject({ Authorization: 'Bearer sap-token', 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' });
    expect(posted[0].cfg.timeout).toBe(42000);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(OK);
    expect(res.headers['ai-inference-id']).toBe('inf-1');
    expect(plugins.before).not.toHaveBeenCalled();
    expect(plugins.after).not.toHaveBeenCalled();
    // Marks the relay so shapeMiddlewareErrors (mounted ahead of this controller on the real
    // router) leaves SAP's own response untouched instead of misattributing it to the gateway.
    expect(res.locals.sapRelay).toBe(true);
  });

  it('resolves a --deployed request identically to its bare twin', async () => {
    upstream = { status: 200, data: OK, headers: { 'content-type': 'application/json', 'ai-inference-id': 'inf-2' } };
    const req = makeReq('sap-rpt-1.6--deployed'); const res = makeRes();
    await predict(req, res);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://ai.example.invalid/v2/inference/deployments/dep16/predict');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(OK);
  });

  it('bills the cells the response reports, as cells, against the resolved twin model', async () => {
    upstream = { status: 200, data: OK, headers: {} };
    await predict(makeReq('sap-rpt-1.6'), makeRes());
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ model: 'sap-rpt-1.6--deployed', statusCode: 200 });
    expect(emitted[0].metrics).toMatchObject({ inputTokens: 70, outputTokens: 4, unit: 'cells', usageEstimated: false });
  });

  it('accounts a deep-context call on the --deep-context id, stripped of --deployed', async () => {
    upstream = { status: 200, data: { ...OK, metadata: { ...OK.metadata, context_mode: 'deep' } }, headers: {} };
    await predict(makeReq('sap-rpt-1.6-large'), makeRes());
    expect(emitted[0].model).toBe('sap-rpt-1.6-large--deep-context');
  });

  it('relays a SAP 422 and a SAP 400 verbatim and bills nothing', async () => {
    const e422 = { detail: [{ loc: ['prediction_config', 'target_columns'], msg: 'Value error, target_columns may not contain more than 10 entries', type: 'value_error' }], id: 'e1', status: { code: 2, message: 'Invalid input' } };
    upstream = { status: 422, data: e422, headers: { 'content-type': 'application/json' } };
    const res = makeRes(); await predict(makeReq('sap-rpt-1.6'), res);
    expect(res.statusCode).toBe(422); expect(res.body).toEqual(e422);
    const e400 = { detail: [{ loc: [], msg: 'Too many query rows provided. Maximum is 128.', type: 'value_error' }], id: 'e2', status: { code: 2, message: 'Invalid input' } };
    upstream = { status: 400, data: e400, headers: {} };
    const res2 = makeRes(); await predict(makeReq('sap-rpt-1.6'), res2);
    expect(res2.statusCode).toBe(400); expect(res2.body).toEqual(e400);
    expect(emitted).toHaveLength(0);
  });

  it('answers 404 in the SAP shape for a model the catalogue does not know, without marking it as a SAP relay', async () => {
    const res = makeRes(); await predict(makeReq('sap-rpt-9'), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ detail: [{ loc: [], msg: 'Model sap-rpt-9 is not available', type: 'model_not_found' }], status: { code: 2, message: 'Invalid input' } });
    expect(posted).toHaveLength(0);
    expect(res.locals.sapRelay).toBeUndefined();
  });

  it('answers 404 in the SAP shape for a model with neither a bare nor a --deployed twin carrying a deployment', async () => {
    const res = makeRes(); await predict(makeReq('sap-rpt-1-small'), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ detail: [{ loc: [], msg: 'Model sap-rpt-1-small is not available', type: 'model_not_found' }], status: { code: 2, message: 'Invalid input' } });
    expect(posted).toHaveLength(0);
  });

  it('refuses a model outside the entitlement catalog with 403 in the SAP shape, naming the refused id', async () => {
    const res = makeRes();
    await predict(makeReq('sap-rpt-1.6', BODY, { catalogId: 'c', catalogName: 'Analysts', mode: 'list', include: ['gpt-4.1-nano'] }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.detail[0]).toMatchObject({ type: 'model_not_entitled', msg: 'Model sap-rpt-1.6 is not in your entitlement catalog "Analysts"' });
    expect(posted).toHaveLength(0);
  });

  it('answers 502 in the SAP shape when the deployment cannot be reached', async () => {
    const axios = (await import('axios')).default as any;
    const original = axios.post;
    axios.post = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
    const res = makeRes(); await predict(makeReq('sap-rpt-1.6'), res);
    axios.post = original;
    expect(res.statusCode).toBe(502);
    expect(res.body.detail[0].type).toBe('upstream_unavailable');
  });
});
