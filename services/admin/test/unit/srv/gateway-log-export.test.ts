/**
 * GET /api/logs/gateway/export: the stored log as text, one line per entry in the console format,
 * read in pages and written as it is read, capped, and admin only. The filters are the OData ones
 * (the same search code, the same chained range conditions). In-memory SQLite.
 */
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const cds = require('@sap/cds');
const { createGatewayLogExportRouter } = require('../../../src/srv/admin-service-logs');

const ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const ADMIN = { id: 'jane.roe@example.org', roles: ['admin', 'user'] };
const USER = { id: 'user@example.org', roles: ['user'] };

const appAs = (user: any, options: any = {}): express.Application => {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/logs', createGatewayLogExportRouter(options));
  return app;
};
const row = (i: number, over: any = {}) => ({
  ID: `s-0-${String(i).padStart(4, '0')}`, loggedAt: `2026-11-11T10:00:${String(i).padStart(2, '0')}.000Z`, seq: i, level: 'INFO',
  component: 'chatController', requestId: 'req-1', message: `message ${i}`, error: null, ...over
});
const get = (qs = '', user: any = ADMIN, options: any = {}) => request(appAs(user, options)).get(`/api/logs/gateway/export${qs}`).buffer(true).parse((res, cb) => {
  let data = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { data += c; }); res.on('end', () => cb(null, data));
});
const lines = (res: any): string[] => String(res.body).split('\n').filter((l) => l !== '');

describe('GET /api/logs/gateway/export', () => {
  beforeAll(async () => {
    process.env.VALIDATION_TOKEN_SECRET = 'f'.repeat(64);
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to(db);
  });
  beforeEach(async () => { await cds.db.run(cds.ql.DELETE.from(ENTITY)); });
  const seed = (rows: any[]) => cds.db.run(cds.ql.INSERT.into(ENTITY).entries(rows));

  describe('who may call it', () => {
    it('refuses the user role with 403 and an anonymous caller with 401', async () => {
      expect((await get('', USER)).status).toBe(403);
      expect((await get('', null)).status).toBe(401);
    });
  });

  describe('the text', () => {
    it('writes one line per entry in the console format, oldest first, as an attachment named with the date', async () => {
      await seed([row(2, { level: 'ERROR', component: 'sapProvider', requestId: null, message: 'upstream failed', error: 'TypeError: boom' }), row(1)]);
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="gateway-log-\d{4}-\d{2}-\d{2}\.txt"$/);
      expect(lines(res)).toEqual([
        '2026-11-11T10:00:01.000Z [req-1] INFO  [chatController] message 1',
        '2026-11-11T10:00:02.000Z ERROR [sapProvider] upstream failed Error: TypeError: boom'
      ]);
    });

    it('writes a line break inside a message as \\n so every entry stays one line', async () => {
      await seed([row(1, { message: 'first\nsecond\r\nthird\rfourth', error: 'Error: a\nb' }), row(2)]);
      const res = await get();
      expect(lines(res)).toHaveLength(2);
      expect(lines(res)[0]).toBe('2026-11-11T10:00:01.000Z [req-1] INFO  [chatController] first\\nsecond\\nthird\\nfourth Error: Error: a\\nb');
    });

    it('escapes control characters, the backslash and the Unicode line separators in every field', async () => {
      await seed([row(1, { requestId: 'r\u001b1', component: 'c\u0000x', message: 'red \u001b[31m text\u2028next\u2029para \u0085nel \u007f del', error: 'a\\nb\tc' }), row(2)]);
      const l = lines(await get());
      expect(l).toHaveLength(2);
      expect(l[0]).toBe('2026-11-11T10:00:01.000Z [r\\u001b1] INFO  [c\\u0000x] red \\u001b[31m text\\u2028next\\u2029para \\u0085nel \\u007f del Error: a\\\\nb\\tc');
      expect(l[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    });

    it('orders by loggedAt, seq, ID, also across pages and for equal times', async () => {
      await seed([row(5, { loggedAt: '2026-11-11T10:00:00.000Z', seq: 5, message: 'e' }), row(3, { loggedAt: '2026-11-11T10:00:00.000Z', seq: 3, message: 'c' }),
        row(4, { loggedAt: '2026-11-11T10:00:00.000Z', seq: 4, ID: 'z-0-0', message: 'd2' }), row(4, { loggedAt: '2026-11-11T10:00:00.000Z', seq: 4, ID: 'a-0-0', message: 'd1' }),
        row(9, { loggedAt: '2026-11-11T09:00:00.000Z', seq: 100, message: 'first' })]);
      const res = await get('', ADMIN, { pageSize: 2 });
      expect(lines(res).map((l) => l.split('] ').pop())).toEqual(['first', 'c', 'd1', 'd2', 'e']);
    });
  });

  describe('the filters', () => {
    beforeEach(async () => {
      await seed([row(1), row(2, { level: 'WARN' }), row(3, { level: 'ERROR', message: 'An ERROR with 50% and a_b' }), row(4, { message: 'axb and 500' }), row(5, { level: 'DEBUG', component: 'sapProvider' })]);
    });
    const messagesOf = (res: any) => lines(res).map((l) => l.replace(/^.*?\] /, '').split(' ').slice(-2).join(' '));

    it('from and to are an inclusive range', async () => {
      const res = await get('?from=2026-11-11T10:00:02Z&to=2026-11-11T10:00:04Z');
      expect(lines(res)).toHaveLength(3);
      expect(lines(res)[0]).toContain('10:00:02');
      expect(lines(res)[2]).toContain('10:00:04');
    });
    describe('the spellings of a time', () => {
      // Review finding 2026-11-12: the repair of a "+" that arrived as a space took the space
      // between date and time for it, so "2026-11-11 10:00" became "2026-11-11+10:00" and was
      // refused, while the same time with seconds or with a T was accepted.
      const range = async (from: string, to: string) => {
        const res = await get(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        return { status: res.status, count: res.status === 200 ? lines(res).length : String(res.body) };
      };
      // A time without an offset is read in the server's time zone, with a T as with a space:
      // the same spelling with a T is the reference, so the test holds in every zone.
      it('takes a space between date and time, without seconds', async () => {
        const spaced = await range('2026-11-11 10:00', '2026-11-11 10:01');
        expect(spaced.status).toBe(200);
        expect(spaced).toEqual(await range('2026-11-11T10:00', '2026-11-11T10:01'));
      });
      it('takes a space between date and time, with seconds', async () => {
        const spaced = await range('2026-11-11 10:00:00', '2026-11-11 10:01:00');
        expect(spaced.status).toBe(200);
        expect(spaced).toEqual(await range('2026-11-11T10:00:00', '2026-11-11T10:01:00'));
      });
      it('still repairs a "+" that arrived as a space in front of the offset', async () => {
        // what "?from=2026-11-11T11:00:00+01:00" looks like once the query string is decoded
        const res = await get('?from=2026-11-11T11:00:02+01:00&to=2026-11-11T11:00:04+01:00');
        expect(res.status).toBe(200);
        expect(lines(res)).toHaveLength(3);
        const spaced = await get('?from=2026-11-11%2011:00:02+01:00&to=2026-11-11%2011:00:04+01:00');
        expect(spaced.status).toBe(200);
        expect(lines(spaced)).toHaveLength(3);
      });
      it('still refuses a date followed by something that is neither a time nor an offset', async () => {
        expect((await get('?from=2026-11-11%2010')).status).toBe(400);
      });
    });

    it('level is the minimum level: WARN gives WARN and ERROR', async () => {
      const res = await get('?level=WARN');
      expect(lines(res)).toHaveLength(2);
      expect((await get('?level=warn')).body).toBe(res.body);
    });
    it('search is literal and case-insensitive, like $search', async () => {
      expect(lines(await get('?search=error'))).toHaveLength(1);
      expect(lines(await get('?search=50%25'))).toHaveLength(1);
      expect(lines(await get('?search=a_b'))).toHaveLength(1);
      expect(lines(await get('?search=SAPPROVIDER'))).toHaveLength(1);
      expect(messagesOf(await get('?search=axb'))[0]).toContain('500');
    });
    it('search finds the whole text as typed: a phrase, quotes, wildcards and case', async () => {
      await seed([
        row(6, { message: 'Connection refused by example.org' }), row(7, { message: 'connection established, nothing refused' }),
        row(8, { message: 'routing {"model":"gpt-5"} now' }), row(9, { message: 'the model gpt-5 is chosen' }), row(10, { message: 'say "hi" twice' })
      ]);
      const found = async (term: string) => lines(await get(`?search=${encodeURIComponent(term)}`)).map((l) => l.replace(/^.*?\[chatController\] /, ''));
      expect(await found('connection refused')).toEqual(['Connection refused by example.org']);
      expect(await found('CONNECTION REFUSED')).toEqual(['Connection refused by example.org']);
      expect(await found('"model":"gpt-5"')).toEqual(['routing {"model":"gpt-5"} now']);
      expect(await found('say "hi')).toEqual(['say "hi" twice']);
      expect(await found('50%')).toEqual(['An ERROR with 50% and a_b']);
      expect(await found('a_b')).toEqual(['An ERROR with 50% and a_b']);
      expect(await found('   ')).toHaveLength(10);
    });
    it('combines the filters', async () => {
      expect(lines(await get('?search=message&level=WARN&from=2026-11-11T10:00:00Z&to=2026-11-11T10:00:09Z'))).toHaveLength(1);
    });
  });

  describe('a request it cannot read is a 400 with a plain message', () => {
    it.each([
      ['an unparsable from', '?from=yesterday'],
      ['an unparsable to', '?to=2026-13-45T00:00:00Z'],
      ['an unknown level', '?level=LOUD'],
      ['a bracketed from', '?from[a]=1'],
      ['a repeated level', '?level=WARN&level=ERROR']
    ])('%s', async (_name, qs) => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(typeof JSON.parse(res.body).message).toBe('string');
    });
  });

  describe('the cap', () => {
    it('ends at the cap with a last line that says so in plain words, and holds no more than the cap lines', async () => {
      await seed(Array.from({ length: 12 }, (_, i) => row(i)));
      const res = await get('', ADMIN, { maxLines: 10, pageSize: 3 });
      const l = lines(res);
      expect(l).toHaveLength(10);
      expect(l[8]).toContain('message 8');
      expect(l[9]).toMatch(/^The export stops here: it is limited to 10 lines\. Narrow the time range or the search to see the rest\.$/);
    });
    it('has no such line when the result fits exactly', async () => {
      await seed(Array.from({ length: 10 }, (_, i) => row(i)));
      const l = lines(await get('', ADMIN, { maxLines: 10, pageSize: 3 }));
      expect(l).toHaveLength(10);
      expect(l[9]).toContain('message 9');
    });
    it('answers an empty result with an empty file', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body).toBe('');
    });
  });

  it('ignores a search that is empty after trimming (no search condition at all)', async () => {
    await seed([row(1), row(2)]);
    const spy = jest.spyOn(cds, 'tx');
    try {
      const res = await get('?search=%20%20');
      expect(lines(res)).toHaveLength(2);
    } finally { spy.mockRestore(); }
    const { readPage } = require('../../../src/srv/admin-service-logs');
    const run = jest.fn(async () => []);
    const tx = jest.spyOn(cds, 'tx').mockImplementation(async (fn: any) => fn({ run }));
    try { await readPage({ search: undefined }, undefined, 5); } finally { tx.mockRestore(); }
    expect(JSON.stringify((run.mock.calls[0] as any[])[0])).not.toContain('search');
  });

  it('ends the file with a plain line when a page cannot be read after the response started', async () => {
    await seed(Array.from({ length: 5 }, (_, i) => row(i)));
    const real = cds.tx.bind(cds);
    let calls = 0;
    const spy = jest.spyOn(cds, 'tx').mockImplementation((...a: any[]) => { calls++; return calls === 2 ? Promise.reject(new Error('db gone')) : real(...a); });
    try {
      const res = await get('', ADMIN, { pageSize: 2 });
      expect(res.status).toBe(200);
      const l = lines(res);
      expect(l).toHaveLength(3);
      expect(l[2]).toBe('The export stopped here because of an error; the file is incomplete.');
    } finally { spy.mockRestore(); }
  });

  it('stops paging and settles when the client disconnects while the response is backpressured', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => row(i)));
    const { EventEmitter } = require('events');
    const res: any = new EventEmitter();
    res.headersSent = false;
    res.status = () => res; res.setHeader = () => undefined; res.json = () => res;
    res.write = jest.fn(() => { setImmediate(() => res.emit('close')); return false; }); // backpressure, then the client goes: never 'drain'
    res.end = jest.fn();
    const router = createGatewayLogExportRouter({ pageSize: 2 });
    const layer = router.stack.find((l: any) => l.route?.path === '/gateway/export');
    const handler = layer.route.stack[0].handle;
    const spy = jest.spyOn(cds, 'tx');
    try {
      await Promise.race([
        handler({ user: ADMIN, query: {}, headers: {} }, res),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('the handler never settled')), 2000))
      ]);
      expect(spy.mock.calls.length).toBe(1); // the first page only
      expect(res.write).toHaveBeenCalledTimes(1);
      expect(res.listenerCount('drain')).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('reads in pages: no query asks for more than the page size', async () => {
    await seed(Array.from({ length: 7 }, (_, i) => row(i)));
    const spy = jest.spyOn(cds, 'tx');
    try {
      const res = await get('', ADMIN, { pageSize: 3 });
      expect(lines(res)).toHaveLength(7);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { spy.mockRestore(); }
  });
});
