/**
 * Stores shared with teams (spec 2026-10-14 §8), against a real Postgres: the share table, and
 * the one visibility predicate every reader applies (the pre-turn guard, the store reads, the
 * search's store check and recall's chunk scope). A mocked pool cannot test a predicate, so this
 * suite runs only with FILE_SEARCH_TEST_DSN.
 *
 * Sharing with a team grants read and search only: `owned` stays false for a member, which is
 * what the owner-only routes (attach, batches, re-embed, delete) check.
 */
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import {
  assertStoresAccessible, createStore, listVisibleStores, readVisibleStore, recallCandidates, ToolRequestError,
} from '../../../src/fileSearch/repository';
import { searchVectorStores, SearchStoreNotFoundError } from '../../../src/fileSearch/search';
import * as ctrl from '../../../src/controllers/groundingAdminController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

// Only the query embedding is stubbed (as in storeAccessGuard.test.ts); the SQL is real.
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: jest.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    usage: { promptTokens: 0, totalTokens: 0 },
  })),
}));

const OWNER = 'owner@test.com';
const MEMBER = 'member@test.com';

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = (name: any, value?: any) => { res.headers[name] = value; return res; };
  res.setHeader = res.set;
  res.type = () => res;
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

type Handler = (req: any, res: any, next: any) => Promise<void>;

/** A handler call as the grounding router makes it (groundingActingUser has set the actor). */
async function call(handler: Handler, email: string, overrides: Record<string, any> = {}): Promise<any> {
  const res = makeRes();
  let failure: unknown = null;
  const req = { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, groundingActor: { email, role: 'user' }, ...overrides };
  await handler(req, res, (e: unknown) => { failure = e; });
  if (failure) throw failure;
  // The brief's assertions read `status`; the fake response records it as statusCode.
  return { status: res.statusCode, body: res.body };
}

d('team shares (spec 2026-10-14 §8)', () => {
  const TEAM_A = '0b6c2f0e-1111-4c4c-9a9a-000000000001';
  const TEAM_B = '0b6c2f0e-1111-4c4c-9a9a-000000000002';
  let fixture: IsolatedSchema;
  let pool: Pool;
  const share = (storeId: string, teamId: string) =>
    pool.query('INSERT INTO vector_store_team_shares (store_id, team_id, shared_by) VALUES ($1, $2, $3)', [storeId, teamId, OWNER]);

  /** One file with one chunk, so recall has something a member may or may not read. */
  async function seedChunk(storeId: string, fileId: string): Promise<void> {
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, $2, $1 || '.txt', 'assistants', 'seedblob', 1)`, [fileId, OWNER]);
    await pool.query(
      "INSERT INTO vector_store_files (store_id, file_id, attributes, status) VALUES ($1, $2, '{}'::jsonb, 'completed')",
      [storeId, fileId]);
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding, generation)
       VALUES ($1, $2, 0, 'quarterly harbour report', '[1,0,0]'::vector, 0)`, [storeId, fileId]);
  }

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      rewriteQuery: false,
      hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, rerank: { enabled: false, model: 'unused' } },
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
    await pool.query("INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ('seedblob', 1, 'inline')");
  });

  afterAll(async () => {
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    if (fixture) await fixture.teardown();
  });

  it('the migration creates the share table', async () => {
    const { rows } = await pool.query("SELECT to_regclass('vector_store_team_shares') IS NOT NULL AS present");
    expect(rows[0].present).toBe(true);
  });

  it('a member of a team the store is shared with sees it; another team, no team and a former member do not', async () => {
    const store = await createStore({ ownerEmail: OWNER, name: 'team store' });
    await share(store.id, TEAM_A);
    await expect(assertStoresAccessible([store.id], MEMBER, [TEAM_A])).resolves.toBeUndefined();
    await expect(assertStoresAccessible([store.id], MEMBER, [TEAM_B])).rejects.toBeInstanceOf(ToolRequestError);
    // A former member: the validation no longer names the team.
    await expect(assertStoresAccessible([store.id], MEMBER, [])).rejects.toBeInstanceOf(ToolRequestError);
    await expect(assertStoresAccessible([store.id], MEMBER)).rejects.toBeInstanceOf(ToolRequestError);
    expect(await readVisibleStore(MEMBER, store.id, [TEAM_A])).toMatchObject({ id: store.id, owned: false });
    expect(await readVisibleStore(MEMBER, store.id, [TEAM_B])).toBeNull();
    expect(await readVisibleStore(MEMBER, store.id, [])).toBeNull();
    const listed = await listVisibleStores(MEMBER, { limit: 10, teamIds: [TEAM_A] });
    expect(listed.map((s) => s.id)).toContain(store.id);
    expect((await listVisibleStores(MEMBER, { limit: 10 })).map((s) => s.id)).not.toContain(store.id);
    expect((await listVisibleStores(MEMBER, { limit: 10, teamIds: [TEAM_B] })).map((s) => s.id)).not.toContain(store.id);
  });

  it('the list cursor resolves under the same rule', async () => {
    const first = await createStore({ ownerEmail: OWNER, name: 'cursor 1' });
    const second = await createStore({ ownerEmail: OWNER, name: 'cursor 2' });
    await share(first.id, TEAM_B);
    await share(second.id, TEAM_B);
    const after = await listVisibleStores(MEMBER, { limit: 10, after: second.id, teamIds: [TEAM_B] });
    expect(after.map((s) => s.id)).toContain(first.id);
    // A cursor the caller cannot see gives an empty page.
    expect(await listVisibleStores(MEMBER, { limit: 10, after: second.id, teamIds: [TEAM_A] })).toEqual([]);
  });

  it('the owner keeps owning it; the share does not change owner-based reads', async () => {
    const store = await createStore({ ownerEmail: OWNER, name: 'owned' });
    await share(store.id, TEAM_A);
    expect(await readVisibleStore(OWNER, store.id)).toMatchObject({ id: store.id, owned: true });
    expect(await readVisibleStore(OWNER, store.id, [TEAM_A])).toMatchObject({ owned: true });
  });

  it('recall and search return a team store\'s chunks to a member only', async () => {
    const store = await createStore({ ownerEmail: OWNER, name: 'searched' });
    await seedChunk(store.id, 'file-team-1');
    await share(store.id, TEAM_A);
    const recall = (teamIds?: string[]) => recallCandidates({
      storeIds: [store.id], ownerEmail: MEMBER, teamIds, queryText: 'harbour report', queryEmbedding: [1, 0, 0],
    });
    expect((await recall([TEAM_A])).map((c) => c.fileId)).toEqual(['file-team-1']);
    expect(await recall([TEAM_B])).toEqual([]);
    expect(await recall([])).toEqual([]);
    expect(await recall()).toEqual([]);

    const search = (teamIds?: string[]) => searchVectorStores({
      storeIds: [store.id], query: 'harbour report', ownerEmail: MEMBER, teamIds, rankingOptions: { rerank: false },
    });
    expect((await search([TEAM_A])).data.map((h) => h.fileId)).toEqual(['file-team-1']);
    await expect(search([TEAM_B])).rejects.toBeInstanceOf(SearchStoreNotFoundError);
    await expect(search()).rejects.toBeInstanceOf(SearchStoreNotFoundError);
  });

  it('deleting the store deletes its shares', async () => {
    const store = await createStore({ ownerEmail: OWNER, name: 'gone' });
    await share(store.id, TEAM_A);
    await pool.query('DELETE FROM vector_stores WHERE id = $1', [store.id]);
    expect((await pool.query('SELECT 1 FROM vector_store_team_shares WHERE store_id = $1', [store.id])).rowCount).toBe(0);
  });

  describe('sharing with a team: the routes (Task 12)', () => {
    beforeEach(async () => { await pool.query('DELETE FROM vector_store_team_shares'); });

    it('an owner who administers the team shares with it; a non-admin of the team, a non-owner and a platform admin who does not own the store are refused', async () => {
      const store = await createStore({ ownerEmail: 'owner@test.com', name: 's' } as any);
      const owner = { email: 'owner@test.com', role: 'user', teamIds: [TEAM_A, TEAM_B], adminTeamIds: [TEAM_A] };
      const ok = await call(ctrl.shareStoreWithTeam, 'owner@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: owner });
      expect(ok.status).toBe(200);
      expect(ok.body.team_ids).toEqual([TEAM_A]);
      expect((await call(ctrl.shareStoreWithTeam, 'owner@test.com', { params: { id: store.id }, body: { teamId: TEAM_B }, groundingActor: owner })).status).toBe(403);
      expect((await call(ctrl.shareStoreWithTeam, 'other@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: { email: 'other@test.com', role: 'user', teamIds: [TEAM_A], adminTeamIds: [TEAM_A] } })).status).toBe(404);
      expect((await call(ctrl.shareStoreWithTeam, 'root@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: { email: 'root@test.com', role: 'admin', teamIds: [], adminTeamIds: [] } })).status).toBe(404);
    });

    it('sharing twice is one share; a platform admin who owns the store shares with any team; a malformed or unknown id is refused', async () => {
      const store = await createStore({ ownerEmail: 'root@test.com', name: 'twice' } as any);
      const root = { email: 'root@test.com', role: 'admin', teamIds: [], adminTeamIds: [] };
      for (let i = 0; i < 2; i += 1) {
        const r = await call(ctrl.shareStoreWithTeam, 'root@test.com', { params: { id: store.id }, body: { teamId: TEAM_B.toUpperCase() }, groundingActor: root });
        expect(r.status).toBe(200);
        expect(r.body.team_ids).toEqual([TEAM_B]);
      }
      expect((await pool.query('SELECT shared_by FROM vector_store_team_shares WHERE store_id = $1', [store.id])).rows).toEqual([{ shared_by: 'root@test.com' }]);
      const bad = await call(ctrl.shareStoreWithTeam, 'root@test.com', { params: { id: store.id }, body: { teamId: 'x' }, groundingActor: root });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('invalid_team_id');
      expect((await call(ctrl.shareStoreWithTeam, 'root@test.com', { params: { id: 'vs_missing' }, body: { teamId: TEAM_A }, groundingActor: root })).status).toBe(404);
    });

    it('the owner, an admin of the team or a platform admin unshares; a plain member cannot', async () => {
      const store = await createStore({ ownerEmail: 'owner@test.com', name: 's2' } as any);
      await share(store.id, TEAM_A);
      const member = { email: 'm@test.com', role: 'user', teamIds: [TEAM_A], adminTeamIds: [] };
      expect((await call(ctrl.unshareStoreFromTeam, 'm@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: member })).status).toBe(403);
      const lead = { email: 'lead@test.com', role: 'user', teamIds: [TEAM_A], adminTeamIds: [TEAM_A] };
      const r = await call(ctrl.unshareStoreFromTeam, 'lead@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: lead });
      expect(r.status).toBe(200);
      expect(r.body.team_ids).toEqual([]);
      await share(store.id, TEAM_A);
      expect((await call(ctrl.unshareStoreFromTeam, 'root@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: { email: 'root@test.com', role: 'admin', teamIds: [], adminTeamIds: [] } })).status).toBe(200);
    });

    it('the owner unshares; unsharing a team it is not shared with is a no-op; a store the caller cannot see is a 404', async () => {
      const store = await createStore({ ownerEmail: OWNER, name: 's3' } as any);
      await share(store.id, TEAM_A); await share(store.id, TEAM_B);
      const owner = { email: OWNER, role: 'user', teamIds: [], adminTeamIds: [] };
      const r = await call(ctrl.unshareStoreFromTeam, OWNER, { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: owner });
      expect(r.status).toBe(200);
      expect(r.body.team_ids).toEqual([TEAM_B]);
      const again = await call(ctrl.unshareStoreFromTeam, OWNER, { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: owner });
      expect(again.status).toBe(200);
      expect(again.body.team_ids).toEqual([TEAM_B]);
      // An admin of TEAM_A who is in no team the store is shared with does not see it.
      const outsider = { email: 'lead@test.com', role: 'user', teamIds: [TEAM_A], adminTeamIds: [TEAM_A] };
      expect((await call(ctrl.unshareStoreFromTeam, 'lead@test.com', { params: { id: store.id }, body: { teamId: TEAM_A }, groundingActor: outsider })).status).toBe(404);
      expect((await call(ctrl.unshareStoreFromTeam, 'root@test.com', { params: { id: 'vs_missing' }, body: { teamId: TEAM_A }, groundingActor: { email: 'root@test.com', role: 'admin' } })).status).toBe(404);
    });

    it('store objects carry team_ids: every team for the owner and a platform admin, only the caller\'s own teams for a member', async () => {
      const store = await createStore({ ownerEmail: OWNER, name: 'listed' } as any);
      await share(store.id, TEAM_A); await share(store.id, TEAM_B);
      const owner = await call(ctrl.readStore, OWNER, { params: { id: store.id }, groundingActor: { email: OWNER, role: 'user', teamIds: [], adminTeamIds: [] } });
      expect(owner.body.team_ids).toEqual([TEAM_A, TEAM_B].sort());
      const member = await call(ctrl.readStore, MEMBER, { params: { id: store.id }, groundingActor: { email: MEMBER, role: 'user', teamIds: [TEAM_A], adminTeamIds: [] } });
      expect(member.body).toMatchObject({ owned: false, team_ids: [TEAM_A] });
      const listed = await call(ctrl.listStores, MEMBER, { groundingActor: { email: MEMBER, role: 'user', teamIds: [TEAM_B], adminTeamIds: [] } });
      expect(listed.body.data.find((s: any) => s.id === store.id).team_ids).toEqual([TEAM_B]);
      const plain = await createStore({ ownerEmail: OWNER, name: 'unshared' } as any);
      const ownList = await call(ctrl.listStores, OWNER, { groundingActor: { email: OWNER, role: 'user', teamIds: [], adminTeamIds: [] } });
      expect(ownList.body.data.find((s: any) => s.id === plain.id).team_ids).toEqual([]);
      const admin = await call(ctrl.listAllStores, 'root@test.com', { groundingActor: { email: 'root@test.com', role: 'admin' } });
      expect(admin.body.data.find((s: any) => s.id === store.id).team_ids).toEqual([TEAM_A, TEAM_B].sort());
    });

    it('DELETE /admin/teams/:teamId/shares removes every share of the team', async () => {
      const s1 = await createStore({ ownerEmail: 'owner@test.com', name: 'x1' } as any);
      const s2 = await createStore({ ownerEmail: 'owner@test.com', name: 'x2' } as any);
      await share(s1.id, TEAM_A); await share(s2.id, TEAM_A); await share(s2.id, TEAM_B);
      const r = await call(ctrl.deleteTeamShares, 'root@test.com', { params: { teamId: TEAM_A }, groundingActor: { email: 'root@test.com', role: 'admin' } });
      expect(r.body).toEqual({ deleted: 2 });
      expect((await pool.query('SELECT team_id FROM vector_store_team_shares')).rows.map((x: any) => x.team_id)).toEqual([TEAM_B]);
    });
  });
});
