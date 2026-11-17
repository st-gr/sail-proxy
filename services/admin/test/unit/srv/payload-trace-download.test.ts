/**
 * GET /api/logs/traces/:id/download and GET /api/logs/raw/:id/download: one trace as a JSON file,
 * admin only. A masked trace is downloaded without an audit event; a trace that is not masked and a
 * raw trace are opened with the admin's key and write payload.trace.download / raw.trace.download.
 * A trace sealed with another key is refused with 409 and a failure event. In-memory SQLite.
 */
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { sealText } from '@libs/trace-seal';
import { connectTraceTestDb } from '../services/trace-test-db';

const cds = require('@sap/cds');
const { createTraceDownloadRouter } = require('../../../src/srv/admin-service-traces');

const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
const RAW = 'sap.llm.gateway.admin.RawTraces';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const ADMIN = { id: 'jane.roe@example.org', roles: ['admin', 'user'] };
const USER = { id: 'user@example.org', roles: ['user'] };
const ADMIN_KEY = randomBytes(32).toString('hex');
const OTHER_ENV = { METADATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const CANARY = 'Quillfeather';

const appAs = (user: any): express.Application => {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/logs', createTraceDownloadRouter());
  return app;
};
const get = (url: string, user: any = ADMIN) => request(appAs(user)).get(url);
const audits = async (action?: string) => cds.db.run(action ? cds.ql.SELECT.from(AUDIT).where({ action }) : cds.ql.SELECT.from(AUDIT));
const trace = (over: any) => ({
  capturedAt: '2026-11-13T10:00:00.000Z', endpoint: '/v1/chat/completions', model: 'gpt-5', authType: 'api_key', credentialId: 'key-1',
  keyName: 'Jane build key', userEmail: 'jane.roe@example.org', statusCode: 200, durationMs: 120, masked: true, truncated: false, raw: false, ...over
});
const ARRIVAL = { timestamp: '2026-11-13T10:00:00.000Z', payload: { messages: [{ role: 'user', content: `I am ${CANARY}` }] } };
const UPSTREAM_CUT = '{"timestamp":"2026-11-13T10:00:00.500Z","payload":"Hel';
const stages = (env: any) => sealText(JSON.stringify([
  { name: '00_arrival', content: JSON.stringify(ARRIVAL) },
  { name: '03_sap_response_streaming', content: UPSTREAM_CUT },
  { name: 'zz_client_response', content: '{"payload":"done","complete":true}' }
]), env);
const stageIndex = [
  { name: '00_arrival', bytes: 100, cut: false }, { name: '03_sap_response_streaming', bytes: 52, cut: true }, { name: 'zz_client_response', bytes: 34, cut: false }
];

describe('trace downloads', () => {
  beforeAll(async () => {
    process.env.VALIDATION_TOKEN_SECRET = randomBytes(32).toString('hex');
    process.env.METADATA_ENCRYPTION_KEY = ADMIN_KEY;
    await connectTraceTestDb();
  });
  beforeEach(async () => {
    process.env.METADATA_ENCRYPTION_KEY = ADMIN_KEY;
    for (const entity of [TRACES, RAW, AUDIT]) await cds.db.run(cds.ql.DELETE.from(entity));
    const adminEnv = { METADATA_ENCRYPTION_KEY: ADMIN_KEY };
    await cds.db.run(cds.ql.INSERT.into(TRACES).entries([
      trace({ ID: 'm-1', requestId: 'req-m1', prompt: 'Summarise the ledger for PERSON_1', answer: 'It balances, PERSON_1.' }),
      trace({ ID: 'u-1', requestId: 'req-u1', masked: false, omitted: 'not-captured', sealedPrompt: sealText(`Ask ${CANARY} about it`, adminEnv) }),
      trace({ ID: 'u-2', requestId: 'req-u2', masked: false, omitted: 'not-captured', sealedPrompt: sealText('sealed elsewhere', OTHER_ENV) }),
      trace({ ID: 'q-1', requestId: 'req "x"/y\r\n', prompt: 'p', answer: 'a' }),
      // the facts-only trace of a raw capture recorded while payload capture was off: not masked, nothing sealed
      trace({ ID: 'f-1', requestId: 'req-f1', masked: false, omitted: 'not-captured', raw: true })
    ]));
    await cds.db.run(cds.ql.INSERT.into(RAW).entries([
      { ID: 'r-1', requestId: 'req-u1', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', stageIndex: JSON.stringify(stageIndex), cutStages: true, stages: stages(adminEnv) },
      { ID: 'r-2', requestId: 'req-u2', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', stageIndex: JSON.stringify(stageIndex), cutStages: true, stages: stages(OTHER_ENV) }
    ]));
  });

  describe('who may call them', () => {
    it.each([['/api/logs/traces/u-1/download'], ['/api/logs/raw/r-1/download']])('%s: 403 for a user, 401 without a user, no audit event', async (url) => {
      expect((await get(url, USER)).status).toBe(403);
      expect((await get(url, null)).status).toBe(401);
      expect(await audits()).toHaveLength(0);
    });
  });

  describe('GET /api/logs/traces/:id/download', () => {
    it('downloads a masked trace as a JSON file named by its request id, without an audit event', async () => {
      const res = await get('/api/logs/traces/m-1/download');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="payload-trace-req-m1.json"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ ID: 'm-1', requestId: 'req-m1', model: 'gpt-5', keyName: 'Jane build key', masked: true,
        prompt: 'Summarise the ledger for PERSON_1', answer: 'It balances, PERSON_1.' });
      expect(res.body).not.toHaveProperty('sealedPrompt');
      expect(await audits()).toHaveLength(0);
    });

    it('opens the prompt of a trace that is not masked and writes payload.trace.download without the content', async () => {
      const res = await get('/api/logs/traces/u-1/download');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ requestId: 'req-u1', masked: false, prompt: `Ask ${CANARY} about it` });
      expect(res.body).not.toHaveProperty('sealedPrompt');
      const rows = await audits('payload.trace.download');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: 'jane.roe@example.org', resourceType: 'PayloadTrace', resourceId: 'u-1', outcome: 'success', severity: 'high' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u1' });
      expect(JSON.stringify(await audits())).not.toContain(CANARY);
    });

    it('downloads a facts-only trace (not masked, nothing sealed) without an audit event: nothing unmasked is handed out', async () => {
      const res = await get('/api/logs/traces/f-1/download');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ID: 'f-1', requestId: 'req-f1', masked: false, raw: true, omitted: 'not-captured', prompt: null, answer: null });
      expect(await audits()).toHaveLength(0);
    });

    it('refuses a prompt sealed with another key with 409 keys-differ and a failure event', async () => {
      const res = await get('/api/logs/traces/u-2/download');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('keys-differ');
      expect((await audits('payload.trace.download')).map((r: any) => r.outcome)).toEqual(['failure']);
    });

    it('answers 404 for an unknown id', async () => {
      expect((await get('/api/logs/traces/nope/download')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });

    it('keeps the file name to safe characters', async () => {
      const res = await get('/api/logs/traces/q-1/download');
      expect(res.headers['content-disposition']).toBe('attachment; filename="payload-trace-req__x__y__.json"');
    });
  });

  describe('GET /api/logs/raw/:id/download', () => {
    it('downloads the facts and every stage opened, and writes raw.trace.download without the content', async () => {
      const res = await get('/api/logs/raw/r-1/download');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="raw-trace-req-u1.json"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ ID: 'r-1', requestId: 'req-u1', sessionId: 's-1', cutStages: true, stageIndex });
      expect(res.body.stages).toEqual([
        { name: '00_arrival', cut: false, content: ARRIVAL },
        { name: '03_sap_response_streaming', cut: true, content: UPSTREAM_CUT },
        { name: 'zz_client_response', cut: false, content: { payload: 'done', complete: true } }
      ]);
      const rows = await audits('raw.trace.download');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: 'jane.roe@example.org', resourceType: 'RawTrace', resourceId: 'r-1', outcome: 'success', severity: 'high' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u1' });
      expect(JSON.stringify(await audits())).not.toContain(CANARY);
    });

    it('gives each stage the cut mark of its own index entry, by position, also when two stages share a name', async () => {
      const adminEnv = { METADATA_ENCRYPTION_KEY: ADMIN_KEY };
      const pairs = [
        { name: '03_sap_response_raw', content: '{"payload":"first"}', cut: false },
        { name: '03_sap_response_raw#2', content: '{"payload":"second"}', cut: false },
        { name: '03_sap_response_raw#2', content: '{"payload":"thi', cut: true } // a name repeated as an earlier gateway sent it
      ];
      await cds.db.run(cds.ql.INSERT.into(RAW).entries([{
        ID: 'r-3', requestId: 'req-u3', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', cutStages: true,
        stageIndex: JSON.stringify(pairs.map((p) => ({ name: p.name, bytes: p.content.length, cut: p.cut }))),
        stages: sealText(JSON.stringify(pairs.map((p) => ({ name: p.name, content: p.content }))), adminEnv)
      }]));
      const res = await get('/api/logs/raw/r-3/download');
      expect(res.body.stages).toEqual([
        { name: '03_sap_response_raw', cut: false, content: { payload: 'first' } },
        { name: '03_sap_response_raw#2', cut: false, content: { payload: 'second' } },
        { name: '03_sap_response_raw#2', cut: true, content: '{"payload":"thi' }
      ]);
    });

    it('refuses stages sealed with another key with 409 keys-differ and a failure event', async () => {
      const res = await get('/api/logs/raw/r-2/download');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('keys-differ');
      expect(res.body).not.toHaveProperty('stages');
      expect((await audits('raw.trace.download')).map((r: any) => r.outcome)).toEqual(['failure']);
    });

    it('answers 404 for an unknown id', async () => {
      expect((await get('/api/logs/raw/nope/download')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });
  });

  describe('GET /api/logs/raw/:id/download?stage=<name>', () => {
    it('downloads that one stage as its own JSON file and writes raw.trace.download with the stage name', async () => {
      const res = await get('/api/logs/raw/r-1/download?stage=00_arrival');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="raw-trace-req-u1-00_arrival.json"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(ARRIVAL);
      const rows = await audits('raw.trace.download');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: 'jane.roe@example.org', resourceType: 'RawTrace', resourceId: 'r-1', outcome: 'success', severity: 'high' });
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u1', stage: '00_arrival' });
      expect(JSON.stringify(await audits())).not.toContain(CANARY);
    });

    it('downloads a cut stage that is no longer JSON as text', async () => {
      const res = await get('/api/logs/raw/r-1/download?stage=03_sap_response_streaming');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="raw-trace-req-u1-03_sap_response_streaming.txt"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toBe(UPSTREAM_CUT);
      expect(JSON.parse((await audits('raw.trace.download'))[0].details)).toEqual({ requestId: 'req-u1', stage: '03_sap_response_streaming' });
    });

    it('finds a stage recorded twice by its name#2 and keeps the file name to safe characters', async () => {
      const adminEnv = { METADATA_ENCRYPTION_KEY: ADMIN_KEY };
      const pairs = [{ name: '03_sap_response_raw', content: '{"payload":"first"}' }, { name: '03_sap_response_raw#2', content: '{"payload":"second"}' }];
      await cds.db.run(cds.ql.INSERT.into(RAW).entries([{
        ID: 'r-3', requestId: 'req-u3', sessionId: 's-1', credentialId: 'key-1', capturedAt: '2026-11-13T10:00:00.000Z', cutStages: false,
        stageIndex: JSON.stringify(pairs.map((p) => ({ name: p.name, bytes: p.content.length, cut: false }))),
        stages: sealText(JSON.stringify(pairs), adminEnv)
      }]));
      const res = await get(`/api/logs/raw/r-3/download?stage=${encodeURIComponent('03_sap_response_raw#2')}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="raw-trace-req-u3-03_sap_response_raw_2.json"');
      expect(res.body).toEqual({ payload: 'second' });
    });

    it('answers 404 for a stage the trace does not have, without an audit event', async () => {
      const res = await get('/api/logs/raw/r-1/download?stage=99_nothing');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
      expect((await get('/api/logs/raw/nope/download?stage=00_arrival')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });

    it('answers 400 for a stage given twice or empty, without an audit event', async () => {
      expect((await get('/api/logs/raw/r-1/download?stage=00_arrival&stage=zz_client_response')).status).toBe(400);
      expect((await get('/api/logs/raw/r-1/download?stage[a]=00_arrival')).status).toBe(400);
      expect((await get('/api/logs/raw/r-1/download?stage=')).status).toBe(400);
      expect(await audits()).toHaveLength(0);
    });

    it('refuses a stage sealed with another key with 409 keys-differ and a failure event naming the stage', async () => {
      const res = await get('/api/logs/raw/r-2/download?stage=00_arrival');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('keys-differ');
      const rows = await audits('raw.trace.download');
      expect(rows.map((r: any) => r.outcome)).toEqual(['failure']);
      expect(JSON.parse(rows[0].details)).toEqual({ requestId: 'req-u2', stage: '00_arrival', problem: 'keys-differ' });
    });

    it('is admin only', async () => {
      expect((await get('/api/logs/raw/r-1/download?stage=00_arrival', USER)).status).toBe(403);
      expect((await get('/api/logs/raw/r-1/download?stage=00_arrival', null)).status).toBe(401);
      expect(await audits()).toHaveLength(0);
    });
  });
});
