/**
 * Live-Postgres coverage of the `file_search` tool's pre-turn access guard
 * (`assertStoresAccessible`, and `fileSearchDescriptor.prepare` on top of it).
 *
 * This suite exists because the property under test is a SQL predicate, and a
 * jest-mocked pool cannot test one: it returns whatever rows the test stages no
 * matter what the WHERE clause says, so the cross-tenant assertion would pass
 * unchanged after `owner_email` was deleted from the predicate. Only a real
 * database distinguishes the three cases that matter, and they must be
 * distinguished from each other, not just from "accessible":
 *
 *   - a store the caller owns                  -> accepted
 *   - a store someone else owns, is_shared     -> accepted
 *   - a store someone else owns, NOT is_shared -> rejected
 *
 * A predicate of only `owner_email = $2` passes every cross-tenant test while
 * silently breaking every shared store, and a predicate of only `is_shared =
 * true` does the reverse; the shared-store case below is what makes the pair
 * non-degenerate.
 *
 * And the fourth property, which is not about access at all but about
 * disclosure: an unknown id and a live-but-unowned id must be indistinguishable
 * in the response. Anything that separated them — 403 vs 404, or two different
 * messages — would let any caller enumerate the store ids that exist on this
 * deployment. Asserted by comparing the two failures field for field.
 *
 * The fifth is agreement: this guard must not admit a store the search it
 * fronts would then refuse, or the caller learns about the problem only as
 * every call failing mid-stream, with nothing visible to them. An EXPIRED store
 * There are TWO such axes, not one: an EXPIRED store (`StoreExpiredError`) and
 * a store whose pinned `embedding_dim` has drifted from the live configuration
 * (`StoreDimensionMismatchError`). `search.ts` refuses both, in one per-store
 * loop. The guard originally mirrored only the first, on the written-down but
 * false belief that a drifted store still searched fine — so the agreement
 * property is asserted against the real `searchVectorStores`, per axis, rather
 * than restated. Restating it is what let the two disagree in the first place.
 */
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import {
  assertStoresAccessible, createStore, ToolRequestError, StoreExpiredError,
  StoreDimensionMismatchError,
} from '../../../src/fileSearch/repository';
import { searchVectorStores } from '../../../src/fileSearch/search';
import { fileSearchDescriptor } from '../../../src/plugins/fileSearch/descriptor';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
const toolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  default: { getFileSearchToolConfig: () => toolConfig },
  getFileSearchToolConfig: () => toolConfig,
  getFileSearchConfig: () => mockConfig,
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../../../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../../../src/services/configService').MAX_RESULTS_DEFAULT,
}));

// The agreement tests below call the REAL searchVectorStores, including on stores it
// accepts — and a search that gets past the pre-condition gate goes on to embed its
// query. Only the embedding is stubbed (same approach as endToEnd.test.ts): everything
// this suite actually asserts on — the ownership predicate, the expiry and dimension
// gates, the errors and their statuses — is real, and runs against the real database.
jest.mock('../../../src/fileSearch/embedder', () => ({
  __esModule: true,
  // EmbedResult, not a bare vector — search.ts destructures `{ vectors }`.
  embed: jest.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    usage: { promptTokens: 0, totalTokens: 0 },
  })),
}));

const MINE = 'owner@example.com';
const THEIRS = 'other@example.com';

const logger: any = {
  error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
};

/**
 * The gate verdict for one store, as a comparable value: `{ usable: true }`, or the
 * refusal's observable fields.
 *
 * Deliberately compares only the PRE-CONDITION verdict, not the two functions' return
 * values — `assertStoresAccessible` returns nothing and `searchVectorStores` returns a
 * result page, so requiring those to match would be comparing different things. The
 * property under test is agreement about which stores are usable at all.
 */
async function outcomeOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
    return { usable: true };
  } catch (e: any) {
    return { name: e.name, status: e.status, code: e.code, message: e.message };
  }
}

/** Captures a rejection as a plain comparable object — no instanceof, no message
 *  paraphrase: exactly what a client would be able to observe. */
async function failureOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
    throw new Error('expected a rejection, but it resolved');
  } catch (e: any) {
    return { name: e.name, status: e.status, code: e.code, message: e.message };
  }
}

d('file_search pre-turn store access guard against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  let mineId: string;
  let theirsPrivateId: string;
  let theirsSharedId: string;
  let mineExpiredId: string;
  let mineDriftedId: string;
  const UNKNOWN_ID = 'vs_definitely_not_a_real_store';

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

    mineId = (await createStore({ ownerEmail: MINE, name: 'mine' })).id;
    theirsPrivateId = (await createStore({ ownerEmail: THEIRS, name: 'theirs-private' })).id;
    theirsSharedId = (await createStore({ ownerEmail: THEIRS, name: 'theirs-shared', isShared: true })).id;

    // Owned by the caller and perfectly readable — only expired. The expiry sweeper is
    // what normally sets this; writing the column directly keeps the fixture to the one
    // state under test.
    mineExpiredId = (await createStore({ ownerEmail: MINE, name: 'mine-expired' })).id;
    await pool.query(`UPDATE vector_stores SET status = 'expired' WHERE id = $1`, [mineExpiredId]);

    // Owned, readable and live — only its pinned embedding_dim no longer matches the
    // configured embedding model, which is what happens to a store that outlives a
    // configuration change. createStore pins the CURRENT dimension by construction, so
    // the drift has to be written onto the row.
    mineDriftedId = (await createStore({ ownerEmail: MINE, name: 'mine-drifted' })).id;
    await pool.query('UPDATE vector_stores SET embedding_dim = $2 WHERE id = $1',
      [mineDriftedId, EMBED_DIM + 1533]);
  });

  afterAll(async () => {
    __resetForTests();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    if (fixture) await fixture.teardown();
  });

  it('has fixtures that genuinely differ in ownership and sharing', async () => {
    // Guards the suite itself: if createStore ever stopped honouring isShared, every
    // assertion below would still "pass" while testing something else entirely.
    const { rows } = await pool.query(
      'SELECT id, owner_email, is_shared FROM vector_stores WHERE id = ANY($1) ORDER BY owner_email, is_shared',
      [[mineId, theirsPrivateId, theirsSharedId]]);
    expect(rows).toEqual([
      { id: theirsPrivateId, owner_email: THEIRS, is_shared: false },
      { id: theirsSharedId, owner_email: THEIRS, is_shared: true },
      { id: mineId, owner_email: MINE, is_shared: false },
    ]);
  });

  it('has unusable fixtures that differ from the usable ones on exactly ONE axis each', async () => {
    // Same self-guard for the other two axes. The expired store must NOT also be
    // drifted, and the drifted store must NOT also be expired — otherwise one gate
    // could be deleted entirely and the other would still fail every test, and the
    // per-axis mutation evidence would be worthless.
    const { rows } = await pool.query(
      'SELECT id, status, embedding_dim FROM vector_stores WHERE id = ANY($1)',
      [[mineId, mineExpiredId, mineDriftedId]]);
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(mineId)).toEqual({ id: mineId, status: 'completed', embedding_dim: EMBED_DIM });
    expect(byId.get(mineExpiredId)).toEqual({ id: mineExpiredId, status: 'expired', embedding_dim: EMBED_DIM });
    expect(byId.get(mineDriftedId)).toEqual({ id: mineDriftedId, status: 'completed', embedding_dim: EMBED_DIM + 1533 });
  });

  describe('assertStoresAccessible', () => {
    it('accepts a store the caller owns', async () => {
      await expect(assertStoresAccessible([mineId], MINE)).resolves.toBeUndefined();
    });

    it('accepts a shared store the caller does not own', async () => {
      // Fails if the predicate is narrowed to `owner_email = $2`.
      await expect(assertStoresAccessible([theirsSharedId], MINE)).resolves.toBeUndefined();
    });

    it('rejects a private store owned by someone else', async () => {
      // Fails if the `owner_email` condition is dropped from the predicate.
      await expect(assertStoresAccessible([theirsPrivateId], MINE))
        .rejects.toBeInstanceOf(ToolRequestError);
      await expect(assertStoresAccessible([theirsPrivateId], MINE))
        .rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    });

    it('rejects a mixed list because ONE id is another tenant\'s, not because the list is mixed', async () => {
      await expect(assertStoresAccessible([mineId, theirsSharedId], MINE)).resolves.toBeUndefined();
      await expect(assertStoresAccessible([mineId, theirsPrivateId], MINE))
        .rejects.toThrow(`Unknown vector store: ${theirsPrivateId}`);
    });

    it('is not an existence oracle: an unowned store and an unknown id fail identically', async () => {
      const unowned = await failureOf(assertStoresAccessible([theirsPrivateId], MINE));
      const unknown = await failureOf(assertStoresAccessible([UNKNOWN_ID], MINE));
      expect(unowned.status).toBe(400);
      expect(unowned.code).toBe('invalid_request_error');
      // Identical in every observable field once the id itself is normalised away:
      // same name, same status, same code, same message TEMPLATE.
      expect({ ...unowned, message: (unowned.message as string).replace(theirsPrivateId, 'ID') })
        .toEqual({ ...unknown, message: (unknown.message as string).replace(UNKNOWN_ID, 'ID') });
    });

    it('admits shared stores only, never private ones, when ownerEmail is undefined', async () => {
      // PrepareCtx types ownerEmail as string | undefined. Fail-safe, not fail-open.
      await expect(assertStoresAccessible([theirsSharedId], undefined)).resolves.toBeUndefined();
      await expect(assertStoresAccessible([mineId], undefined))
        .rejects.toBeInstanceOf(ToolRequestError);
    });

    it('rejects an expired store the caller owns, with the 409 the search itself would raise', async () => {
      await expect(assertStoresAccessible([mineExpiredId], MINE))
        .rejects.toBeInstanceOf(StoreExpiredError);
      await expect(assertStoresAccessible([mineExpiredId], MINE))
        .rejects.toMatchObject({ status: 409 });
    });

    it('rejects an expired store even when every other id in the list is fine', async () => {
      await expect(assertStoresAccessible([mineId, theirsSharedId, mineExpiredId], MINE))
        .rejects.toBeInstanceOf(StoreExpiredError);
    });

    it('reports an inaccessible id before an expired one, so the 409 can never become an oracle', async () => {
      // The 409 says "this store exists and is expired". That is only safe once the
      // caller has proved it may read EVERY id in the request; raised earlier it would
      // answer a question the 400 above is deliberately careful not to answer.
      await expect(assertStoresAccessible([theirsPrivateId, mineExpiredId], MINE))
        .rejects.toBeInstanceOf(ToolRequestError);
      await expect(assertStoresAccessible([UNKNOWN_ID, mineExpiredId], MINE))
        .rejects.toMatchObject({ status: 400 });
    });

    it('rejects a dimension-drifted store the caller owns, with the 409 the search itself would raise', async () => {
      await expect(assertStoresAccessible([mineDriftedId], MINE))
        .rejects.toBeInstanceOf(StoreDimensionMismatchError);
      await expect(assertStoresAccessible([mineDriftedId], MINE))
        .rejects.toMatchObject({ status: 409 });
    });

    it('reports an inaccessible id before a drifted one, so that 409 is no more an oracle than the other', async () => {
      await expect(assertStoresAccessible([theirsPrivateId, mineDriftedId], MINE))
        .rejects.toBeInstanceOf(ToolRequestError);
      await expect(assertStoresAccessible([UNKNOWN_ID, mineDriftedId], MINE))
        .rejects.toMatchObject({ status: 400 });
    });

    it.each([
      ['an expired store', () => mineExpiredId],
      ['a dimension-drifted store', () => mineDriftedId],
      ['a store the caller owns outright', () => mineId],
      ['a shared store the caller does not own', () => theirsSharedId],
    ])('agrees with searchVectorStores about whether %s is usable', async (_label, idOf) => {
      // THE property that makes this guard worth having: it must not admit anything the
      // search it fronts would then refuse. Asserted against the real, unmocked
      // searchVectorStores on every axis rather than restated — restating it is exactly
      // how the expired case was missed, and then how the dimension case was missed a
      // second time while the code claimed in a comment that it could not happen.
      //
      // The two "usable" rows are not filler: without them a guard that simply threw for
      // everything would satisfy the two failure rows and still be useless.
      const id = idOf();
      const searchOutcome = await outcomeOf(searchVectorStores({
        storeIds: [id], query: 'anything', ownerEmail: MINE,
      }));
      const guardOutcome = await outcomeOf(assertStoresAccessible([id], MINE));
      expect(guardOutcome).toEqual(searchOutcome);
    });
  });

  describe('fileSearchDescriptor.prepare', () => {
    it('accepts a shared store the caller does not own', async () => {
      await expect(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [theirsSharedId] },
        { ownerEmail: MINE, logger },
      )).resolves.toMatchObject({ storeIds: [theirsSharedId], maxNumResults: 10 });
    });

    it('rejects a store owned by someone else with the SAME 400 as an unknown id, not a 403', async () => {
      const unowned = await failureOf(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [theirsPrivateId] },
        { ownerEmail: MINE, logger }));
      const unknown = await failureOf(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [UNKNOWN_ID] },
        { ownerEmail: MINE, logger }));
      expect(unowned.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect(unowned.code).toBe(unknown.code);
      expect(unowned.name).toBe(unknown.name);
    });

    it('rejects an expired store with a 409 before the turn opens', async () => {
      // Without this, the turn opens and every file_search call fails mid-stream with
      // nothing the caller can see — the same failure a typo'd store id would cause,
      // one field over. Kept as a 409, not folded into the 400: an expired store is a
      // real state the caller can act on, and it is only reachable after the ownership
      // check has passed, so it discloses nothing.
      await expect(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [mineExpiredId] },
        { ownerEmail: MINE, logger },
      )).rejects.toMatchObject({ status: 409, name: 'StoreExpiredError' });
    });

    it('rejects a dimension-drifted store with a 409 before the turn opens', async () => {
      // Missed once already, on the written-down belief that a drifted store still
      // searched fine. It does not: searchVectorStores throws StoreDimensionMismatchError
      // for it, in the same per-store loop as the expiry check.
      await expect(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [mineDriftedId] },
        { ownerEmail: MINE, logger },
      )).rejects.toMatchObject({ status: 409, name: 'StoreDimensionMismatchError' });
    });

    it('prepares a store the caller owns', async () => {
      await expect(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: [mineId], max_num_results: 3 },
        { ownerEmail: MINE, logger },
      )).resolves.toMatchObject({ storeIds: [mineId], maxNumResults: 3 });
    });
  });
});
