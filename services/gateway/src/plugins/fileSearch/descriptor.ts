/**
 * The hosted `file_search` tool, expressed as a `HostedToolDescriptor`.
 *
 * Same trick as `webSearch/descriptor.ts`: SAP AI Core deployments reject hosted tool
 * types outright, so the gateway rewrites the hosted `{ "type": "file_search", ... }`
 * entry into a plain function tool the deployment accepts, runs the retrieval itself
 * against this deployment's own vector stores, and hands the client back the hosted-tool
 * response shape. All the transport machinery lives in `hostedTool/engine.ts`.
 *
 * THE MASKING BOUNDARY IS THE WHOLE POINT OF THE CALL SIDE BELOW. The gateway's own
 * retrieval stack (Postgres, the embedder, the reranker, the query rewriter — all SAP AI
 * Core, all this tenant's own infrastructure) sees RAW text; the generative deployment
 * never does. That gives every result TWO renderings, and conflating them either leaks a
 * document to the model or shows a document's own owner placeholders for their own file:
 *
 *   renderOutput   -> function_call_output -> the deployment  ->  MASKED
 *   renderCallItem -> file_search_call.results -> the client   ->  RAW
 *
 * and the query an inverted asymmetry from web_search's, because the direction of travel
 * is reversed — web_search sends the query OUT to a third party, file_search brings it IN
 * to our own corpus:
 *
 *   non-streaming: the query arrives RAW    (pseudonymizationPlugin's after handler, at
 *                                            index 0, already unmasked it) -> use as-is
 *   streaming:     the query arrives MASKED (the interceptor sits behind pseudonymization's
 *                                            res.write and reads bytes still in flight)
 *                                            -> unmask before searching
 *
 * Implemented backwards, this searches a raw corpus for `MASKED_PERSON_3` and returns
 * ZERO HITS rather than throwing — indistinguishable from an empty store, in the one part
 * of the flow that (see `prepare` below) can no longer tell the caller anything.
 *
 * `ctx.remask` is deliberately NOT called anywhere here, which is the one place this
 * descriptor departs from `ToolExecCtx.remask`'s "call this on any text you send off-box"
 * instruction. Nothing file_search sends leaves the tenant: the query goes to the
 * gateway's own database and this deployment's own embedding/rerank models, whose whole
 * job is to match it against a corpus that is stored raw. Re-masking it there would
 * search for placeholder tokens that appear in no document. The text that DOES reach a
 * generative model — the chunk contents in `renderOutput` — is masked instead by
 * `maskThroughRequestMap`, which is strictly stronger: `remask` can only replay pairs the
 * request body already minted, and a retrieved chunk was never in the request body.
 *
 * Registered by `plugins/responsesFileSearchPlugin.ts`, whose two hook entries
 * (`defaultHooks.openai.responses` / `responses-stream`, gated on `tools:hasFileSearch`)
 * are what make any of this reachable at runtime.
 *
 * VERIFIED LIVE (2026-08-04), because this deployment has rejected two earlier
 * assumptions of exactly this kind with an HTTP 400 while every mocked test stayed
 * green (`input_type`, and the query rewriter's `gpt-35-turbo-16k` model id): the
 * function tool `rewriteTool` returns below was POSTed verbatim in `tools` to
 * `{deploymentUrl}/responses` on this tenant for both `gpt-5.3-codex` and `gpt-5.4`.
 * Both returned HTTP 200 with a `function_call` named `file_search` carrying a
 * `{"query": ...}` argument object. Adding `strict: false` (as
 * `RESPONSES_WEB_SEARCH_TOOL` carries) or `additionalProperties: false` was also
 * accepted; neither is needed, so neither is sent.
 *
 * @see ../hostedTool/descriptor.ts - the interface and what each hook owes the engine
 * @see ../webSearch/descriptor.ts - the reference implementation
 */
import {
  AnnotateMessageCtx, HostedToolDescriptor, ParsedCall, PrepareCtx, RenderCallItemOpts,
  ToolExecCtx, ToolExecResult,
} from '../hostedTool/descriptor';
import { buildCitations } from './citations';
import { syntheticId } from '../hostedTool/syntheticId';
import {
  assertStoresAccessible, RecallInputError, StoreDimensionMismatchError, StoreExpiredError,
  ToolRequestError,
} from '../../fileSearch/repository';
import {
  searchVectorStores, SearchHit, SearchStoreNotFoundError, SearchQueryTooLongError,
} from '../../fileSearch/search';
import { RerankerUnavailableError } from '../../fileSearch/reranker';
import { unmaskText } from '../pseudonymization/unmasker';
import { maskThroughRequestMap } from './chunkMasking';
import configService, { MIN_RESULTS_DEFAULT, MAX_RESULTS_DEFAULT } from '../../services/configService';

/** What `prepare()` returns and `execute()` receives as `ctx.prepared`. */
export interface PreparedFileSearch {
  storeIds: string[];
  maxNumResults: number;
  /** An OpenAI-style attribute filter AST, or undefined. Compiled (and hardened)
   *  by `fileSearch/filterCompiler.ts` at search time, never here. */
  filters: any | undefined;
  /** The caller's `ranking_options` in its ORIGINAL snake_case wire shape, e.g.
   *  `{ score_threshold: 0.4 }` — deliberately not normalised here, so what prepare()
   *  froze is recognisably what the caller sent. `execute` converts it; see
   *  `toSearchRankingOptions`, and note that handing this object straight to
   *  `searchVectorStores` (whose `SearchOptions.rankingOptions` is `{ scoreThreshold }`)
   *  type-checks against `any` and silently drops the threshold. */
  rankingOptions: any | undefined;
}

/** One result in the OpenAI `file_search_call.results` wire shape. */
interface FileSearchResult {
  file_id: string;
  filename: string;
  score: number;
  attributes: Record<string, unknown>;
  text: string;
}

/**
 * What `execute()` puts in `ToolExecResult.payload`.
 *
 * BOTH renderings are materialised HERE, in execute, rather than derived later by the
 * render hooks, for a structural reason: `renderOutput(r)` is handed the result and
 * nothing else — no `ctx`, so no ReplacementMap — and masking is precisely the step that
 * needs the live map. Carrying the map inside the payload just to mask at render time
 * would put a mutable request-scoped object into a value the engine copies around.
 *
 * So `hits` is the RAW retrieval (client-facing; `renderCallItem` / `renderResultMessage`
 * read it) and `maskedResults` is the already-masked, already-wire-shaped list the
 * deployment gets (`renderOutput` reads it, and only it). The masking side-effect —
 * extending the live map — therefore happens once, at search time, which is before either
 * the continuation POST or the first client-facing frame.
 */
interface FileSearchPayload {
  hits: SearchHit[];
  maskedResults: FileSearchResult[];
  /** The queries actually run, in the form the CLIENT is owed: unmasked. */
  queries: string[];
}

/**
 * The rewritten tool the deployment actually sees. A fresh object per call, like
 * `webSearch`'s: the engine puts this straight into `body.tools`, where downstream
 * plugins are free to mutate it.
 *
 * The hosted tool's own fields (`vector_store_ids`, `max_num_results`, `filters`,
 * `ranking_options`) are deliberately NOT projected into the function schema. They are
 * the CALLER's configuration of the search, captured once by `prepare()` below; letting
 * the model restate them per call would let it widen its own retrieval scope.
 */
function buildFileSearchFunctionTool(): any {
  return {
    type: 'function',
    name: 'file_search',
    description: "Search the user's uploaded documents for passages relevant to a query.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
      },
      required: ['query'],
    },
  };
}

/** The model's `arguments` string, parsed. Never throws — `parseCall`'s contract is that
 *  bad JSON yields empty args, because a malformed call still owes the turn an output. */
function parseQueryFromArguments(rawArguments: unknown): string {
  if (typeof rawArguments !== 'string') return '';
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed?.query === 'string' ? parsed.query : '';
  } catch {
    return '';
  }
}

/**
 * Translate the caller's `ranking_options` into the shape `searchVectorStores` reads.
 *
 * NOT a pass-through, and this is the whole reason the function exists. `prepare()` freezes
 * `ranking_options` in the caller's own snake_case (`{ score_threshold: 0.4 }`, pinned by
 * Task 6's suite), while `SearchOptions.rankingOptions` is `{ scoreThreshold?: number }`.
 * `SearchOptions.rankingOptions` is a typed field but `PreparedFileSearch.rankingOptions`
 * is `any`, so handing one straight to the other compiles, runs, and drops the threshold
 * on the floor — search.ts reads `opts.rankingOptions?.scoreThreshold`, finds undefined,
 * and skips the filter. The caller asked for results above 0.4 and silently gets all of
 * them. Nothing anywhere would fail.
 *
 * Returns undefined rather than `{ scoreThreshold: undefined }` when no usable threshold
 * was given (including `ranking_options: { ranker: 'auto' }`), so the un-thresholded case
 * is one value and not two.
 */
function toSearchRankingOptions(raw: any): { scoreThreshold?: number } | undefined {
  const threshold = raw?.score_threshold;
  return typeof threshold === 'number' && Number.isFinite(threshold)
    ? { scoreThreshold: threshold }
    : undefined;
}

/** A hit's chunk text. `SearchHit.content` is a parts array, always text parts today. */
function textOf(hit: SearchHit): string {
  if (!Array.isArray(hit?.content)) return '';
  return hit.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/**
 * Project hits into the OpenAI `file_search_call.results` wire shape, passing each chunk's
 * text through `renderText`.
 *
 * `renderText` is the entire masking decision, made once by the caller: the deployment-bound
 * projection passes `maskThroughRequestMap`, the client-bound one passes the text through
 * unchanged. Two call sites, opposite arguments, no default — a projection that silently
 * defaulted to "unchanged" would leak documents to the model the first time someone forgot.
 */
function toWireResults(hits: SearchHit[], renderText: (text: string) => string): FileSearchResult[] {
  return (hits || []).map((hit) => ({
    file_id: hit.fileId,
    filename: hit.filename,
    score: hit.score,
    attributes: hit.attributes,
    text: renderText(textOf(hit)),
  }));
}

/** The payload of a result that actually ran. `failedResult` in the engine builds results
 *  with a null payload (a call the per-request cap refused, or one whose descriptor threw),
 *  and every render hook below has to survive one. */
function payloadOf(r: ToolExecResult): FileSearchPayload | undefined {
  const p = r?.payload;
  return p && Array.isArray(p.hits) ? p as FileSearchPayload : undefined;
}

/** The queries to show the client, falling back to the call's own argument for a result
 *  that never ran and therefore has no payload. */
function queriesOf(r: ToolExecResult): string[] {
  const payload = payloadOf(r);
  if (payload) return payload.queries;
  const query = r?.call?.args?.query;
  return typeof query === 'string' && query.length > 0 ? [query] : [];
}

/**
 * Which failure this was, in a token the model can be told without it meaning anything to
 * an attacker. `store_not_found` is reachable here even though `prepare()` already checked
 * every id: a store can be deleted or expire between the turn opening and a call running.
 */
function errorCodeFor(error: any): string {
  if (error instanceof SearchStoreNotFoundError) return 'store_not_found';
  if (error instanceof SearchQueryTooLongError) return 'query_too_long';
  return 'file_search_unavailable';
}

/**
 * The self-authored error classes whose `message` this module is allowed to log or carry
 * on a result. Everything else — a `pg` `DatabaseError` above all — has a message written
 * by someone else, and those messages quote the input that offended them.
 *
 * THIS LIST IS A PROMISE ABOUT EVERY `new`-SITE OF EVERY CLASS ON IT, including the ones
 * in other modules, and adding a class here is an assertion that none of them interpolates
 * caller-controlled text. That is a real obligation and it has already been broken once:
 * `RecallInputError` was added here while `repository.ts` was building its message from
 * `compileFilter`, whose unsupported-operator error quoted the caller's `type` field
 * verbatim, so PII in an operator name reached the log line below THROUGH an allow-listed
 * class. Fixed at the source (`filterCompiler.ts`'s `UNSUPPORTED_TYPE_MESSAGE`), which is
 * the only place it can be fixed — the gate cannot inspect a message it has decided to
 * trust.
 *
 * Audited at the time of writing: every `new`-site of these seven carries a fixed string, a
 * bounded number (a length, a dimension, a limit), a field name, or a store id. Store ids
 * are caller-supplied but are treated as loggable throughout this feature by deliberate
 * decision, as identifiers rather than content.
 *
 * `RerankerUnavailableError` (reranker.ts) added deliberately, not by omission: it has
 * exactly one `new`-site, its message is the fixed string 'No RUNNING SAP AI Core reranker
 * deployment was found for file_search', and that site interpolates nothing — not the
 * query, not a document, not an id. Confirmed by reading that site at the time this class
 * was added; re-audit it if a second `new RerankerUnavailableError(...)` call ever appears.
 *
 * @see safeErrorMessage, and the audit note at the `execute` catch below.
 */
const LOGGABLE_MESSAGE_CLASSES: ReadonlyArray<new (...args: any[]) => Error> = [
  SearchQueryTooLongError, SearchStoreNotFoundError, RecallInputError,
  StoreExpiredError, StoreDimensionMismatchError, ToolRequestError, RerankerUnavailableError,
];

/**
 * `error.message`, but only when it came from one of this stack's OWN throwers. For
 * anything else the caller gets the code alone: the message is not ours, we cannot make a
 * claim about what it interpolates, and the observed case interpolates caller data.
 *
 * NOT a sanitizer. This decides WHOSE message may be logged, never WHAT is in it — for an
 * allow-listed class it returns the message unread. Keeping caller text out of those
 * messages is the throwing module's job; see LOGGABLE_MESSAGE_CLASSES above.
 */
function safeErrorMessage(error: any): string | undefined {
  return LOGGABLE_MESSAGE_CLASSES.some((cls) => error instanceof cls)
    ? error?.message
    : undefined;
}

/** A call that could not be served. Still a well-formed result: the turn owes every
 *  `function_call` a `function_call_output`, or the deployment rejects it outright. */
function failedSearch(
  call: ParsedCall, queries: string[], code: string, message: string,
): ToolExecResult {
  return {
    call,
    status: 'failed',
    payload: { hits: [], maskedResults: [], queries } as FileSearchPayload,
    error: { message, code },
  };
}

/**
 * A human-readable dump of the passages, for the paths where no continuation will ever
 * deliver the model's own answer. Client-facing, so the text is RAW.
 *
 * DELIBERATELY UNCAPPED, and the bound is already elsewhere: `maxNumResults` is enforced
 * at 1..`MAX_RESULTS_DEFAULT` (50) by `prepare()` and clamped again by `searchVectorStores`,
 * and each passage is one chunk, itself bounded by the ingest chunker. So this is at worst
 * 50 chunks — the same 50 the client would have received under
 * `include: ["file_search_call.results"]` anyway, of documents it already owns. Truncating
 * here would only hide passages the model was told about from the one path where the client
 * never gets the model's summary. `webSearch`'s `buildSearchMessageItem`, the equivalent
 * hook, has no cap either.
 */
function formatResultsText(r: ToolExecResult): string {
  const queries = queriesOf(r);
  const asked = queries.length > 0 ? ` for "${queries.join('", "')}"` : '';
  if (r.status === 'failed') {
    if (r.error?.code === 'not_retained') {
      return `The passages from an earlier search${asked} are no longer available in this session.`;
    }
    return `The document search${asked} could not be completed.`;
  }
  const hits = payloadOf(r)?.hits ?? [];
  if (hits.length === 0) {
    return `No passages in your documents matched the search${asked}.`;
  }
  const passages = hits.map((hit, i) =>
    `${i + 1}. ${hit.filename} (score ${hit.score.toFixed(3)})\n${textOf(hit)}`).join('\n\n');
  return `Found ${hits.length} passage(s) in your documents${asked}:\n\n${passages}`;
}

// A caller's per-request `max_num_results` is bounded by exactly the range
// `configService.resolveMaxNumResultsDefault` clamps the CONFIGURED default into —
// `MIN_RESULTS_DEFAULT`/`MAX_RESULTS_DEFAULT`, imported rather than restated, so the
// bound has one definition. Enforced here rather than clamped, though: clamping
// `max_num_results: 0` up to 1 would quietly serve a request the caller did not make,
// and prepare() is the last place the caller can still be told.

export const fileSearchDescriptor: HostedToolDescriptor = {
  type: 'file_search',
  // Captured from a real OpenAI file_search turn, 2026-08-06 — see
  // docs/notes/openai-parity-capture-2026-08-06.md for the exact sequence.
  emitsCallLifecycleFrames: true,
  functionName: 'file_search',

  rewriteTool: (_hosted: any) => buildFileSearchFunctionTool(),

  /**
   * Validate the caller's tool configuration BEFORE the turn opens, and freeze it for
   * every call this request makes.
   *
   * This is the only honest moment in the flow. Once the response stream is live, a
   * typo'd `vector_store_id` is indistinguishable from an empty corpus — both are "no
   * passages found" — so anything not rejected here is never reported at all.
   *
   * Every throw below therefore carries an HTTP `status`, which is what the engine reads
   * to fail the request with it (`hostedTool/engine.ts`, `rejectionStatusOf`) rather than
   * degrade past it. An error WITHOUT a status is infrastructure and is deliberately
   * survivable — `assertStoresAccessible` raises a bare `Error` when the pool is null, and
   * that one still leaves the turn open with `ctx.prepared === undefined`.
   */
  prepare: async (hosted: any, ctx: PrepareCtx): Promise<PreparedFileSearch> => {
    const ids: string[] = Array.isArray(hosted?.vector_store_ids) ? hosted.vector_store_ids : [];
    if (ids.length === 0) {
      // Covers a missing, non-array and literally empty `vector_store_ids`. A
      // file_search with nothing to search is a caller mistake, not a search that
      // legitimately finds nothing.
      throw new ToolRequestError('file_search requires a non-empty vector_store_ids array.');
    }

    // No caller identity (an AWS SigV4 request carries no email) means no search is
    // possible — `execute` refuses one, and `recallCandidates` rejects an empty ownerEmail
    // outright beneath it. Rejected HERE too, and this is the only place it can be
    // reported: admitting it would open a turn in which every single call fails, with a
    // reason the streaming path has no way to surface. That is the exact
    // opens-then-fails-mid-stream shape the expiry and dimension gates below exist to
    // prevent, one column over.
    //
    // This sits strictly ABOVE `assertStoresAccessible` rather than changing it.
    // The primitive deliberately ADMITS an undefined owner — the predicate then matches
    // shared stores only, which is fail-safe, and its doc comment says so — and it keeps
    // that behaviour for every other caller. This guard is a policy the file_search TOOL
    // makes about its own turn: a turn that can only ever fail is not worth opening.
    if (typeof ctx.ownerEmail !== 'string' || ctx.ownerEmail.length === 0) {
      throw new ToolRequestError('file_search requires an authenticated caller identity.');
    }

    // Throws ToolRequestError (400) naming the first inaccessible id, or a 409
    // (StoreExpiredError / StoreDimensionMismatchError) for an accessible store the
    // search itself would refuse — every pre-condition searchVectorStores enforces,
    // checked while the caller can still be told.
    // An unknown id and a store owned by someone else produce the SAME 400
    // deliberately: a distinct status would turn the response into an oracle for which
    // store ids exist. See repository.ts's own note on that, and searchVectorStores'
    // matching "404, never 403" choice.
    await assertStoresAccessible(ids, ctx.ownerEmail);

    const toolCfg = configService.getFileSearchToolConfig();
    const requested = hosted.max_num_results;
    if (requested !== undefined && requested !== null
        && (typeof requested !== 'number' || !Number.isInteger(requested)
            || requested < MIN_RESULTS_DEFAULT || requested > MAX_RESULTS_DEFAULT)) {
      throw new ToolRequestError(
        `file_search max_num_results must be an integer between ${MIN_RESULTS_DEFAULT} and ${MAX_RESULTS_DEFAULT}.`);
    }

    // Store ids are not user content and are safe to log; the QUERY is user content and
    // is never logged at info or above anywhere in file_search — note nothing here
    // touches it, because at prepare() time no query exists yet.
    ctx.logger.info(
      `Prepared the file_search tool over ${ids.length} vector store(s): ${ids.join(', ')}`);

    return {
      storeIds: ids,
      maxNumResults: requested ?? toolCfg.maxNumResultsDefault,
      filters: hosted.filters,
      rankingOptions: hosted.ranking_options,
    };
  },

  parseCall: (callId: string, rawArguments: string): ParsedCall => ({
    callId,
    rawArguments,
    args: { query: parseQueryFromArguments(rawArguments) },
  }),

  /**
   * Run one search and materialise BOTH renderings of its results. See this module's
   * header for the masking boundary and the query asymmetry; the two guards below are
   * the parts that are easy to get subtly, silently wrong.
   */
  execute: async (call: ParsedCall, ctx: ToolExecCtx): Promise<ToolExecResult> => {
    const query: string = typeof call.args?.query === 'string' ? call.args.query : '';

    // The query arrives MASKED on the streaming path and RAW on the non-streaming one —
    // see the header. Both branches must exist: unmasking on both corrupts nothing but
    // is wrong for a non-streaming query that happens to contain residue tokens, and
    // unmasking on neither searches a raw corpus for `MASKED_PERSON_3` and finds nothing,
    // which is indistinguishable from an empty store rather than being an error.
    const searchQuery = ctx.isStreaming && ctx.replacementMap
      ? unmaskText(query, ctx.replacementMap)
      : query;

    const prepared = ctx.prepared as PreparedFileSearch | undefined;

    // NO FALLBACK TO THE REQUEST BODY HERE, EVER. `prepare()` is the only thing that
    // validates a `vector_store_id` against the caller's ownership. The engine now REJECTS
    // the request outright when prepare() throws something carrying an HTTP `status` (every
    // caller-facing error it raises does), but it still degrades past an INFRASTRUCTURE
    // failure — `new Error('file_search database is not configured')` when the pool is null
    // — leaving `ctx.prepared === undefined` and this call reachable. Reading
    // `vector_store_ids` off the body as a stand-in would turn that degrade into a search
    // against an unvalidated store id: a tenant-isolation break, reachable by anyone who
    // can make the database unavailable. Unprepared means we do not search. Full stop.
    if (!prepared || !Array.isArray(prepared.storeIds) || prepared.storeIds.length === 0) {
      ctx.logger.warn(
        `file_search call ${call.callId} ran without a prepared configuration; refusing to search`);
      return failedSearch(call, [searchQuery], 'file_search_not_prepared',
        'file_search was not prepared for this request');
    }

    // The BELT; `prepare()` above is the braces, and rejects an absent owner before the
    // turn opens, where the caller can still be told. This is unreachable through the
    // normal flow — but `prepare()` throwing is exactly the case the engine swallows, and
    // "unreachable" plus "swallowed" is how a search runs with a NULL owner.
    //
    // `SearchOptions.ownerEmail` is `string`, `ToolExecCtx.ownerEmail` is
    // `string | undefined` (an AWS SigV4 request carries no email). Letting undefined flow
    // in would issue the ownership query with a NULL owner — which happens to be fail-safe
    // (`owner_email = NULL` is never true, so only shared stores match) and would then
    // fail deeper down in `recallCandidates`, which rejects an empty ownerEmail outright.
    // Refused explicitly here instead: the boundary should not depend on SQL's NULL
    // semantics staying convenient, and the failure should name its own cause.
    const ownerEmail = ctx.ownerEmail;
    if (typeof ownerEmail !== 'string' || ownerEmail.length === 0) {
      ctx.logger.warn(
        `file_search call ${call.callId} has no caller identity; refusing to search`);
      return failedSearch(call, [searchQuery], 'file_search_no_owner',
        'file_search requires an authenticated caller identity');
    }

    try {
      const response = await searchVectorStores({
        storeIds: prepared.storeIds,
        ownerEmail,
        query: searchQuery,
        // The caller configured the search once, in the hosted tool entry; the model does
        // not get to restate it per call. `rewriteQuery: false` is explicit rather than
        // left to config: the model has already turned the user's turn into a search
        // query, and rewriting that a second time drifts it further from what was asked.
        rewriteQuery: false,
        maxNumResults: prepared.maxNumResults,
        filters: prepared.filters,
        rankingOptions: toSearchRankingOptions(prepared.rankingOptions),
      });

      const hits = response.data || [];
      return {
        call,
        status: 'completed',
        payload: {
          hits,
          // Masked HERE, while the live ReplacementMap is still in reach, and before
          // either the continuation POST or the first client-facing frame. Extending the
          // map is the point: whatever placeholder we mint for a passage is what the model
          // will quote back, and the client is owed the real text when it does.
          // `ctx.maskingConfig` — the request's OWN resolved config, not the plugin's base
          // set. It is what carries the caller's `custom_entities`, and a chunk masked
          // without it ships exactly the identifiers the caller flagged as sensitive
          // straight to the deployment. See chunkMasking.ts's header.
          maskedResults: toWireResults(
            hits, (text) => maskThroughRequestMap(text, ctx.replacementMap, ctx.maskingConfig)),
          queries: [searchQuery],
        } as FileSearchPayload,
      };
    } catch (error: any) {
      const code = errorCodeFor(error);
      // Neither the query nor any chunk text is ever logged, at any level: both are user
      // content. The call id, the code and the error's class name are not.
      //
      // `error.message` is NOT logged unconditionally, and the earlier version of this
      // comment claiming it could be was wrong. It audited only this stack's own throwers
      // — SearchQueryTooLongError reports a length, SearchStoreNotFoundError a store id,
      // RecallInputError a field name, StoreExpiredError / StoreDimensionMismatchError a
      // store id and a dimension — and omitted the one class nobody here wrote: `pg`'s
      // DatabaseError, which `recallCandidates` rethrows (repository.ts) and which lands
      // in this very catch. Its messages quote the input that offended Postgres:
      //   [22P02] invalid input syntax for type numeric: "Jane Doe, MRN 4471"
      // reproduced live from an ordinal filter given a non-numeric `value`. `body.filters`
      // is never walked by pseudonymization, so that string is the caller's, unmasked.
      // (`filterCompiler.assertOrdinalValue` now rejects that particular filter at 400,
      // but the gate below is what makes the LOG line safe for whatever the next
      // unaudited thrower turns out to be.)
      //
      // So: the code and the class name always; the message only from a class this stack
      // authored. `safeErrorMessage` is the single decision point for WHOSE message is
      // logged — used both here and for the message carried on the result.
      //
      // It is NOT a guarantee about what those messages contain, and an earlier version of
      // this comment claimed a completeness the allow-list does not have. Allow-listing a
      // class whose message interpolates caller input reopens the hole through the gate:
      // `RecallInputError` did exactly that, carrying the caller's filter `type` verbatim
      // out of `compileFilter`, and no amount of care on this line could have caught it.
      // The two halves have to hold together — see LOGGABLE_MESSAGE_CLASSES' own note.
      const message = safeErrorMessage(error);
      ctx.logger.warn(
        `file_search call ${call.callId} failed${ctx.isStreaming ? ' mid-stream' : ''}: ${code}`
        + ` (${error?.name}${message ? `: ${message}` : ''})`);
      return failedSearch(call, [searchQuery], code, message ?? 'file_search failed');
    }
  },

  /**
   * MASKED. This is the item the continuation POST carries back to the generative
   * deployment, so it is the one place a retrieved document leaves the tenant.
   * `payload.maskedResults` — never `payload.hits`.
   */
  renderOutput: (r: ToolExecResult): any => {
    const payload = payloadOf(r);
    const output = r.status === 'failed' || !payload
      ? {
        error: (r.error?.code === 'cap_reached')
          ? {
            code: 'cap_reached',
            message: 'The document-search budget for this turn is used up. Answer using the '
                   + 'passages you already have. Do not tell the user the search returned nothing.',
          }
          : (r.error?.code === 'not_retained')
          ? {
            code: 'not_retained',
            message: 'The passages from this earlier search are no longer retained. Do not '
                   + 'describe them as empty — they existed. If you need them, search again now; '
                   + 'otherwise answer from what the conversation already records.',
          }
          : {
            code: r.error?.code ?? 'file_search_unavailable',
            message: 'The document search could not be completed. Tell the user you were unable '
                   + 'to search their documents. Do not tell the user the search returned nothing.',
          },
      }
      : { results: payload.maskedResults };
    return { type: 'function_call_output', call_id: r.call.callId, output: JSON.stringify(output) };
  },

  /**
   * RAW. The client owns these documents; showing their owner placeholders for their own
   * file would be a bug, not a safeguard. `results` only under
   * `include: ["file_search_call.results"]`, matching OpenAI, which omits the field
   * entirely otherwise.
   */
  renderCallItem: (r: ToolExecResult, opts: RenderCallItemOpts): any => ({
    id: syntheticId('fs'),
    type: 'file_search_call',
    status: r.status === 'failed' ? 'failed' : 'completed',
    queries: queriesOf(r),
    ...(opts?.includeResults
      ? { results: toWireResults(payloadOf(r)?.hits ?? [], (text) => text) }
      : {}),
  }),

  /** Also RAW, and also client-facing: used only on the paths where no continuation can
   *  deliver the model's own answer, so the passages themselves are all the client gets. */
  renderResultMessage: (r: ToolExecResult): any => ({
    type: 'message',
    id: syntheticId('msg'),
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: formatResultsText(r), annotations: [] }],
  }),

  /**
   * `file_citation` annotations on the assistant message the model wrote FROM these
   * results. This is what makes the parity matrix's "file_citation annotations: Exact" true
   * rather than aspirational; `citations.ts` does the anchoring, this is its only consumer.
   *
   * ANNOTATIONS ONLY. `buildCitations` hands back both an unmasked `text` and the offsets
   * into it, and only the offsets are used. On the streaming path the copy returned below is
   * written into a frame that has yet to pass through the unmasker, so emitting `cited.text`
   * on it would hand unmasked bytes to a pipeline whose remaining stages assume masked ones.
   * Mutating `item` itself would be worse, and in the other direction: the ENGINE's copy is
   * what `history` carries into the next continuation POST, so the address would leave the
   * tenant entirely. (The annotated copy returned here never enters `history` — the engine
   * rebuilds that from its own originals.) The offsets are integers; nothing downstream
   * rewrites them, so they land on exactly the words they were computed against.
   *
   * HITS COME THROUGH `payloadOf`, NEVER OFF `payload`. `ToolExecResult.payload` is `any`,
   * so `r.payload.maskedResults` compiles here and would anchor on the rendering the
   * DEPLOYMENT saw — whose passages agree with the message only until it is unmasked. The
   * result is not an error but zero citations for precisely the documents that contained an
   * entity. See citations.ts's header; `payloadOf` is what closes it.
   *
   * Hits accumulate across the request in call order, and a failed call contributes an
   * empty `hits`, so nothing here has to know which round retrieved what.
   */
  annotateMessage: (item: any, results: ToolExecResult[], ctx: AnnotateMessageCtx): any => {
    const part = item?.content?.[0];
    const text = part?.text;
    if (typeof text !== 'string' || text.length === 0) return item;

    const hits: SearchHit[] = (results || []).flatMap((r) => payloadOf(r)?.hits ?? []);
    if (hits.length === 0) return item;

    const { annotations } = buildCitations(text, hits, ctx?.replacementMap);
    if (annotations.length === 0) return item;

    // A new item, and a new content array. `item` is the object the engine keeps and
    // rebuilds `history` from, so an in-place edit — and only an in-place edit — would put
    // these annotations, and one careless edit later the unmasked text they came with, into
    // the next continuation POST's body. The engine cannot detect that; not doing it is the
    // whole guarantee.
    const existing = Array.isArray(part.annotations) ? part.annotations : [];
    return {
      ...item,
      content: [{ ...part, annotations: [...existing, ...annotations] }, ...item.content.slice(1)],
    };
  },

  /** The client's item carries `queries: string[]`; the function tool takes one `query`. */
  replayQueryFrom: (item: any): string => {
    const queries = Array.isArray(item?.queries) ? item.queries : [];
    return typeof queries[0] === 'string' ? queries[0] : '';
  },

  /**
   * Cache the retrieved documents, not the rendering. `maskedResults` is what one request's
   * model was shown; it is re-derived on every replay and must never be stored.
   */
  cachePayloadFrom: (payload: unknown): unknown => {
    const p: any = payload;
    return { hits: Array.isArray(p?.hits) ? p.hits : [], queries: Array.isArray(p?.queries) ? p.queries : [] };
  },

  /**
   * Mask afresh from the raw hits, using the replaying request's own map and config.
   * Cached masked text must never be replayed verbatim: under `anonymization` the
   * placeholders are per-request counters, so request A's `MASKED_PERSON_3` denotes
   * something else entirely in request B.
   */
  rehydratePayload: (cachedPayload: unknown, ctx: ToolExecCtx): unknown => {
    const cached: any = cachedPayload;
    const hits: SearchHit[] = Array.isArray(cached?.hits) ? cached.hits : [];
    return {
      hits,
      maskedResults: toWireResults(
        hits, (text) => maskThroughRequestMap(text, ctx.replacementMap, ctx.maskingConfig)),
      queries: Array.isArray(cached?.queries) ? cached.queries : [],
    };
  },

  maxCallsPerRequest: () => configService.getFileSearchToolConfig().maxSearchesPerRequest,
};
