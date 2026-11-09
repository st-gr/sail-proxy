# file_search evaluation corpus

`corpus/` is a fixed set of documents for measuring file_search retrieval (recall@k, MRR, nDCG). It is generated
from this repository's own documentation, plus two synthetic Office files about an invented company, so it contains
no user data and needs no downloads; it is committed, so the evaluation runner and CI use it as is and never need
the tools that built it.

## What is in it

Each documentation chapter appears in exactly one file, so every passage has a single correct answer file.

| Kind | Files | How it is made |
|---|---|---|
| `markdown` | `corpus/markdown/*.md` | chapters copied byte for byte |
| `pdf` | `corpus/pdf/*.pdf` | pandoc (Markdown to HTML), printed by headless Chrome; text layer present |
| `table` | `corpus/table/developer-tables.pdf` | the Markdown tables of four developer chapters, each under its heading, printed as above |
| `scanned` | `corpus/scanned/*.pdf` | chapters printed as above, rasterized with `pdftoppm` (150 dpi, grey) and reassembled by ImageMagick as JPEG pages: an image-only PDF without a text layer |
| `pptx` | `corpus/pptx/quillmere-operations-review.pptx` | a 12-slide deck about an invented cold-chain operator (titles, text, two tables, speaker notes, an empty and a hidden slide), written by `build-office-corpus.js` |
| `xlsx` | `corpus/xlsx/quillmere-maintenance-ledger.xlsx` | a workbook about the same invented company (four sheets, one hidden; shared strings, dates, percentages), written by `build-office-corpus.js` |

Images are dropped and links reduced to their text before printing. The chapter lists are at the top of
`build-corpus.js`.

`corpus/manifest.json` lists every file, sorted by `file`:

```json
{ "file": "pdf/user-chapter-12-google-gemini.pdf", "source": "docs/guide/clients/gemini.md",
  "kind": "pdf", "sha256": "…", "bytes": 198420 }
```

`source` is an array for the table PDF, which draws on several chapters, and `ci/file-search-eval/build-office-corpus.js`
for the Office files. Every name, place and figure in the Office files is made up; no passage repeats anything in
the documentation chapters.

The corpus is a snapshot: the chapters in `docs/` keep changing, the corpus changes only when it is rebuilt.
Questions written against it refer to the corpus files, not to `docs/`.

## Check

```bash
node ci/file-search-eval/build-corpus.test.js
```

Runs in CI Phase 2 and needs no tools: every manifest entry exists with its size and sha256, nothing on disk is
unlisted, all six kinds are present, scanned PDFs carry no fonts (no text layer), the Office files are byte for byte
what `build-office-corpus.js` writes, and the corpus stays under 15 MB.

## Rebuild

```bash
node ci/file-search-eval/build-corpus.js
```

Needs `pandoc`, Google Chrome or Chromium (`CHROME_BIN` overrides the path), `pdftoppm` (poppler) and `magick`
(ImageMagick 7); the script names any missing tool and stops. It replaces `corpus/` completely.

The build is deterministic on one machine: the inputs are a fixed list, Chrome prints without header and footer,
and the creation and modification dates (plus any `/ID` and XMP uuids) of every PDF are overwritten in place with
fixed values of the same length. Two consecutive builds are byte-identical. A different pandoc, Chrome, poppler or
ImageMagick version, or different installed fonts, can change the PDFs; rebuild only on purpose, commit the
result together with any questions that depend on it, and keep the corpus under 15 MB.

Built with pandoc 3.10.1, Chrome 155, poppler 26.04 and ImageMagick 7.1.2 on macOS.

The Office files need no tool: `node ci/file-search-eval/build-office-corpus.js` rewrites them and their manifest
entries and leaves the rest of the corpus alone (`build-corpus.js` writes them too). The script builds each file as
a stored (uncompressed) zip with fixed dates, so the bytes are the same on every machine and Node version. The files
hold the parts file_search reads (presentation, slides and notes; workbook, sheets, shared strings and styles), but
not slide masters, layouts or themes, so PowerPoint may refuse to open the deck.

## Questions

`questions.json` holds the evaluation questions. Each one names its corpus file and kind and carries verbatim answer
quotes (at most 300 characters each). A `multihop` question has two quotes from passages far apart in the same file:

```json
{ "id": "q001", "question": "…", "file": "markdown/user-chapter-5-codex.md", "kind": "markdown", "quotes": ["…"] }
```

A retrieved chunk is relevant when it contains any quote of its question. Both sides go through `normalise.js` first:
NFKC, soft hyphens and zero-width characters removed, typographic quotes and dashes folded, lowercase, whitespace
collapsed. The file also records the sha256 of `corpus/manifest.json` it was written against, and the model and date
that generated it.

`generate-questions.js` writes it. It reads every corpus file through the gateway's own extractor (the TypeScript
source, loaded with the gateway's ts-node), so quotes are checked against exactly what ingestion indexes. It asks a
SAP-served chat model for questions window by window, keeps a candidate only when every quote is found in the
normalised text of its file and in no other file, drops near-duplicate questions, and fills the mix in up to three
rounds. Scanned PDFs extract to nothing; their questions come from the source chapter, use plain sentences only, and
were expected to fail until file_search could OCR.

The 20 questions on the Office files (`q146`–`q165`, kinds `pptx` and `xlsx`) were written by hand, since the
generator reads only the documentation corpus; their quotes were checked against the gateway's own reader (in their
file, in no other). `generate-questions.js` replaces the whole file, so re-append them after a regeneration.

```bash
node ci/file-search-eval/generate-questions.js --env <path to services/gateway/.env> \
  [--model gpt-4.1] [--target 150] [--mix markdown=40,pdf=40,table=20,scanned=20,multihop=30] \
  [--max-calls 120] [--max-tokens 1500000] [--rounds 3] [--out ci/file-search-eval/questions.json]
```

It needs `pdftotext` and SAP AI Core credentials (`AUTH_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `SAP_AI_CORE_URL`,
`SAP_AI_RESOURCE_GROUP`) and uses the newest RUNNING orchestration deployment. `--max-calls` caps HTTP requests:
the token request, the deployment list, every completion and every retry. A failed token request stops the run at
once; a 429 waits for its Retry-After (at most 30 s). `--max-tokens` caps the reported usage plus an estimate (four
characters a token) for failed attempts and responses without usage. `--rounds` is how many passes may top up a kind
that is still short. The script prints the counts per kind and the rejection reasons, and replaces `questions.json`
only when the new set passes validation. `--max-calls 0` extracts and plans without any HTTP request.

```bash
node ci/file-search-eval/question-set.test.js   # generator logic with a fake model
node ci/file-search-eval/sap-client.test.js     # SAP client with a fake HTTP layer and clock
node ci/file-search-eval/questions.test.js      # questions.json schema; skipped while the file is absent
```

All three run in CI Phase 2. Regenerate the questions whenever the corpus is rebuilt.

## Evaluation runner

`services/gateway/scripts/file-search-eval.ts` measures retrieval on this corpus with the gateway's own code: it
ingests every corpus file through the real ingestion path (blob and file row as an upload writes them, a file batch,
then the worker's extract, chunk, embed and commit) into a pgvector database, and sends every question through the
real `searchVectorStores` (hybrid recall, reranker) with a named configuration. Embeddings, rerank and the optional
judge are live SAP AI Core calls; nothing runs in CI.

```bash
cd services/gateway
pnpm run eval:file-search -- --env .env --config baseline            # static 800/400 store, shipped search
pnpm run eval:file-search -- --env .env --config text-heavy          # hybrid weights embedding 0.5 / text 1
pnpm run eval:file-search -- --env .env --config embedding-heavy     # hybrid weights embedding 1 / text 0.5
pnpm run eval:file-search -- --env .env --config no-rerank           # reranker off, RRF order
pnpm run eval:file-search -- --env .env --config baseline --judge 20 # plus answer quality on 20 questions
pnpm run eval:file-search -- --env .env --config structure           # structure chunking (its own store)
pnpm run eval:file-search -- --env .env --config contextual          # contextual chunks (its own store)
pnpm run eval:file-search -- --env .env --config parent --judge 40   # parent sections, answer quality
pnpm run eval:file-search -- --env .env --config ocr                 # baseline store, OCR of scanned pages
pnpm run eval:file-search -- --plan --config vision-auto             # the calls and cost, nothing run
pnpm run eval:file-search -- --env .env --config bounded-lexical --keep-db   # W4: full-text bound on the baseline store
pnpm run eval:file-search -- --env .env --config ann --keep-db       # W4: plus approximate search
pnpm run eval:file-search -- --env .env --config vision-auto --allow-vision   # page images to the vision model
pnpm run eval:file-search -- --compare ../../ci/file-search-eval/results/<A>.json ../../ci/file-search-eval/results/<B>.json
```

Options: `--max-usd 5` (default) is the spending ceiling of one run; `--keep-db` keeps the database container for the
next run; `--dsn postgresql://…` uses an existing pgvector database instead; `--limit N` runs the first N questions;
`--judge-model gemini-3.5-flash` (default; `gpt-4.1` is selectable, but its family is due to retire) picks the chat model
of the judge, which needs a price row in `JUDGE_PRICES`; `--verbose` shows the gateway's debug log; `--plan` prints
the configuration's SAP calls and estimated cost per step (ingestion as for a fresh store, the searches, contexts and
vision pages) from the corpus alone and runs nothing; `--allow-vision` is required to run a configuration that sends
page images (`vision-*`).
Configurations are a table at the top of `services/gateway/scripts/fileSearchEval/options.ts`; add one there. The
chunking configurations (`structure`, `contextual`, `contextual-haiku` and their search variants, `parent`) are
described in developer guide chapter 16, "Chunking configurations"; the parsing configurations (`ocr`,
`vision-no_text`, `vision-auto`) in "Parsing configurations".

**Large-search configurations (W4).** The corpus store (about 100 chunks) is far below the shipped
`ann.exact_max_chunks` of 20,000, so `bounded-lexical` and `ann` lower it to 10 (`min_fraction` 0.01) on the baseline
store: `bounded-lexical` measures the full-text bound alone (common words dropped, ranked set capped), `ann` adds the
approximate vector arm. Both change only search, so they reuse the baseline store. They need the halfvec index (a
fresh `fseval` database gets it at migration; a database kept from before W4 keeps its previous index, and every
search then stays exact) and analyzed statistics (autovacuum analyzes the table within about a minute of the
ingestion; before that both stay exact). With `--keep-db`, `idx_scan` of `idx_chunks_hnsw` in `pg_stat_user_indexes`
shows whether the index served searches. On this corpus the share of chunks containing a word is far higher than in
a large store, so `bounded-lexical` drops many more words than a real large search would: read it as an upper bound
of the bound's effect.

**OCR and vision.** The runner sets `FILE_SEARCH_OCR` and `FILE_SEARCH_VISION` itself: `off` unless the
configuration reads scans (`ocr: true`) or page images (`vision`), whatever the shell or a `.env` says, so every
earlier configuration keeps measuring the text layer alone. A configuration with OCR refuses to start where
tesseract with `eng` cannot run (on macOS: `brew install tesseract`); one with vision refuses where poppler or
sharp is missing, and needs `--allow-vision`. Both are part of the store key (`parsing`: OCR's languages, the vision
model and its limits; the vision mode is in the chunking setting).

**Environment.** `--env` names the gateway's `.env`. Only the SAP AI Core credentials (`AUTH_URL`, `CLIENT_ID`,
`CLIENT_SECRET`, `SAP_*`) are taken from it, never printed, and nothing else: no Valkey, admin service or database
URL, so a run cannot touch a running gateway. The runner works in standalone mode with a generated `api_config.json`
holding only the configuration's `file_search` section (empty = the gateway's built-in defaults; for chunking those
are static 800/400 without contexts, while the shipped configuration files set structure with contexts; the runner
writes each store's chunking setting itself, so neither decides a run).

**Database.** Without `--dsn` the runner starts a throwaway container `fseval-pg` (`pgvector/pgvector:pg16-trixie` on
127.0.0.1:55463), or reuses it when an earlier `--keep-db` run left it, and removes it by name at the end unless
`--keep-db`. The schema goes into its own Postgres schema `fseval` via the gateway's migration; a database whose
`public` schema already holds file_search tables is refused. The vector store is keyed by the corpus manifest's
sha256, the pipeline settings (embedding model and dimension, the chunking setting, and for contextual chunks the
context writer's settings and model) and an ingestion fingerprint (a sha256 over
the ingestion path's sources on disk, `INGESTION_SOURCES` in `fileSearchEval/ingest.ts`, plus `INGESTION_VERSION`,
to bump for a behaviour change outside those files): a later run with the same key, any configuration that changes
only search, reuses it and embeds nothing; a run that cannot reuse the latest store logs which part changed. Files an
interrupted run left in progress are processed again; the runner searches only once no file is in progress.

**Results.** Each run writes `ci/file-search-eval/results/<UTC timestamp>-<config>.json` (gitignored): the
configuration, the pipeline settings and store key, the corpus and question hashes, the store's file and chunk
counts, which retrieval mode answered (`reranked`, or `rrf_only` when no reranker deployment ran), the cost, the
metrics, and per question the ranks at which its quotes were found and the search latency. No chunk text, no
credentials. `complete: false` with `stopReasons` marks a partial run (ceiling reached, files failed or still in
progress, repeated search errors); its metrics cover only the questions that ran.

**What the numbers mean.** A returned chunk is relevant when it comes from the question's file and its normalised
text contains one of the question's quotes, or, for a quote cut by a chunk boundary, a contiguous piece of it at least
60% of the quote's normalised length (`fragmentRuleHits` counts the questions whose hit depends on that rule).
Single-passage questions are hits at k when any quote is in the top k; multihop questions only when both are (the
`multihopAnyQuote` line repeats them with "any quote").

- `recall@5/10/20`: share of questions that are hits within the top 5, 10, 20 results.
- `MRR`: mean of 1 / the rank at which a question became a hit (0 when it did not within 20).
- `nDCG@10`: per quote, 1 / log2(r + 1) at the first rank r (up to 10) that covers it, else 0, averaged over the
  question's quotes; 1 means every quote is in the first result (one chunk may hold both quotes of a multihop
  question).
- `byKind`: the same per kind (`markdown`, `pdf`, `table`, `scanned`, `multihop`, `pptx`, `xlsx`). Scanned PDFs have
  no text layer: they score 0 in every configuration that runs without OCR (all but `ocr` and `vision-*`).
- `latencyMs`: p50 and p95 of one `searchVectorStores` call (query embedding, recall, rerank) as the runner sees it.
- `judge` (`--judge N`): for a fixed sample of N questions (ordered by a hash of the id, the same on every run), a
  chat model answers from the top 5 results, and a second call scores faithfulness (claims supported by those
  results) and correctness (agreement with the reference quotes), 1 to 5.

Questions whose search failed are listed with their error and left out of the metrics.

**Corpus size.** The corpus is small: its 16 documentation files made 97 chunks with static 800/400 (the two
Office files add a few more). With the default 50
candidates per arm the reranker sees over half of the corpus for every question, and the top 20 alone cover about 20%
of it, so the absolute numbers are optimistic; a production store is far larger. Compare configurations on this set
rather than reading its levels as what users get. Without OCR the 18 scanned questions stay at 0,
which caps overall recall at 147 / 165 ≈ 0.891 (127 / 145 before the Office questions).

**Cost.** The meter counts embedding tokens (ingestion as each file's job reports them, plus every query), rerank
search units, judge chat tokens, for contextual chunks the context model's input, cached and output tokens (a
price row per context model, `CONTEXT_PRICES`), and for vision the tokens every page call reported (a price row per
vision model, `VISION_PRICES`; the runner attaches the corpus with a placeholder credential and reads the
transcriber's usage events, which standalone mode sends nowhere), priced with conservative constants (`fileSearchEval/costMeter.ts`, public list
prices rounded up; SAP bills in capacity units, so this is an upper-bound estimate). Before every file, question and
chat call it checks that what was spent plus a generous estimate of the step stays under `--max-usd`, and otherwise
stops and writes the partial result. A context, vision or judge model without a price row is refused before the run starts. Before each PDF the vision
estimate is the pages its mode selects (the transcriber's own rule, from pdftotext) at 1,250 input and 4,096 output
tokens a page; flash-lite wrote 323–382 output tokens per page in the live probe.
A file's context estimate counts the prompt in cl100k tokens and is raised by 1.2 (`CONTEXT_TOKENIZER_MARGIN`), since
Gemini and Claude count the same text with their own tokenizers. At the meter's prices ($0.00015 / 1k embedding tokens, $0.0025 a rerank search
unit, $0.0025 / $0.01 per 1k chat input / output tokens) the first baseline run measured 100,460 embedding tokens
(97,107 for ingesting the corpus, 3,353 for the 145 query embeddings), about $0.015. Each configuration then costs
about $0.73 for 145 searches: 290 rerank units ($0.725) plus the query embeddings ($0.0005); `no-rerank` only the
latter. A judged question makes two chat calls of roughly 4,500 input tokens each (five chunks of up to 800 tokens)
and a few hundred output tokens, about $0.03 with `gpt-4.1` and about $0.02 with the default `gemini-3.5-flash`
($0.001 / $0.006 per 1k; estimated, not yet measured).

```bash
cd services/gateway
npx cross-env NODE_ENV=test jest --config jest.config.json test/fileSearch/evalMetrics.test.ts test/fileSearch/evalRunner.test.ts
# the pipeline with a fake embedder (CI runs it with its test database):
FILE_SEARCH_TEST_DSN=postgresql://… npx cross-env NODE_ENV=test jest --config jest.config.json test/fileSearch/integration/evalRunner.test.ts
```

## Scale bench

The corpus above is far too small to show what search costs on large stores. `scripts/file-search-scale.ts` measures
that on synthetic stores instead, without any SAP call: it starts a throwaway `pgvector/pgvector:pg16-trixie`
container `fsscale-pg` on 127.0.0.1:55491 (removed by name at the end and on SIGINT, SIGTERM or SIGALRM unless
`--keep-db`; a leftover container is reused only when a `--keep-db` run left it; `--dsn` uses another database), applies the gateway's own schema migration to a Postgres schema `fsscale`, and loads one store per
`--stores` entry into one table by `generate_series`, with every chunk index dropped during the load and rebuilt
after it.

```bash
cd services/gateway
pnpm run bench:file-search-scale -- --dims 1536 --words 200 --lexical --index vector:64:serial --keep-db --out r1.json
# the same load is reused by a later --keep-db run, so further index configurations only build and measure:
pnpm run bench:file-search-scale -- --dims 1536 --words 200 --index halfvec:200:serial,halfvec:200:parallel --keep-db
```

- **Data.** `--vectors clustered` (default): each vector mixes a shared direction, a main and a secondary topic out of
  256 centroids and two of 4,096 noise vectors, so chunks of one topic are close and unrelated chunks are not, as
  with real embeddings; every store draws from every topic. `--vectors random`: independent Gaussian vectors, the
  worst case for an HNSW graph. Chunk text is `--words` words drawn from a Zipf-like distribution over 50,000 words
  (`lx1` the most frequent), so the full-text arm meets terms of every frequency. `--tenants` (default 200) adds
  that many stores of 100 chunks that are not measured: with only a handful of stores in the table, Postgres
  estimates a store as a large share of it and reads the whole table even for a small store, which is not what
  an install with many stores sees.
- **Queries.** Per store, `--queries` vectors of the same kind as the data that are not stored (`in`) and as many
  random vectors (`off`, off-topic for clustered stores).
- **Vector arm.** The exact path (today's recall shape, from `cli-tools/file-search-recall-probe.js`) is timed once
  per load and kept as the truth. For each `--index` configuration (`vector` or `halfvec` expression index,
  `ef_construction`, `serial` build with `max_parallel_maintenance_workers = 0` or `parallel` with 2 workers, at
  `--maintenance-work-mem`) the bench reports the build time, index size and pgvector's notices (an index that
  outgrows `maintenance_work_mem` continues on disk, much slower), then the ANN path of the probe for every query:
  tie-aware recall@`--limit` against the truth, the distance gap (how much farther the ANN rows are than the
  exact ones: a miss among almost equidistant chunks has a gap near 0), under-returned answers, and the latency
  with and without the exact re-run that follows an answer of fewer than `--limit` rows.
- **Insert cost.** `--insert` chunks ingested in statements of 100 rows, without an HNSW index and with each
  configuration's index.
- **Full-text arm** (`--lexical`, on the largest store). Five questions (a term in half of the chunks with two rare
  ones, three common terms, 32 terms, three rare terms, no match), each as the OR arm of a search over at most
  `exact_max_chunks` chunks, without the lexemes that `pg_stats` gives a share above each `--theta`, ranking a
  bounded set (every chunk with all the terms plus at most `--ceiling` other matches; a list measures several),
  and both — `--theta 0.05` with `--ceiling 5000` is what a larger search runs; with the latency (first run and p50/p95 of five more), whether the AND query alone would already have found
  `--limit` chunks, and the tie-aware overlap with today's top `--limit`.

The tables print to stdout; `--out` writes every number as JSON. To bound a run, exec node directly so the
signal reaches the bench (through `pnpm run` it reaches only pnpm):
`perl -e 'alarm 1800; exec @ARGV' node node_modules/ts-node/dist/bin.js -r tsconfig-paths/register --transpile-only
scripts/file-search-scale.ts …`. Run one bench at a time and keep 1536-dimension
loads to a few hundred thousand chunks on a laptop-sized Docker VM. The pure parts are tested by
`test/fileSearch/scaleBench.test.ts`.

## Licence

The corpus consists of this repository's own documentation and is covered by the same licence as the repository.
