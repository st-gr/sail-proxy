/**
 * THE LIVE ACCEPTANCE GATE for the hosted `file_search` tool.
 *
 * Everything below runs against real infrastructure: a real pgvector database
 * (`FILE_SEARCH_TEST_DSN`), the tenant's real embedding deployment, and — when
 * one is reachable — the tenant's real reranker. Nothing is mocked. Off by
 * default; a plain `npm test` never opens a socket because of this file.
 *
 * A SEPARATE FILE, deliberately, for exactly the reason
 * `integration/embedder.test.ts` gives at its own head: the mocked suites for
 * this feature (`test/responses-filesearch-stream.test.ts`,
 * `test/hosted-tool-both-tools.test.ts`, `test/filesearch-citations-wiring.
 * test.ts`) do `jest.mock('axios')`, `jest.mock('../src/fileSearch/search')`
 * and `jest.mock('../src/services/configService')` at module scope, and Jest
 * module mocks are FILE-scoped. There is no way for a `describe` block inside
 * one of those files to see the real network and the real config while its
 * siblings keep their mocks.
 *
 * WHY IT EXISTS. Every mocked test in this feature encodes an assumption about
 * a response shape or a deployment's tolerance, and this feature has had two
 * such assumptions turn out false against the real tenant while every mocked
 * test stayed green — orchestration rejecting `input_type` with HTTP 400, and
 * the query rewriter's model id rejected the same way. A retrieval stack is
 * worse than most: its failure mode is an empty result page, not an exception.
 *
 * WHICH RETRIEVAL MODE, AND WHY THE GATE SAYS SO OUT LOUD.
 * `hybrid.rerank.enabled` defaults to `'auto'`, which degrades to the
 * database's own RRF ordering whenever no reranker deployment is discoverable
 * — silently, by design, because a reranker outage must not fail a search. A
 * green gate that never reports which path it took is therefore compatible
 * with stage 2 of a two-stage pipeline never having run at all. So this suite
 * asserts `SearchResponse.mode` is one of the two known values, prints it, and
 * — when `FILE_SEARCH_LIVE_GATE` is set to `reranked` rather than to any other
 * truthy value — REQUIRES that stage 2 actually answered.
 *
 * WHAT IT DOES NOT DO: call a generative deployment. The turn below runs
 * without `req.__responsesUpstream`, which is the engine's documented
 * no-continuation path — the tool runs, the client-facing `file_search_call`
 * item and the formatted result dump are produced, and no second deployment
 * call is made. That is deliberate: the transport half (continuation POSTs,
 * frame splicing, index/sequence shifting, citation offsets) is pinned
 * exhaustively by the mocked suites named above, against fixtures that are
 * cheap and deterministic. What a mock cannot prove is the RETRIEVAL half —
 * that a real embedding lands in a real pgvector column of the configured
 * dimension, that the reranker deployment still speaks the shape
 * `reranker.ts` parses, and that the real config resolves to a working model
 * id. That is what this gate is for.
 *
 * IT ALSO COVERS FILE BATCHES, END TO END. The last test in this file starts
 * from bytes rather than from chunks: a real blob, `createBatch` stamping real
 * membership, and the real ingest worker running the REAL extractor and the
 * REAL embedder over every member until the batch reaches a terminal status —
 * then searching for each member's content to prove it is actually there.
 * `test/fileSearch/integration/batchPollContract.test.ts` pins the poll
 * contract against a real database with those two mocked, which is the one
 * thing it cannot show. Note that a batch whose members all failed to embed
 * ALSO settles — as `completed`, with the damage in `file_counts.failed` and
 * nothing thrown — so the search at the end is the assertion that matters.
 *
 * RUNNING IT:
 *
 *   export FILE_SEARCH_TEST_DSN="postgresql://postgres:test@127.0.0.1:55432/filesearch_test"
 *   export FILE_SEARCH_LIVE_GATE=1          # or =reranked to require stage 2
 *   npx jest --config jest.config.json test/fileSearch/integration/fileSearchToolLive.test.ts
 *
 * You do NOT need to source `services/gateway/.env` yourself — this file loads it, see
 * below. Sourcing it in a shell is in fact unreliable: CLIENT_ID's value contains a `!`,
 * which zsh splits on, so `. ./.env` leaves the credential half-set and the failure then
 * looks like a tenant problem rather than a shell one.
 *
 * @see ../../../src/fileSearch/search.ts - `SearchResponse.mode`, and the two stages
 * @see ../../responses-filesearch-stream.test.ts - the mocked transport parity suite
 */
import * as crypto from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Jest does not load `.env`: jest.config.json has no `setupFiles`, and the only
// `dotenv/config` import in the tree is `src/index.ts`, which no test pulls in. Without
// this the gate arms, reaches embed(), and dies on "No SAP AI Core orchestration
// deployment available" — because CLIENT_ID / CLIENT_SECRET / AUTH_URL /
// SAP_AI_AUTO_DISCOVER_DEPLOYMENT are simply absent from process.env. That reads as a
// tenant or credential fault when nothing is wrong with either.
// `override: false` so an explicitly exported value still wins over the file.
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: false });

import { Pool } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { embed } from '../../../src/fileSearch/embedder';
import { searchVectorStores } from '../../../src/fileSearch/search';
import { hostedToolBeforeHandler, hostedToolAfterHandler } from '../../../src/plugins/hostedTool/engine';
import { getFileSearchConfig } from '../../../src/services/configService';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch, batchStatusAndCounts } from '../../../src/fileSearch/batches';
import { claimNext, processOne } from '../../../src/fileSearch/ingestWorker';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

// Imported for its side effect: registering `fileSearchDescriptor` on the hosted-tool
// registry. The engine is descriptor-driven, so without this the registry is empty,
// `descriptorForHostedTool` returns undefined, the hosted `file_search` entry is never
// rewritten into a function tool, and the turn test fails with ['file_search'] where it
// expects ['function'] — a harness gap that reads exactly like a rewrite bug. Production
// registers through the plugin loader; this file drives the engine directly, so it must
// do it itself.
import '../../../src/plugins/responsesFileSearchPlugin';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const LIVE_GATE = process.env.FILE_SEARCH_LIVE_GATE;
/** `FILE_SEARCH_LIVE_GATE=reranked` turns "report the mode" into "require stage 2". */
const REQUIRE_RERANKED = LIVE_GATE === 'reranked';

const live = LIVE_GATE && DSN ? describe : describe.skip;

if (!LIVE_GATE || !DSN) {
  // LOUDLY, the same way the DSN-gated suites in this directory and
  // embedder.test.ts announce theirs. A silent skip here turns a green run
  // into one that has verified nothing at all about the live retrieval stack,
  // and this branch has already had two people read a smaller green number as
  // a pass.
  // eslint-disable-next-line no-console
  console.warn(
    '[fileSearchToolLive.test.ts] SKIPPED — '
    + (!LIVE_GATE ? 'FILE_SEARCH_LIVE_GATE is not set. ' : '')
    + (!DSN ? 'FILE_SEARCH_TEST_DSN is not set. ' : '')
    + 'The file_search tool is NOT verified against the live tenant by this run: no real '
    + 'embedding, no real reranker, no real pgvector query. Only the mocked assumptions in '
    + 'test/responses-filesearch-stream.test.ts and its siblings are covered.',
  );
}

const OWNER = `live-gate-${crypto.randomBytes(4).toString('hex')}@corp.example`;

/** A three-passage handbook. Only ONE of them answers the question the gate asks,
 *  so "the top hit is the right passage" is a claim about ranking and not about
 *  the corpus having a single row in it. */
const PASSAGES = [
  'Expense claims must be submitted within thirty calendar days of the trip; '
  + 'claims filed later than that require written approval from a director.',
  'The office in Walldorf is open from 07:00 to 19:00 on weekdays and is closed '
  + 'on public holidays observed in Baden-Wurttemberg.',
  'Parental leave is granted for up to fourteen months and may be shared between '
  + 'both parents in any split they agree on.',
];
const QUESTION = 'how long do I have to submit an expense claim';
/** The passage the question is about — index 0 of `PASSAGES`. */
const EXPECTED = PASSAGES[0];

live('the file_search tool against the live tenant', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let storeId: string;

  beforeAll(async () => {
    // The REAL configured dimension, not a test constant: a schema built at 3
    // while the tenant embeds at 1536 fails at INSERT with a dimension error
    // and would look like a broken gate rather than a broken configuration.
    const dim = getFileSearchConfig().embeddingDimensions;
    fixture = await createIsolatedSchema(DSN!, dim);

    // repository.ts and search.ts both reach the database through
    // src/fileSearch/db.ts's getPool() singleton, which builds its own Pool
    // from this env var rather than accepting one — point it at the isolated
    // schema the same way the other suites in this directory do.
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;

    storeId = `vs_live_${crypto.randomBytes(6).toString('hex')}`;
    const fileId = `file_live_${crypto.randomBytes(6).toString('hex')}`;
    const sha = crypto.createHash('sha256').update(PASSAGES.join('\n')).digest('hex');

    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes)
       VALUES ($1, $2, 'text/markdown', 1, 'db', $3)`,
      [sha, Buffer.byteLength(PASSAGES.join('\n')), Buffer.from(PASSAGES.join('\n'))],
    );
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, $2, 'handbook.md', 'assistants', $3, $4)`,
      [fileId, OWNER, sha, Buffer.byteLength(PASSAGES.join('\n'))],
    );
    await pool.query(
      `INSERT INTO vector_stores (id, owner_email, name, status, embedding_model, embedding_dim)
       VALUES ($1, $2, 'live gate handbook', 'completed', $3, $4)`,
      [storeId, OWNER, getFileSearchConfig().embeddingModel, dim],
    );
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, status)
       VALUES ($1, $2, '{"dept":"finance"}'::jsonb, 'completed')`,
      [storeId, fileId],
    );

    // THE REAL EMBEDDER. If the tenant rejects this call the gate fails here,
    // in beforeAll, with the tenant's own message — which is the point.
    const { vectors } = await embed(PASSAGES, 'document');
    expect(vectors).toHaveLength(PASSAGES.length);
    expect(vectors[0]).toHaveLength(dim);

    for (let i = 0; i < PASSAGES.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, tokens, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [storeId, fileId, i, PASSAGES[i], PASSAGES[i].split(/\s+/).length, JSON.stringify(vectors[i])],
      );
    }
  }, 120_000);

  afterAll(async () => {
    __resetForTests();
    if (pool) await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    if (fixture) await fixture.teardown();
  });

  it('retrieves the right passage and REPORTS which retrieval mode it exercised', async () => {
    const response = await searchVectorStores({
      storeIds: [storeId],
      ownerEmail: OWNER,
      query: QUESTION,
      maxNumResults: 3,
    });

    // "auto" lets a green gate skip stage 2 entirely, so the mode is asserted
    // and printed rather than assumed.
    expect(['reranked', 'rrf_only']).toContain(response.mode);
    // eslint-disable-next-line no-console
    console.log(`[live gate] retrieval mode exercised: ${response.mode}`);
    if (response.mode === 'rrf_only') {
      // eslint-disable-next-line no-console
      console.warn(
        '[live gate] STAGE 2 DID NOT RUN. `hybrid.rerank.enabled` resolved to no reachable '
        + 'reranker deployment, so this run exercised hybrid recall + RRF fusion only — the '
        + 'cross-encoder half of the pipeline is UNVERIFIED. Re-run with '
        + 'FILE_SEARCH_LIVE_GATE=reranked to make that a failure instead of a warning.',
      );
    }
    if (REQUIRE_RERANKED) expect(response.mode).toBe('reranked');

    // Real hits, and the RIGHT one first: three passages went in, only one
    // answers the question.
    expect(response.data.length).toBeGreaterThan(0);
    expect(response.data[0].content[0].text).toBe(EXPECTED);
    expect(response.data[0].filename).toBe('handbook.md');
    expect(response.data[0].attributes).toEqual({ dept: 'finance' });
    expect(typeof response.data[0].score).toBe('number');
  }, 120_000);

  it('completes a real turn: the tool runs and the client gets a file_search_call carrying the passage', async () => {
    // No `__responsesUpstream`, so no continuation is possible and no generative
    // deployment is called — see this file's header. Everything up to that point
    // is the production path: the real before handler rewrites the hosted tool
    // and runs the descriptor's `prepare()` (which validates the store against
    // this caller), and the real after handler runs the descriptor's `execute()`
    // against the live retrieval stack.
    const utils = { logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} } };
    const req: any = {
      headers: {},
      apiKeyInfo: { email: OWNER },
      body: {
        model: 'gpt-5.4--deployed',
        stream: false,
        input: QUESTION,
        tools: [{ type: 'file_search', vector_store_ids: [storeId] }],
        // OpenAI's own raw-results token, named after the OUTPUT ITEM
        // (`file_search_call`) rather than after the tool — see the GATE_KEY
        // note in test/responses-filesearch-stream.test.ts.
        include: ['file_search_call.results'],
      },
    };
    const res: any = { headersSent: false, status: () => res, json: () => res, setHeader: () => {} };

    const before = await hostedToolBeforeHandler({ req, res, utils } as any);
    expect(before.stop).toBe(false);
    // prepare() accepted the store, and the hosted entry became a function tool.
    expect(req.body.tools.map((t: any) => t.type)).toEqual(['function']);

    const merged = await hostedToolAfterHandler({
      req,
      res,
      utils,
      upstreamResponse: {
        id: 'resp_live_1',
        status: 'completed',
        output: [{
          type: 'function_call', id: 'fc_live', call_id: 'call_live',
          name: 'file_search', arguments: JSON.stringify({ query: QUESTION }),
        }],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    } as any);

    expect(merged.output.some((i: any) => i.type === 'file_search_call')).toBe(true);
    expect(merged.output.some((i: any) => i.type === 'function_call')).toBe(false);

    const call = merged.output.find((i: any) => i.type === 'file_search_call');
    expect(call.status).toBe('completed');
    expect(call.queries).toEqual([QUESTION]);
    // DOCUMENTS ACTUALLY CAME BACK. A retrieval failure here is an empty page,
    // not an exception, so "the turn completed" would prove nothing on its own.
    expect(call.results.length).toBeGreaterThan(0);
    expect(call.results[0].text).toBe(EXPECTED);

    // With no continuation the descriptor's result dump is the client's only
    // view of what the tool produced — it must actually carry the passage.
    const dump = merged.output.find((i: any) => i.type === 'message');
    expect(dump.content[0].text).toContain(EXPECTED);
  }, 120_000);

  // -------------------------------------------------------------------------
  // FILE BATCHES, end to end, through the real ingestion pipeline.
  //
  // The two tests above start from chunks this file inserted itself, with one
  // direct `embed()` call — deliberately, because what they exist to prove is
  // the RETRIEVAL half. This one starts from BYTES: a real blob, a real
  // `fs_files` row, `createBatch` stamping real `vector_store_files`
  // membership, and the real ingest worker running the real extractor and the
  // real embedder over every member until the batch settles.
  //
  // That is the half no mocked batch suite can reach.
  // `test/fileSearch/integration/batchPollContract.test.ts` pins the poll
  // contract against a real database, but with `extractText` and `embed`
  // mocked; it therefore cannot show that a batch ingested through the tenant's
  // actual embedding deployment reaches `completed` with its content genuinely
  // searchable. A batch whose members all failed to embed also reaches a
  // terminal status — `completed`, with the damage recorded in
  // `file_counts.failed` and nothing thrown anywhere — so "the batch settled"
  // is not on its own evidence that anything worked. The search at the end is.
  // -------------------------------------------------------------------------

  /** Two documents with no vocabulary in common, so a hit on one cannot be the
   *  other's chunk: "both are searchable" is a claim about both members having
   *  been ingested, not about the batch having ingested something. */
  const BATCH_DOCS: Array<{ filename: string; text: string; question: string; needle: string }> = [
    {
      filename: 'security-policy.md',
      text: 'Laptops issued to field engineers must be encrypted with full-disk encryption before they '
        + 'leave the building, and a lost device must be reported to the security desk within four hours.',
      question: 'what must field engineers do before taking a laptop out of the building',
      // A phrase, not a prefix: the chunker may split or normalise whitespace,
      // and a prefix assertion would then fail for a reason that has nothing
      // to do with the tenant.
      needle: 'full-disk encryption',
    },
    {
      filename: 'canteen-menu.md',
      text: 'The canteen serves a warm vegetarian lunch every Tuesday and Thursday, and the salad bar is '
        + 'available all week between eleven thirty and fourteen hundred.',
      question: 'on which days is the vegetarian lunch served in the canteen',
      needle: 'vegetarian lunch every Tuesday',
    },
  ];

  it('ingests a real file batch end to end and makes every member searchable', async () => {
    // A store of its own, created through `repo.createStore` so its
    // `embedding_model` / `embedding_dim` are pinned from the live
    // configuration exactly as a real `POST /vector_stores` would pin them.
    const store = await repo.createStore({ ownerEmail: OWNER, name: 'live gate batch' });

    const fileIds: string[] = [];
    for (const doc of BATCH_DOCS) {
      const bytes = Buffer.from(doc.text, 'utf8');
      const sha = sha256Of(bytes);
      // eslint-disable-next-line no-await-in-loop
      await retainBlob(sha, bytes, 'text/markdown');
      const fileId = newFileId();
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
         VALUES ($1, $2, $3, 'assistants', $4, $5)`,
        [fileId, OWNER, doc.filename, sha, bytes.length],
      );
      fileIds.push(fileId);
    }

    const batch = await createBatch(store.id, fileIds, { source: 'live-gate' }, null);

    // Polls exactly as OpenAI's `fileBatches.createAndPoll` does — read, stop
    // on any status that is not `in_progress` — and drains one member per
    // iteration in place of wall-clock time. THE INVARIANT THE HELPER RESTS ON
    // is asserted on every poll and not only the last: a terminal status is
    // what makes `createAndPoll` hand the caller back a store it has promised
    // is ready, so it must never be reported while a member is still running.
    const observed: string[] = [];
    for (let poll = 0; poll < BATCH_DOCS.length * 4 + 4; poll += 1) {
      // eslint-disable-next-line no-await-in-loop
      const state = await batchStatusAndCounts(store.id, batch.id);
      expect(state).not.toBeNull();
      observed.push(state!.status);
      const c = state!.file_counts;
      expect(c.in_progress + c.completed + c.failed + c.cancelled).toBe(c.total);
      if (state!.status !== 'in_progress') {
        expect(c.in_progress).toBe(0);
        break;
      }
      // One worker cycle, exactly as `runLoop` performs it. The REAL extractor
      // and the REAL embedder run here; a tenant that rejects the ingestion
      // embedding call fails this test with the tenant's own message.
      // eslint-disable-next-line no-await-in-loop
      const job = await claimNext();
      expect(job).not.toBeNull();
      // eslint-disable-next-line no-await-in-loop
      await processOne(job!.storeId, job!.fileId);
    }

    // The batch was genuinely observed mid-flight before it settled, so the
    // per-poll assertions above were not vacuous.
    expect(observed.filter((s) => s === 'in_progress').length).toBe(BATCH_DOCS.length);
    expect(observed[observed.length - 1]).toBe('completed');

    const settled = (await batchStatusAndCounts(store.id, batch.id))!;
    // `failed` here is what a rejected embeddings call looks like — the batch
    // still reports `completed`, because a batch is a unit of work SUBMITTED.
    // Asserting the counts rather than the status is what makes that visible.
    expect(settled.file_counts).toEqual({
      in_progress: 0, completed: BATCH_DOCS.length, failed: 0, cancelled: 0, total: BATCH_DOCS.length,
    });

    // AND THE CONTENT IS ACTUALLY THERE. Each document is retrieved by a
    // question only that document answers, through the live retrieval stack.
    for (const doc of BATCH_DOCS) {
      // eslint-disable-next-line no-await-in-loop
      const response = await searchVectorStores({
        storeIds: [store.id],
        ownerEmail: OWNER,
        query: doc.question,
        maxNumResults: 3,
      });
      expect(['reranked', 'rrf_only']).toContain(response.mode);
      if (REQUIRE_RERANKED) expect(response.mode).toBe('reranked');
      expect(response.data.length).toBeGreaterThan(0);
      expect(response.data[0].filename).toBe(doc.filename);
      expect(response.data[0].content[0].text).toContain(doc.needle);
      // The batch's attributes were applied to every member it attached.
      expect(response.data[0].attributes).toEqual({ source: 'live-gate' });
    }
  }, 300_000);
});
