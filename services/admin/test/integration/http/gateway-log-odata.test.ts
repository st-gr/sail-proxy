/**
 * The gateway log over OData (spec: gateway log and payload traces) on cds.test(): read-only, admin
 * only, searched literally and case-insensitively, one row per entry whatever the message holds, and
 * the export route mounted behind the same role. In-memory SQLite with mocked users; runs bare.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'log-admin@test.com': { id: 'log-admin@test.com', roles: ['admin', 'user'] },
  'log-user@test.com': { id: 'log-user@test.com', roles: ['user'] } } };

const { GET, POST, DELETE } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'log-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'log-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const LOG = '/odata/v4/admin/GatewayLog';
const messages = (r: any): string[] => r.data.value.map((x: any) => x.message);

const seed = [
  { ID: 'a-0-0', loggedAt: '2026-11-11T10:00:00.000Z', seq: 1, level: 'INFO', component: 'chatController', requestId: 'req-alpha', message: 'Quota is at 50% of the limit' },
  { ID: 'a-0-1', loggedAt: '2026-11-11T10:00:01.000Z', seq: 2, level: 'INFO', component: 'chatController', requestId: 'req-alpha', message: 'Quota is at 500 of the limit' },
  { ID: 'a-0-2', loggedAt: '2026-11-11T10:00:02.000Z', seq: 3, level: 'INFO', component: 'sapProvider', requestId: 'req-beta', message: 'cache key a_b stored' },
  { ID: 'a-0-3', loggedAt: '2026-11-11T10:00:03.000Z', seq: 4, level: 'INFO', component: 'sapProvider', requestId: 'req-beta', message: 'cache key axb stored' },
  { ID: 'a-0-4', loggedAt: '2026-11-11T10:00:04.000Z', seq: 5, level: 'ERROR', component: 'sapProvider', requestId: null, message: 'Upstream call failed with an ERROR' },
  { ID: 'a-0-5', loggedAt: '2026-11-11T10:00:05.000Z', seq: 6, level: 'WARN', component: 'imagesController', requestId: null, message: 'first line\nsecond line' },
  { ID: 'a-0-6', loggedAt: '2026-11-11T10:00:05.000Z', seq: 7, level: 'INFO', component: 'imagesController', requestId: null, message: "it's a back\\slash and a \"quote\"" },
  { ID: 'a-0-7', loggedAt: '2026-11-11T09:59:56.000Z', seq: 8, level: 'INFO', component: 'netClient', requestId: null, message: 'Connection refused by example.org' },
  { ID: 'a-0-8', loggedAt: '2026-11-11T09:59:57.000Z', seq: 9, level: 'INFO', component: 'netClient', requestId: null, message: 'connection established, nothing refused' },
  { ID: 'a-0-9', loggedAt: '2026-11-11T09:59:58.000Z', seq: 10, level: 'INFO', component: 'netClient', requestId: null, message: 'routing {"model":"gpt-5"} now' },
  { ID: 'a-0-10', loggedAt: '2026-11-11T09:59:59.000Z', seq: 11, level: 'INFO', component: 'netClient', requestId: null, message: 'the model gpt-5 is chosen' }
];

beforeEach(async () => {
  await cds.db.run(cds.ql.DELETE.from(ENTITY));
  await cds.db.run(cds.ql.INSERT.into(ENTITY).entries(seed));
});

describe('GatewayLog over OData', () => {
  it('gives an admin every entry and refuses a user with 403', async () => {
    const admin = await GET(LOG, ADMIN);
    expect(admin.status).toBe(200);
    expect(admin.data.value).toHaveLength(seed.length);
    expect((await ok(GET(LOG, USER))).status).toBe(403);
  });

  it('is read-only: no create, update or delete, not even for an admin', async () => {
    expect((await ok(POST(LOG, { ID: 'x', loggedAt: '2026-11-11T10:00:00Z', message: 'm' }, ADMIN))).status).toBeGreaterThanOrEqual(400);
    expect((await ok(DELETE(`${LOG}('a-0-0')`, ADMIN))).status).toBeGreaterThanOrEqual(400);
    expect(await cds.db.run(cds.ql.SELECT.from(ENTITY))).toHaveLength(seed.length);
  });

  it('returns a message with a line break as one row', async () => {
    const r = await GET(`${LOG}?$filter=component eq 'imagesController' and level eq 'WARN'`, ADMIN);
    expect(r.data.value).toHaveLength(1);
    expect(r.data.value[0].message).toBe('first line\nsecond line');
  });

  it('filters on a time range ordered by loggedAt, seq', async () => {
    const q = `${LOG}?$filter=loggedAt ge 2026-11-11T10:00:01Z and loggedAt le 2026-11-11T10:00:05Z&$orderby=loggedAt,seq`;
    const r = await GET(q, ADMIN);
    expect(r.data.value.map((x: any) => x.seq)).toEqual([2, 3, 4, 5, 6, 7]);
    const desc = await GET(`${LOG}?$filter=loggedAt ge 2026-11-11T10:00:05Z&$orderby=loggedAt desc,seq desc`, ADMIN);
    expect(desc.data.value.map((x: any) => x.seq)).toEqual([7, 6]);
  });

  describe('$search is literal and case-insensitive', () => {
    const search = async (term: string) => messages(await GET(`${LOG}?$search=${encodeURIComponent(term)}&$orderby=loggedAt,seq`, ADMIN));
    // As the Logs page sends it (webapp/model/logQuery.ts): the text as one OData quoted string, so the
    // URL parser accepts any text, also an unpaired double quote.
    const quoted = (term: string) => `"${term.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    const typed = (term: string) => search(quoted(term));

    it('finds a row whose message holds ERROR with the text error', async () => {
      expect(await search('error')).toEqual(['Upstream call failed with an ERROR']);
      expect(await search('ERROR')).toEqual(['Upstream call failed with an ERROR']);
    });
    it('treats % as itself: 50% finds only the row that holds 50%', async () => {
      expect(await search('50%')).toEqual(['Quota is at 50% of the limit']);
    });
    it('treats _ as itself: a_b does not match axb', async () => {
      expect(await search('a_b')).toEqual(['cache key a_b stored']);
    });
    it('treats a backslash, quote and apostrophe as themselves', async () => {
      expect(await search('back\\slash')).toEqual(["it's a back\\slash and a \"quote\""]);
      expect(await search("it's")).toHaveLength(1);
    });
    it('searches the component and the request id too', async () => {
      expect(await search('SAPPROVIDER')).toHaveLength(3);
      expect(await search('req-beta')).toHaveLength(2);
    });
    it('combines with $filter', async () => {
      const r = await GET(`${LOG}?$search=sapprovider&$filter=level eq 'ERROR'`, ADMIN);
      expect(messages(r)).toEqual(['Upstream call failed with an ERROR']);
    });
    it('finds the whole phrase, not the first word: connection refused', async () => {
      expect(await search('connection refused')).toEqual(['Connection refused by example.org']);
      expect(await search('CONNECTION REFUSED')).toEqual(['Connection refused by example.org']);
      const counted = await GET(`${LOG}?$count=true&$top=1&$search=${encodeURIComponent('connection refused')}`, ADMIN);
      expect(counted.data['@odata.count']).toBe(1);
    });
    it('takes a leading double quote as a character, not as quoting', async () => {
      expect(await search('"model":"gpt-5"')).toEqual(['routing {"model":"gpt-5"} now']);
      expect(await typed('"quote')).toEqual(["it's a back\\slash and a \"quote\""]);
      expect(await typed('"model":"gpt-5"')).toEqual(['routing {"model":"gpt-5"} now']);
    });
    it('takes the text of one quoted string as typed: a phrase, a backslash, an ampersand', async () => {
      expect(await typed('connection refused')).toEqual(['Connection refused by example.org']);
      expect(await typed('back\\slash and a "quote"')).toEqual(["it's a back\\slash and a \"quote\""]);
      expect(await typed('50%')).toEqual(['Quota is at 50% of the limit']);
      expect(await typed('a&b')).toEqual([]);
    });
    it('takes a double quote in the middle as a character', async () => {
      expect(await search('a "quote"')).toEqual(["it's a back\\slash and a \"quote\""]);
      expect(await search('l":"g')).toEqual(['routing {"model":"gpt-5"} now']);
    });
    it('a search of spaces only is no search', async () => {
      expect(await search('   ')).toHaveLength(seed.length);
    });
    it('a search that is only a wildcard character finds nothing, not everything', async () => {
      expect(await search('%')).toEqual(['Quota is at 50% of the limit']);
      expect(await search('_')).toEqual(['cache key a_b stored']);
    });
  });

  it('gives up to 2,000 rows to one read ($top=2000), not CAP\'s default 1,000', async () => {
    await cds.db.run(cds.ql.DELETE.from(ENTITY));
    const many = Array.from({ length: 2050 }, (_, i) => ({
      ID: `m-0-${String(i).padStart(4, '0')}`, loggedAt: new Date(Date.UTC(2026, 10, 11, 10) + i * 1000).toISOString(), seq: i,
      level: 'INFO', component: 'chatController', requestId: null, message: `entry ${i}`
    }));
    await cds.db.run(cds.ql.INSERT.into(ENTITY).entries(many));
    const r = await GET(`${LOG}?$select=ID&$orderby=loggedAt desc&$top=2000`, ADMIN);
    expect(r.data.value).toHaveLength(2000);
    expect(r.data.value[0].ID).toBe('m-0-2049');
  });

  it('exposes storedAt and filters on it: a poll gets what was stored after its cursor, a NULL storedAt counts as stored long ago', async () => {
    await cds.db.run(cds.ql.UPDATE(ENTITY).set({ storedAt: '2026-11-11T12:00:00.000Z' }).where({ ID: { in: ['a-0-0', 'a-0-1'] } }));
    await cds.db.run(cds.ql.UPDATE(ENTITY).set({ storedAt: '2026-11-11T12:00:10.000Z' }).where({ ID: 'a-0-4' }));
    const r = await GET(`${LOG}?$select=ID,storedAt&$filter=${encodeURIComponent("storedAt gt 2026-11-11T12:00:05.000Z")}`, ADMIN);
    expect(r.data.value.map((x: any) => x.ID)).toEqual(['a-0-4']);
    expect(Date.parse(r.data.value[0].storedAt)).toBe(Date.parse('2026-11-11T12:00:10.000Z'));
    const level = await GET(`${LOG}?$select=ID&$filter=${encodeURIComponent("storedAt gt 2026-11-11T11:00:00.000Z and (level eq 'INFO')")}&$orderby=loggedAt desc,seq desc,ID desc`, ADMIN);
    expect(level.data.value.map((x: any) => x.ID)).toEqual(['a-0-1', 'a-0-0']);
  });

  describe('the export route', () => {
    // cds.test serves no app-level auth middleware (index.ts adds it in the real server), so a plain
    // Express route sees no user here: it must be mounted (not 404) and refuse the unidentified caller.
    // The roles (admin 200, user 403) are tested in test/unit/srv/gateway-log-export.test.ts.
    it('is mounted at /api/logs/gateway/export and refuses a caller without an identity', async () => {
      const res = await ok(GET('/api/logs/gateway/export', USER));
      expect(res.status).toBe(401);
    });
  });
});
