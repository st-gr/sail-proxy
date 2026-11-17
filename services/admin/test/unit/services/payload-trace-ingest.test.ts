/**
 * The admin service's half of payload traces: the light traces of the `payload-traces` stream and the
 * sealed raw stages of the `raw-traces` stream become rows. A stream entry delivered twice is one row,
 * a raw trace marks the light row of its request whichever arrives first, a malformed entry is
 * acknowledged and counted, and nothing sealed is ever stored in the clear (Review Focus 2).
 * In-memory SQLite; TRACE_TEST_POSTGRES runs it against a throwaway PostgreSQL (trace-test-db.ts).
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sealText } from '@libs/trace-seal';
import { connectTraceTestDb, ownsTraceTestDb } from './trace-test-db';
import {
  storeTraces, storeRawTraces, handleTraceStreamEntries, startPayloadTraceIngest, payloadCaptureSettings,
  traceIngestStats, resetTraceIngestStats
} from '../../../src/services/payloadTraceIngest';
import { ensureGatewayLogIndexes } from '../../../src/db/data/gateway-log-indexes';

const cds = require('@sap/cds');

const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
const RAW = 'sap.llm.gateway.admin.RawTraces';
const ENV = { METADATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const CANARY = 'Quillfeather';
const API_KEY_ID = uuidv4();
const AWS_ID = uuidv4();
const ACCESS_KEY_ID = 'TESTACCESSKEY0001';

const light = (over: any = {}) => ({
  v: 1, requestId: 'req-1', capturedAt: '2026-11-13T10:00:00.000Z', endpoint: '/v1/chat/completions', model: 'gpt-5',
  authType: 'api_key', credentialId: API_KEY_ID, statusCode: 200, durationMs: 120, inputTokens: 10, outputTokens: 5,
  masked: true, truncated: false, prompt: 'Hello PERSON_1, how are you?', answer: 'Fine, PERSON_1.', raw: false, ...over
});
const stagesOf = (text: string) => sealText(JSON.stringify([
  { name: '00_arrival', content: JSON.stringify({ timestamp: '2026-11-13T10:00:00.000Z', payload: { messages: [{ role: 'user', content: text }] } }) },
  { name: 'zz_client_response', content: JSON.stringify({ timestamp: '2026-11-13T10:00:01.000Z', payload: 'ok', complete: true, bytesSent: 2 }) }
]), ENV);
const raw = (over: any = {}) => ({
  v: 1, requestId: 'req-1', sessionId: 'session-1', capturedAt: '2026-11-13T10:00:00.000Z', credentialId: API_KEY_ID,
  stageIndex: [{ name: '00_arrival', bytes: 120, cut: false }, { name: 'zz_client_response', bytes: 80, cut: false }],
  sealedStages: stagesOf('Hello Jane Roe'), cutStages: false, ...over
});
const rowsOf = async (entity: string) => cds.db.run(cds.ql.SELECT.from(entity).orderBy('ID'));
const fakeClient = (over: any = {}) => ({
  xgroup: jest.fn(async () => 'OK'),
  xreadgroup: jest.fn(async () => null),
  xautoclaim: jest.fn(async () => ['0-0', [], []]),
  xack: jest.fn(async () => 1),
  xdel: jest.fn(async () => 1),
  disconnect: jest.fn(),
  ...over
});

describe('payloadCaptureSettings', () => {
  const defaults = { enabled: false, retentionHours: 48, raw: { maxDurationMinutes: 240, retentionHours: 24 } };
  it('gives the D7 defaults for no configuration, no block or a block that is not an object', () => {
    expect(payloadCaptureSettings(undefined)).toEqual(defaults);
    expect(payloadCaptureSettings({ api_config: { observability: {} } })).toEqual(defaults);
    expect(payloadCaptureSettings({ api_config: { observability: { payload_capture: 'on' } } })).toEqual(defaults);
  });
  it('reads observability.payload_capture and keeps 0 as 0', () => {
    const config = { api_config: { observability: { payload_capture: { enabled: true, retention_hours: 0, raw: { max_duration_minutes: 15, retention_hours: 0 } } } } };
    expect(payloadCaptureSettings(config)).toEqual({ enabled: true, retentionHours: 0, raw: { maxDurationMinutes: 15, retentionHours: 0 } });
  });
  it('gives the default for a max_duration_minutes that is 0, negative or not a whole number, as the gateway does', () => {
    for (const bad of [0, -5, 1.5, Infinity]) {
      const config = { api_config: { observability: { payload_capture: { raw: { max_duration_minutes: bad } } } } };
      expect(payloadCaptureSettings(config).raw.maxDurationMinutes).toBe(240);
    }
    expect(payloadCaptureSettings({ api_config: { observability: { payload_capture: { raw: { max_duration_minutes: 1 } } } } }).raw.maxDurationMinutes).toBe(1);
  });
  it('gives the default for a value of the wrong type or range', () => {
    const config = { api_config: { observability: { payload_capture: { enabled: 'yes', retention_hours: -1, raw: { max_duration_minutes: '5', retention_hours: null } } } } };
    expect(payloadCaptureSettings(config)).toEqual(defaults);
  });
});

describe('payload trace ingest', () => {
  beforeAll(async () => {
    await connectTraceTestDb();
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeys').entries([
      { ID: API_KEY_ID, key: `test-${randomBytes(6).toString('base64url')}`, name: 'Jane build key', email: 'jane.roe@example.org' }]));
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentials').entries([
      { ID: AWS_ID, accessKeyId: ACCESS_KEY_ID, name: 'Jane AWS', email: 'jane.roe@example.org' }]));
  });
  // The next suite's guard refuses a database that holds API keys (trace-test-db.ts); only one this suite set up is cleaned.
  afterAll(async () => { if (ownsTraceTestDb()) await cds.db.run(cds.ql.DELETE.from('sap.llm.gateway.admin.ApiKeys')); });
  beforeEach(async () => {
    await cds.db.run(cds.ql.DELETE.from(TRACES));
    await cds.db.run(cds.ql.DELETE.from(RAW));
    resetTraceIngestStats();
  });

  it('creates the trace indexes on capturedAt and the request id with the log indexes, idempotently', async () => {
    expect(await ensureGatewayLogIndexes(cds.db)).toEqual({ ensured: 6, failed: [] });
    expect(await ensureGatewayLogIndexes(cds.db)).toEqual({ ensured: 6, failed: [] });
  });

  describe('storeTraces', () => {
    it('stores a light message as a row with its facts, the key name and the user', async () => {
      expect(await storeTraces([{ id: '1-0', message: light() }])).toBe(1);
      const [r] = await rowsOf(TRACES);
      expect(r).toMatchObject({
        ID: '1-0', requestId: 'req-1', endpoint: '/v1/chat/completions', model: 'gpt-5', authType: 'api_key', credentialId: API_KEY_ID,
        keyName: 'Jane build key', userEmail: 'jane.roe@example.org', statusCode: 200, durationMs: 120, inputTokens: 10, outputTokens: 5,
        prompt: 'Hello PERSON_1, how are you?', answer: 'Fine, PERSON_1.', sealedPrompt: null
      });
      expect(Boolean(r.masked)).toBe(true);
      expect(Boolean(r.truncated)).toBe(false);
      expect(Boolean(r.raw)).toBe(false);
      expect(new Date(r.capturedAt).toISOString()).toBe('2026-11-13T10:00:00.000Z');
    });

    it('resolves an AWS credential by its ID and by its access key id, and leaves an unknown credential without a name', async () => {
      await storeTraces([
        { id: '1-0', message: light({ requestId: 'a', authType: 'aws_credential', credentialId: AWS_ID }) },
        { id: '2-0', message: light({ requestId: 'b', authType: 'aws_credential', credentialId: ACCESS_KEY_ID }) },
        { id: '3-0', message: light({ requestId: 'c', credentialId: 'no-such-credential' }) },
        { id: '4-0', message: light({ requestId: 'd', credentialId: undefined }) }
      ]);
      const r = await rowsOf(TRACES);
      expect(r.map((x: any) => [x.keyName, x.userEmail])).toEqual([
        ['Jane AWS', 'jane.roe@example.org'], ['Jane AWS', 'jane.roe@example.org'], [null, null], [null, null]]);
    });

    it('stores a stream entry delivered twice once', async () => {
      await storeTraces([{ id: '1-0', message: light() }]);
      await storeTraces([{ id: '1-0', message: light() }]);
      expect(await rowsOf(TRACES)).toHaveLength(1);
    });

    it('keeps the sealed prompt of a request that was not masked, and never a clear prompt or answer for it', async () => {
      const sealedPrompt = sealText(`Tell ${CANARY} the plan`, ENV);
      await storeTraces([{ id: '1-0', message: light({ masked: false, prompt: `Tell ${CANARY}`, answer: `${CANARY} answers`, sealedPrompt, omitted: 'not-captured' }) }]);
      const [r] = await rowsOf(TRACES);
      expect(r).toMatchObject({ sealedPrompt, prompt: null, answer: null, omitted: 'not-captured' });
      expect(JSON.stringify(r)).not.toContain(CANARY);
    });

    it('stores the facts-only trace of a raw capture recorded while payload capture was off, with no content', async () => {
      const factsOnly = (over: any) => {
        const m: any = light({ raw: true, omitted: 'not-captured', ...over });
        delete m.prompt; delete m.answer; delete m.sealedPrompt;
        return m;
      };
      await storeTraces([{ id: '1-0', message: factsOnly({ requestId: 'f-1', masked: false }) }, { id: '2-0', message: factsOnly({ requestId: 'f-2', masked: true }) }]);
      const rows = await rowsOf(TRACES);
      expect(rows.map((r: any) => [r.requestId, r.prompt, r.answer, r.sealedPrompt, r.omitted, Boolean(r.raw)])).toEqual([
        ['f-1', null, null, null, 'not-captured', true], ['f-2', null, null, null, 'not-captured', true]]);
    });

    it('ignores a sealed prompt on a masked trace', async () => {
      await storeTraces([{ id: '1-0', message: light({ sealedPrompt: sealText('x', ENV) }) }]);
      expect((await rowsOf(TRACES))[0].sealedPrompt).toBeNull();
    });

    it('skips and counts a message that is not a light trace, and stores the rest', async () => {
      const n = await storeTraces([
        { id: '1-0', message: light({ v: 2 }) }, { id: '2-0', message: light({ requestId: '' }) },
        { id: '3-0', message: light({ capturedAt: 'yesterday' }) }, { id: '4-0', message: 'text' }, { id: '5-0', message: light() }
      ]);
      expect(n).toBe(1);
      expect((await rowsOf(TRACES)).map((x: any) => x.ID)).toEqual(['5-0']);
      expect(traceIngestStats().malformed).toBe(4);
    });

    it('cuts values longer than their columns, strips NUL and replaces a lone surrogate', async () => {
      await storeTraces([{ id: '1-0', message: light({ requestId: 'r'.repeat(200), model: 'm'.repeat(500), prompt: 'a\u0000b\uD83Dc' }) }]);
      const [r] = await rowsOf(TRACES);
      expect(r.requestId).toHaveLength(60);
      expect(r.model).toHaveLength(200);
      expect(r.prompt).toBe('ab�c');
    });
  });

  describe('storeRawTraces', () => {
    it('stores a raw message as a row with its index in the clear and its stages sealed', async () => {
      const message = raw({ cutStages: true });
      expect(await storeRawTraces([{ id: '7-0', message }])).toBe(1);
      const [r] = await rowsOf(RAW);
      expect(r).toMatchObject({ ID: '7-0', requestId: 'req-1', sessionId: 'session-1', credentialId: API_KEY_ID, stages: message.sealedStages });
      expect(Boolean(r.cutStages)).toBe(true);
      expect(JSON.parse(r.stageIndex)).toEqual(message.stageIndex);
      expect(new Date(r.capturedAt).toISOString()).toBe('2026-11-13T10:00:00.000Z');
    });

    it('marks the light row of the same request raw, whichever arrives first', async () => {
      await storeTraces([{ id: '1-0', message: light({ requestId: 'light-first' }) }]);
      await storeRawTraces([{ id: '1-0', message: raw({ requestId: 'light-first' }) }]);
      await storeRawTraces([{ id: '2-0', message: raw({ requestId: 'raw-first' }) }]);
      await storeTraces([{ id: '2-0', message: light({ requestId: 'raw-first' }) }, { id: '3-0', message: light({ requestId: 'no-raw' }) }]);
      const r = await rowsOf(TRACES);
      expect(r.map((x: any) => [x.requestId, Boolean(x.raw)])).toEqual([['light-first', true], ['raw-first', true], ['no-raw', false]]);
    });

    it('stores a stream entry delivered twice once', async () => {
      await storeRawTraces([{ id: '7-0', message: raw() }]);
      await storeRawTraces([{ id: '7-0', message: raw() }]);
      expect(await rowsOf(RAW)).toHaveLength(1);
    });

    it('skips and counts a message that is not a raw trace', async () => {
      const n = await storeRawTraces([
        { id: '1-0', message: raw({ sealedStages: 42 }) }, { id: '2-0', message: raw({ stageIndex: 'none' }) },
        { id: '3-0', message: raw({ sessionId: undefined }) }, { id: '4-0', message: null }, { id: '5-0', message: raw() }
      ]);
      expect(n).toBe(1);
      expect(traceIngestStats().malformed).toBe(4);
    });
  });

  describe('a sealed value that is not a seal envelope', () => {
    const validEnvelope = () => JSON.parse(sealText('x', ENV));
    const notEnvelopes = () => [
      `Tell ${CANARY} the plan`,
      JSON.stringify({ text: CANARY }),
      JSON.stringify({ ...validEnvelope(), ct: `${CANARY} in the clear` }),
      JSON.stringify({ ...validEnvelope(), ct: Buffer.from(CANARY).toString('base64'), extra: CANARY }),
      JSON.stringify({ ...validEnvelope(), iv: 1 }),
      JSON.stringify({ ...validEnvelope(), v: 2 }),
      JSON.stringify({ ...validEnvelope(), tag: 'AA==' })
    ];

    it('a light trace with such a sealed prompt is acknowledged and counted, not stored', async () => {
      const values = notEnvelopes();
      const client = fakeClient();
      await handleTraceStreamEntries(client as any, 'light', values.map((sealedPrompt, i) =>
        [`${i + 1}-0`, ['trace', JSON.stringify(light({ requestId: `bad-${i}`, masked: false, prompt: undefined, answer: undefined, sealedPrompt }))]]));
      expect(await rowsOf(TRACES)).toHaveLength(0);
      expect(traceIngestStats().malformed).toBe(values.length);
      expect(client.xack).toHaveBeenCalledTimes(values.length);
    });

    it('a raw trace with such sealed stages is acknowledged and counted, not stored', async () => {
      const values = [...notEnvelopes(), JSON.stringify([{ name: '00_arrival', content: CANARY }])];
      const client = fakeClient();
      await handleTraceStreamEntries(client as any, 'raw', values.map((sealedStages, i) =>
        [`${i + 1}-0`, ['raw', JSON.stringify(raw({ requestId: `bad-${i}`, sealedStages }))]]));
      expect(await rowsOf(RAW)).toHaveLength(0);
      expect(traceIngestStats().malformed).toBe(values.length);
      expect(client.xack).toHaveBeenCalledTimes(values.length);
    });

    it('stores the envelopes beside them and keeps a facts-only trace without a sealed prompt', async () => {
      const facts: any = light({ requestId: 'facts', masked: false, raw: true, omitted: 'not-captured' });
      delete facts.prompt; delete facts.answer; delete facts.sealedPrompt;
      await storeTraces([
        { id: '1-0', message: light({ requestId: 'bad', masked: false, sealedPrompt: `Tell ${CANARY}` }) },
        { id: '2-0', message: light({ requestId: 'good', masked: false, sealedPrompt: sealText(`Tell ${CANARY}`, ENV) }) },
        { id: '3-0', message: facts }
      ]);
      expect((await rowsOf(TRACES)).map((r: any) => r.requestId)).toEqual(['good', 'facts']);
      expect(JSON.stringify(await rowsOf(TRACES))).not.toContain(CANARY);
    });
  });

  it('Review Focus 2: a canary word of a sealed prompt or a sealed stage is in no column of any row', async () => {
    await storeTraces([{ id: '1-0', message: light({ masked: false, prompt: undefined, answer: undefined, sealedPrompt: sealText(`Ask ${CANARY} today`, ENV) }) }]);
    await storeRawTraces([{ id: '1-0', message: raw({
      sealedStages: stagesOf(`My name is ${CANARY}`),
      // a stage index entry with more than its name, size and cut mark keeps only those
      stageIndex: [{ name: '00_arrival', bytes: 120, cut: false, content: CANARY }]
    }) }]);
    const everything = JSON.stringify([await rowsOf(TRACES), await rowsOf(RAW)]);
    expect(everything).not.toContain(CANARY);
    expect(JSON.parse((await rowsOf(RAW))[0].stageIndex)).toEqual([{ name: '00_arrival', bytes: 120, cut: false }]);
  });

  describe('handleTraceStreamEntries', () => {
    it('stores the light traces, then acknowledges and deletes each stream entry', async () => {
      const order: string[] = [];
      const client = fakeClient({
        xack: jest.fn(async () => { order.push(`ack after ${(await rowsOf(TRACES)).length} rows`); return 1; }),
        xdel: jest.fn(async () => { order.push('del'); return 1; })
      });
      await handleTraceStreamEntries(client as any, 'light', [['1-0', ['trace', JSON.stringify(light())]], ['2-0', ['trace', JSON.stringify(light({ requestId: 'req-2' }))]]]);
      expect(order).toEqual(['ack after 2 rows', 'del', 'ack after 2 rows', 'del']);
      expect(client.xack).toHaveBeenCalledWith('payload-traces', 'payload-trace-ingest', '1-0');
      expect(client.xdel).toHaveBeenCalledWith('payload-traces', '2-0');
    });

    it('stores the raw traces of the raw-traces stream through its own group', async () => {
      const client = fakeClient();
      await handleTraceStreamEntries(client as any, 'raw', [['5-0', ['raw', JSON.stringify(raw())]]]);
      expect(await rowsOf(RAW)).toHaveLength(1);
      expect(client.xack).toHaveBeenCalledWith('raw-traces', 'raw-trace-ingest', '5-0');
    });

    it.each([
      ['light', 'no trace field', ['other', 'x']],
      ['light', 'invalid JSON', ['trace', '{nope']],
      ['light', 'a message of another version', ['trace', JSON.stringify(light({ v: 9 }))]],
      ['raw', 'invalid JSON', ['raw', '{nope']],
      ['raw', 'a light trace on the raw stream', ['raw', JSON.stringify(light())]]
    ])('acknowledges and counts a malformed %s entry (%s)', async (kind, _name, fields) => {
      const client = fakeClient();
      await handleTraceStreamEntries(client as any, kind as any, [['6-0', fields as string[]]]);
      expect(client.xack).toHaveBeenCalledTimes(1);
      expect(client.xdel).toHaveBeenCalledTimes(1);
      expect(traceIngestStats().malformed).toBe(1);
      expect((await rowsOf(TRACES)).length + (await rowsOf(RAW)).length).toBe(0);
    });

    it('leaves the entries unacknowledged when the rows cannot be committed', async () => {
      const client = fakeClient();
      const realTx = cds.tx.bind(cds);
      const writes: string[] = [];
      // The light path reads first (credentials, raw traces) in a transaction of its own; the write is the one refused.
      const spy = jest.spyOn(cds, 'tx').mockImplementation((fn: any) => realTx(async (tx: any) => {
        const view = Object.create(tx);
        view.run = async (q: any) => {
          if (q?.UPSERT) { writes.push('upsert'); throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); }
          return tx.run(q);
        };
        return fn(view);
      }));
      try {
        await handleTraceStreamEntries(client as any, 'light', [['7-0', ['trace', JSON.stringify(light())]]]);
        await handleTraceStreamEntries(client as any, 'raw', [['8-0', ['raw', JSON.stringify(raw())]]]);
      } finally { spy.mockRestore(); }
      expect(writes).toEqual(['upsert', 'upsert']);
      expect(client.xack).not.toHaveBeenCalled();
      expect((await rowsOf(TRACES)).length + (await rowsOf(RAW)).length).toBe(0);
      expect(traceIngestStats().malformed).toBe(0);
    });

    it.each(['light', 'raw'] as const)('writes %s rows one by one when the batch is refused with a data error: the refused row is skipped, the rest stored', async (kind) => {
      const client = fakeClient();
      const realTx = cds.tx.bind(cds);
      const entity = kind === 'light' ? TRACES : RAW;
      // The database takes the UPSERT and refuses the transaction holding row 2-0 when it commits (rolled back).
      const spy = jest.spyOn(cds, 'tx').mockImplementation((fn: any) => realTx(async (tx: any) => {
        const result = await fn(tx);
        const written: any[] = await tx.run(cds.ql.SELECT.from(entity).columns('ID').where({ ID: '2-0' }));
        if (written.length > 0) throw Object.assign(new Error('numeric value out of range'), { code: '22003' });
        return result;
      }));
      const message = (i: number) => (kind === 'light' ? light({ requestId: `req-${i}` }) : raw({ requestId: `req-${i}` }));
      try {
        await handleTraceStreamEntries(client as any, kind, [1, 2, 3].map((i) => [`${i}-0`, [kind === 'light' ? 'trace' : 'raw', JSON.stringify(message(i))]]));
      } finally { spy.mockRestore(); }
      expect((await rowsOf(entity)).map((r: any) => r.ID)).toEqual(['1-0', '3-0']);
      expect(traceIngestStats()).toEqual({ stored: 2, malformed: 1 });
      expect(client.xack).toHaveBeenCalledTimes(3);
    });

    it('acknowledges entries the database rejects with a data error no redelivery can fix', async () => {
      const client = fakeClient();
      const spy = jest.spyOn(cds, 'tx').mockImplementation(async () => { throw Object.assign(new Error('value too long'), { code: '22001' }); });
      try {
        await handleTraceStreamEntries(client as any, 'light', [['8-0', ['trace', JSON.stringify(light())]]]);
      } finally { spy.mockRestore(); }
      expect(client.xack).toHaveBeenCalledTimes(1);
      expect(traceIngestStats().malformed).toBe(1);
    });
  });

  describe('startPayloadTraceIngest', () => {
    it('reads both streams through their own groups and connections and stores what it reads', async () => {
      const clients: any[] = [];
      let stops = 0;
      let handle: any;
      const createClient = () => {
        let call = 0;
        const client = fakeClient({
          xreadgroup: jest.fn(async (...args: any[]) => {
            call++;
            const stream = args[args.length - 2];
            if (call === 1 && stream === 'payload-traces') return [[stream, [['1-0', ['trace', 'not json']], ['2-0', ['trace', JSON.stringify(light())]]]]];
            if (call === 1 && stream === 'raw-traces') return [[stream, [['3-0', ['raw', JSON.stringify(raw())]]]]];
            if (++stops === 2) await handle.stop();
            return null;
          })
        });
        clients.push(client);
        return client;
      };
      handle = startPayloadTraceIngest({ createClient: createClient as any });
      expect(handle).not.toBeNull();
      await handle.done;
      expect(clients).toHaveLength(2);
      expect(clients.flatMap((c) => c.xgroup.mock.calls)).toEqual(expect.arrayContaining([
        ['CREATE', 'payload-traces', 'payload-trace-ingest', '0', 'MKSTREAM'], ['CREATE', 'raw-traces', 'raw-trace-ingest', '0', 'MKSTREAM']]));
      expect(await rowsOf(TRACES)).toHaveLength(1);
      expect(await rowsOf(RAW)).toHaveLength(1);
      expect(traceIngestStats().malformed).toBe(1);
      // A raw trace may be ~2.75 MB: 5 per read (also per reclaim) keeps a batch small; light traces read 20.
      const countOf = (calls: any[][], stream: string) => calls.filter((a) => a.includes(stream)).map((a) => a[a.indexOf('COUNT') + 1]);
      const reads = clients.flatMap((c) => c.xreadgroup.mock.calls);
      const claims = clients.flatMap((c) => c.xautoclaim.mock.calls);
      expect(new Set(countOf(reads, 'payload-traces'))).toEqual(new Set(['20']));
      expect(new Set(countOf(reads, 'raw-traces'))).toEqual(new Set(['5']));
      expect(new Set(countOf(claims, 'payload-traces'))).toEqual(new Set(['20']));
      expect(new Set(countOf(claims, 'raw-traces'))).toEqual(new Set(['5']));
    });

    it('does not start in a test process without an injected client, nor without Valkey', () => {
      const saved = process.env.VALKEY_URL;
      process.env.VALKEY_URL = 'redis://127.0.0.1:1';
      try { expect(startPayloadTraceIngest()).toBeNull(); } finally { if (saved === undefined) delete process.env.VALKEY_URL; else process.env.VALKEY_URL = saved; }
      delete process.env.VALKEY_URL;
      try { expect(startPayloadTraceIngest({ allowInTest: true })).toBeNull(); } finally { if (saved !== undefined) process.env.VALKEY_URL = saved; }
    });
  });
});
