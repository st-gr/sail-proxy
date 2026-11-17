/**
 * Payload traces over OData (cds.test, in-memory SQLite, mocked users; runs bare): the light traces and
 * the raw trace index are read-only and admin only, no sealed column is part of the model, the search
 * finds masked text and never sealed text, and the content that is not masked is reached only through
 * openPayloadTrace and openRawStage, which write the audit event. The admin holds its own
 * METADATA_ENCRYPTION_KEY; a trace sealed with another key is reported, not opened (Review Focus 3).
 */
import path from 'path';
import { randomBytes } from 'crypto';
import { sealText } from '@libs/trace-seal';

process.env.CDS_TYPESCRIPT = 'true';
process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'trace-admin@test.com': { id: 'trace-admin@test.com', roles: ['admin', 'user'] },
  'trace-user@test.com': { id: 'trace-user@test.com', roles: ['user'] } } };

const { GET, POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'trace-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'trace-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
const RAW = 'sap.llm.gateway.admin.RawTraces';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const ADMIN_ENV = { METADATA_ENCRYPTION_KEY: process.env.METADATA_ENCRYPTION_KEY };
const OTHER_ENV = { METADATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const CANARY = 'Quillfeather';

const ARRIVAL = JSON.stringify({ timestamp: '2026-11-13T10:00:00.000Z', payload: { messages: [{ role: 'user', content: `I am ${CANARY}` }] } });
const UPSTREAM = '{"timestamp":"2026-11-13T10:00:00.500Z","payload":"Hello Ja';
const sealedStages = (env: any) => sealText(JSON.stringify([
  { name: '00_arrival', content: ARRIVAL },
  { name: '03_sap_response_streaming', content: UPSTREAM },
  { name: 'zz_client_response', content: '{"payload":"done"}' }
]), env);
const stageIndex = JSON.stringify([
  { name: '00_arrival', bytes: ARRIVAL.length, cut: false },
  { name: '03_sap_response_streaming', bytes: UPSTREAM.length, cut: true },
  { name: 'zz_client_response', bytes: 18, cut: false }
]);
const trace = (over: any) => ({
  capturedAt: '2026-11-13T10:00:00.000Z', endpoint: '/v1/chat/completions', model: 'gpt-5', authType: 'api_key', credentialId: 'key-1',
  keyName: 'Jane build key', userEmail: 'jane.roe@example.org', statusCode: 200, durationMs: 120, masked: true, truncated: false, raw: false, ...over
});

beforeEach(async () => {
  await cds.db.run(cds.ql.DELETE.from(TRACES));
  await cds.db.run(cds.ql.DELETE.from(RAW));
  await cds.db.run(cds.ql.DELETE.from(AUDIT));
  await cds.db.run(cds.ql.INSERT.into(TRACES).entries([
    trace({ ID: 'm-1', requestId: 'req-m1', prompt: 'Please summarise the ledger for PERSON_1', answer: 'The ledger of PERSON_1 balances.' }),
    trace({ ID: 'u-1', requestId: 'req-u1', masked: false, omitted: 'not-captured', raw: true, sealedPrompt: sealText(`Draft a note about the ${CANARY} project`, ADMIN_ENV) }),
    trace({ ID: 'u-2', requestId: 'req-u2', masked: false, omitted: 'not-captured', keyName: 'Other key', userEmail: 'john.doe@example.org', sealedPrompt: sealText('sealed elsewhere', OTHER_ENV) })
  ]));
  await cds.db.run(cds.ql.INSERT.into(RAW).entries([
    { ID: 'r-1', requestId: 'req-u1', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', stageIndex, cutStages: true, stages: sealedStages(ADMIN_ENV) },
    { ID: 'r-2', requestId: 'req-u2', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', stageIndex, cutStages: true, stages: sealedStages(OTHER_ENV) }
  ]));
});

const audits = async (action?: string) => cds.db.run(action ? cds.ql.SELECT.from(AUDIT).where({ action }) : cds.ql.SELECT.from(AUDIT));
const openRawStage = (id: string, stage: string, opts: any = ADMIN) => ok(GET(`/odata/v4/admin/openRawStage(ID='${id}',stage='${stage}')`, opts));
const openPayloadTrace = (id: string, opts: any = ADMIN) => ok(GET(`/odata/v4/admin/openPayloadTrace(ID='${id}')`, opts));

describe('payload traces over OData', () => {
  it('refuses a user with 403 on every entity and function and writes no audit event', async () => {
    for (const url of ['/odata/v4/admin/PayloadTraces', '/odata/v4/admin/RawTraceIndex',
      "/odata/v4/admin/openPayloadTrace(ID='u-1')", "/odata/v4/admin/openRawStage(ID='r-1',stage='00_arrival')"]) {
      expect({ url, status: (await ok(GET(url, USER))).status }).toEqual({ url, status: 403 });
    }
    expect(await audits()).toHaveLength(0);
  });

  it('mounts both downloads, which refuse a caller without an identity (roles: payload-trace-download.test.ts)', async () => {
    // cds.test serves no app-level auth middleware, so a plain Express route sees no user here.
    expect((await ok(GET('/api/logs/traces/u-1/download', USER))).status).toBe(401);
    expect((await ok(GET('/api/logs/raw/r-1/download', USER))).status).toBe(401);
    expect(await audits()).toHaveLength(0);
  });

  it('says per trace whether a sealed prompt is stored (a facts-only raw trace has none), never giving the sealed text', async () => {
    await cds.db.run(cds.ql.INSERT.into(TRACES).entries([trace({ ID: 'f-1', requestId: 'req-f1', masked: false, omitted: 'not-captured', raw: true })]));
    const traces = await GET('/odata/v4/admin/PayloadTraces?$select=ID,promptSealed&$orderby=ID', ADMIN);
    expect(traces.data.value.map((x: any) => [x.ID, x.promptSealed])).toEqual([['f-1', false], ['m-1', false], ['u-1', true], ['u-2', true]]);
    expect(JSON.stringify(traces.data)).not.toContain(CANARY);
  });

  it('gives an admin the traces and the raw index without any sealed column, also not in $metadata', async () => {
    const traces = await GET('/odata/v4/admin/PayloadTraces?$orderby=ID', ADMIN);
    expect(traces.data.value.map((x: any) => x.ID)).toEqual(['m-1', 'u-1', 'u-2']);
    expect(traces.data.value[0]).toMatchObject({ prompt: 'Please summarise the ledger for PERSON_1', keyName: 'Jane build key', userEmail: 'jane.roe@example.org' });
    expect(traces.data.value.every((x: any) => !('sealedPrompt' in x))).toBe(true);
    const index = await GET('/odata/v4/admin/RawTraceIndex', ADMIN);
    expect(index.data.value).toHaveLength(2);
    expect(index.data.value.every((x: any) => !('stages' in x))).toBe(true);
    expect(JSON.parse(index.data.value[0].stageIndex)[1]).toEqual({ name: '03_sap_response_streaming', bytes: UPSTREAM.length, cut: true });
    expect(JSON.stringify([traces.data, index.data])).not.toContain(CANARY);
    const metadata = await GET('/odata/v4/admin/$metadata', ADMIN);
    expect(metadata.data).toContain('EntityType Name="PayloadTraces"');
    expect(metadata.data).toContain('EntityType Name="RawTraceIndex"');
    expect(metadata.data).not.toContain('sealedPrompt');
    expect(metadata.data).not.toMatch(/Property Name="stages"/);
  });

  it('is read-only, also for an admin', async () => {
    expect((await ok(POST('/odata/v4/admin/PayloadTraces', { ID: 'x', requestId: 'x' }, ADMIN))).status).toBeGreaterThanOrEqual(400);
    expect((await ok(POST('/odata/v4/admin/RawTraceIndex', { ID: 'x', requestId: 'x' }, ADMIN))).status).toBeGreaterThanOrEqual(400);
  });

  describe('$search', () => {
    const search = async (term: string) => (await GET(`/odata/v4/admin/PayloadTraces?$search=${encodeURIComponent(term)}&$orderby=ID`, ADMIN)).data.value.map((x: any) => x.ID);
    it('finds a masked row by a word of its masked prompt or answer, case-insensitively', async () => {
      expect(await search('LEDGER')).toEqual(['m-1']);
      expect(await search('balances')).toEqual(['m-1']);
    });
    it('finds no row by a word of a sealed prompt', async () => {
      expect(await search(CANARY)).toEqual([]);
    });
    it('finds the whole phrase in the facts: request id, key name and user', async () => {
      expect(await search('req-u2')).toEqual(['u-2']);
      expect(await search('other key')).toEqual(['u-2']);
      expect(await search('jane.roe@example.org')).toEqual(['m-1', 'u-1']);
    });
  });

  describe('openRawStage', () => {
    it('returns the stage and writes one raw.trace.open event with actor, request id and stage name, none of the content', async () => {
      const r = await openRawStage('r-1', '00_arrival');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.data).toMatchObject({ stage: '00_arrival', content: ARRIVAL, cut: false });
      expect(r.data.problem ?? null).toBeNull();
      const rows = await audits('raw.trace.open');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: 'trace-admin@test.com', resourceType: 'RawTrace', resourceId: 'r-1', outcome: 'success', severity: 'high' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u1', stage: '00_arrival' });
      expect(JSON.stringify(await audits())).not.toContain(CANARY);
    });

    it('opens the second stage of a name recorded twice by its name#2', async () => {
      const first = '{"payload":"first answer"}';
      const second = '{"payload":"second ans';
      await cds.db.run(cds.ql.INSERT.into(RAW).entries([{
        ID: 'r-3', requestId: 'req-u3', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', cutStages: true,
        stageIndex: JSON.stringify([{ name: '03_sap_response_raw', bytes: first.length, cut: false }, { name: '03_sap_response_raw#2', bytes: second.length, cut: true }]),
        stages: sealText(JSON.stringify([{ name: '03_sap_response_raw', content: first }, { name: '03_sap_response_raw#2', content: second }]), ADMIN_ENV)
      }]));
      expect((await openRawStage('r-3', encodeURIComponent('03_sap_response_raw#2'))).data).toMatchObject({ stage: '03_sap_response_raw#2', content: second, cut: true });
      expect((await openRawStage('r-3', '03_sap_response_raw')).data).toMatchObject({ stage: '03_sap_response_raw', content: first, cut: false });
      expect((await audits('raw.trace.open')).map((r: any) => JSON.parse(r.details).stage).sort()).toEqual(['03_sap_response_raw', '03_sap_response_raw#2']);
    });

    it('says when a stage was cut', async () => {
      const r = await openRawStage('r-1', '03_sap_response_streaming');
      expect(r.data).toMatchObject({ stage: '03_sap_response_streaming', content: UPSTREAM, cut: true });
    });

    it('Review Focus 3: a trace sealed with another key gives keys-differ and a failure event, and the service keeps answering', async () => {
      const r = await openRawStage('r-2', '00_arrival');
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ stage: '00_arrival', problem: 'keys-differ' });
      expect(r.data.content ?? null).toBeNull();
      const rows = await audits('raw.trace.open');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'failure', severity: 'high', resourceId: 'r-2' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u2', stage: '00_arrival', problem: 'keys-differ' });
      expect((await openRawStage('r-1', '00_arrival')).data.content).toBe(ARRIVAL);
    });

    it('answers 404 for an unknown ID or stage and writes no event', async () => {
      expect((await openRawStage('nope', '00_arrival')).status).toBe(404);
      expect((await openRawStage('r-1', '99_nothing')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });
  });

  describe('openPayloadTrace', () => {
    it('returns a masked trace\'s text without an audit event', async () => {
      const r = await openPayloadTrace('m-1');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.data).toMatchObject({ masked: true, prompt: 'Please summarise the ledger for PERSON_1', answer: 'The ledger of PERSON_1 balances.' });
      expect(await audits()).toHaveLength(0);
    });

    it('opens the sealed prompt of a trace that is not masked and writes payload.trace.open without the content', async () => {
      const r = await openPayloadTrace('u-1');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.data).toMatchObject({ masked: false, prompt: `Draft a note about the ${CANARY} project` });
      expect(r.data.answer ?? null).toBeNull();
      const rows = await audits('payload.trace.open');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: 'trace-admin@test.com', resourceType: 'PayloadTrace', resourceId: 'u-1', outcome: 'success', severity: 'high' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u1' });
      expect(JSON.stringify(await audits())).not.toContain(CANARY);
    });

    it('returns a facts-only trace (not masked, nothing sealed) without an audit event: nothing unmasked is handed out', async () => {
      await cds.db.run(cds.ql.INSERT.into(TRACES).entries([trace({ ID: 'f-1', requestId: 'req-f1', masked: false, omitted: 'not-captured', raw: true })]));
      const r = await openPayloadTrace('f-1');
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ masked: false });
      expect(r.data.prompt ?? null).toBeNull();
      expect(r.data.problem ?? null).toBeNull();
      expect(await audits()).toHaveLength(0);
    });

    it('reports keys-differ for a prompt sealed with another key, with a failure event', async () => {
      const r = await openPayloadTrace('u-2');
      expect(r.data).toMatchObject({ masked: false, problem: 'keys-differ' });
      expect(r.data.prompt ?? null).toBeNull();
      const rows = await audits('payload.trace.open');
      expect(rows.map((x: any) => x.outcome)).toEqual(['failure']);
    });

    it('answers 404 for an unknown ID', async () => {
      expect((await openPayloadTrace('nope')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });
  });
});
