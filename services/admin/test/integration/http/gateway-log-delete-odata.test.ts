/**
 * The action deleteStoredLogs over OData (cds.test, in-memory SQLite, mocked users; runs bare):
 * admin only, `log` empties the stored gateway log, `traces` the payload traces and raw traces,
 * `all` all three, each answers the count; any other value is refused with a translated 400 and
 * deletes nothing, one audit event per successful call.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'del-admin@test.com': { id: 'del-admin@test.com', roles: ['admin', 'user'] },
  'del-user@test.com': { id: 'del-user@test.com', roles: ['user'] } } };

const { POST } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'del-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'del-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const ACTION = '/odata/v4/admin/deleteStoredLogs';
const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
const RAW = 'sap.llm.gateway.admin.RawTraces';

const seed = Array.from({ length: 5 }, (_, i) => ({
  ID: `d-0-${i}`, loggedAt: `2026-11-11T10:00:0${i}.000Z`, seq: i + 1, level: 'INFO', component: 'chatController',
  requestId: null, message: `entry ${i}`
}));
const count = async (entity: string = ENTITY) => (await cds.db.run(cds.ql.SELECT.from(entity))).length;
const auditRows = async () => cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'logging.stored.delete' }));
const call = (what: unknown, opts: any = ADMIN) => ok(POST(ACTION, what === undefined ? {} : { what }, opts));

beforeEach(async () => {
  await cds.db.run(cds.ql.DELETE.from(ENTITY));
  await cds.db.run(cds.ql.DELETE.from(AUDIT));
  await cds.db.run(cds.ql.INSERT.into(ENTITY).entries(seed));
  await cds.db.run(cds.ql.DELETE.from(TRACES));
  await cds.db.run(cds.ql.DELETE.from(RAW));
  await cds.db.run(cds.ql.INSERT.into(TRACES).entries([
    { ID: 't-1', requestId: 'req-1', capturedAt: '2026-11-13T10:00:00.000Z', model: 'gpt-5', masked: true, prompt: 'Hello PERSON_1' },
    { ID: 't-2', requestId: 'req-2', capturedAt: '2026-11-13T10:00:01.000Z', model: 'gpt-5', masked: true, prompt: 'Bye PERSON_1' }]));
  await cds.db.run(cds.ql.INSERT.into(RAW).entries([
    { ID: 'r-1', requestId: 'req-1', sessionId: 's-1', capturedAt: '2026-11-13T10:00:00.000Z', stageIndex: '[]', stages: '{}' }]));
});

describe('deleteStoredLogs', () => {
  it('refuses a user with 403 and deletes nothing', async () => {
    expect((await call('log', USER)).status).toBe(403);
    expect(await count()).toBe(seed.length);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses an anonymous caller', async () => {
    const r = await call('log', {});
    expect([401, 403]).toContain(r.status);
    expect(await count()).toBe(seed.length);
    expect(await auditRows()).toHaveLength(0);
  });

  it('deletes every row for log and answers the count', async () => {
    const r = await call('log');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ deleted: seed.length, logEntries: seed.length, traces: 0 });
    expect(await count()).toBe(0);
  });

  it('counts a raw-only request (no payload trace) as one trace', async () => {
    await cds.db.run(cds.ql.INSERT.into(RAW).entries([
      { ID: 'r-3', requestId: 'req-3', sessionId: 's-1', capturedAt: '2026-11-13T10:00:02.000Z', stageIndex: '[]', stages: '{}' }]));
    const r = await call('traces');
    expect(r.data).toMatchObject({ deleted: 3, traces: 3 });
  });

  it('answers deleted 0 on an empty table and still audits', async () => {
    await cds.db.run(cds.ql.DELETE.from(ENTITY));
    const r = await call('log');
    expect(r.status).toBe(200);
    expect(r.data.deleted).toBe(0);
    expect(await auditRows()).toHaveLength(1);
  });

  it('leaves the payload traces for log', async () => {
    await call('log');
    expect([await count(), await count(TRACES), await count(RAW)]).toEqual([0, 2, 1]);
  });

  it('empties the payload traces and the raw traces for traces, counts each request once, leaves the log, and writes one audit event', async () => {
    const r = await call('traces');
    expect(r.status).toBe(200);
    // req-1 has a payload trace and raw stages: one trace, not two
    expect(r.data).toMatchObject({ deleted: 2, logEntries: 0, traces: 2 });
    expect([await count(), await count(TRACES), await count(RAW)]).toEqual([seed.length, 0, 0]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: 'del-admin@test.com', resourceType: 'PayloadTraces', outcome: 'success' });
    expect(JSON.parse(rows[0].details)).toEqual({ what: 'traces', deleted: 2, logEntries: 0, traces: 2 });
  });

  it('empties the log and both trace tables for all, and writes one audit event', async () => {
    const r = await call('all');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ deleted: seed.length + 2, logEntries: seed.length, traces: 2 });
    expect([await count(), await count(TRACES), await count(RAW)]).toEqual([0, 0, 0]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ what: 'all', deleted: seed.length + 2, logEntries: seed.length, traces: 2 });
  });

  it('refuses a user with 403 for traces and all, and deletes nothing', async () => {
    expect((await call('traces', USER)).status).toBe(403);
    expect((await call('all', USER)).status).toBe(403);
    expect([await count(), await count(TRACES), await count(RAW)]).toEqual([seed.length, 2, 1]);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([['an unknown word', 'everything'], ['upper case', 'LOG'], ['upper case traces', 'TRACES'], ['empty', ''], ['missing', undefined]])(
    'refuses %s with 400, deletes nothing and writes no audit event', async (_title, what) => {
      const r = await call(what);
      expect(r.status).toBe(400);
      if (what) expect(r.data.error.message).toContain(what as string);
      expect([await count(), await count(TRACES), await count(RAW)]).toEqual([seed.length, 2, 1]);
      expect(await auditRows()).toHaveLength(0);
    });

  it('writes exactly one audit event with the actor, the count and the value', async () => {
    await call('log');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: 'del-admin@test.com', action: 'logging.stored.delete', outcome: 'success' });
    expect(JSON.parse(rows[0].details)).toEqual({ what: 'log', deleted: seed.length, logEntries: seed.length, traces: 0 });
  });

  it('answers the refusal in the caller\'s language', async () => {
    const r = await call('nope', { ...ADMIN, headers: { 'Accept-Language': 'de' } });
    expect(r.status).toBe(400);
    expect(r.data.error.message).toMatch(/nope/);
    expect(r.data.error.message).toMatch(/Protokoll/);
  });
});
