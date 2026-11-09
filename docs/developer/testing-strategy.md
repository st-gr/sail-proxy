---
title: Testing strategy
description: Which suites exist, what each proves, and how CI runs them.
---

# Testing Strategy

## Testing Philosophy

Every service tests itself with Jest; there are no custom test runners for the service suites.

1. **Follow service boundaries.** The gateway's suites test the gateway, the admin's suites test the admin service, and so on.
2. **Use the shared test utilities** in `libs/test-utils/` (see below) instead of re-implementing environment set-up, port handling or live-model names.
3. **Keep the categories apart:**
   - Unit tests: individual functions or classes in isolation
   - Integration tests: component interactions within a service
   - HTTP tests: API endpoints with real requests (the admin's `test/integration/http/` suites run through `cds.test`)
4. **Name suites after what they prove.** A file name and its `describe` blocks should tell a reader which behaviour broke when the suite fails.

Keep the following in mind when writing tests:

* Test code should be simple and straightforward.
* Keep the scope of the tests focused, so a failing test points at the problem area directly.
* Test behaviour, not implementation. Do not write tests for implementation details that should be hidden from callers.
* Test the public interface for all possible inputs:
  - Test that correct values are returned.
  - Test that correct side effects are carried out.
  - When calling other code that has side effects, assert that the correct parameters are passed in and that the number of invocations is correct.
  - When calling other code that has no side effects, mock its result values; tests for that code belong elsewhere.
* Write tests in the form given/when/then. For example:

```typescript
describe('header rule matching', () => {
  it('matches a content type that carries a charset', () => {
    // Given a hook rule that expects application/json
    const expected = 'application/json';

    // When a client sends the media type with a charset parameter
    const matched = headerValueMatches('application/json; charset=utf-8', expected);

    // Then the rule matches
    expect(matched).toBe(true);
  });
});
```

(The comments are there for illustration.)

* If writing tests is hard, the design may need simplification.
* If too many objects need to be mocked, the code may be too tightly coupled.
* Write tests first where it makes sense; this is a judgement call.

## Test Directory Structure

| Service | Location | Notes |
|---|---|---|
| Gateway | `services/gateway/test/` | Jest roots `test/` and `src/`, `*.test.ts`; `test/setupTests.ts` runs before every suite. Subfolders `clients/`, `config/`, `integration/`, `unit/`, `fileSearch/`, `realtime/`, `pseudonymization-precision/` and `fixtures/`; most suites sit directly in `test/`, named after the feature they cover. |
| Admin | `services/admin/test/` | `unit/` (with `services/`, `srv/`, `config/`, `entities/`, `i18n/`, `utils/`, `ci/`), `integration/` (with `http/` and `services/`), `security/`, `cli-tools/`, `fixtures/`, `__mocks__/`, and `bruno/`, a Bruno collection for manual API calls. |
| Admin UI5 apps | `services/admin/app/<app>/test/` and `services/admin/app/<app>/webapp/test/integration/` | Jest unit tests for app logic; OPA5 journeys (see [UI Journeys](#ui-journeys-opa5-in-ci)). |
| Shared libraries | `libs/test-utils/test/` | The test utilities' own tests. |
| CI scripts | `ci/scripts/*.test.js` | Node tests for the pipeline helpers. |

### Selected gateway suites (`services/gateway/test/`)

- `test/tool-governance-identity.test.ts` — the identity strings and the pattern regex (`^(function|hosted|mcp):([^*\s]+\*?|\*)$`), including the bare namespace wildcard `function:*`
- `test/tool-governance-evaluate.test.ts` — pure evaluation: allow/deny precedence, the two-policy merge (most restrictive wins), a `tool_choice` forcing a stripped tool, fail-open with no policy block
- `test/tool-governance-adapters-anthropic-openai.test.ts`, `test/tool-governance-adapters-responses-gemini.test.ts` — one suite per pair of adapters: declared tools, the forced tool, strip leaving the rest of the body intact, invoked tools from a non-streaming response and from an accumulated stream
- `test/tool-governance-scoped-allow.test.ts` — the scoped-vs-global pattern rule, `deniedBy` with scoped allows (a server-limited policy leaves the rest of the caller's tools alone, `mcp:<server>/*` is unlimited, deny still wins), and `serverLimit`/`evaluate` narrowing a bare server declaration to `monitored`/`stripped`/`rejected` per mode and per a prefix vs. named-tools scoped allow
- `test/tool-governance-narrowing.test.ts` — the Responses and Anthropic adapters rendering `EvaluationResult.narrow` into a bare server declaration (`allowed_tools`, and the Anthropic `mcp_toolset`'s `default_config`/`configs`), including the client-already-narrowed intersection, the deprecated no-toolset shape left untouched, and the middleware narrowing a bare declaration end to end
- `test/tool-governance-middleware.test.ts` — monitor leaves the request untouched, strip mutates `req.body`, reject returns each family's own 403 shape, a malformed policy block or an adapter throw fails open
- `test/tool-governance-wiring.test.ts` — the middleware is mounted on all four routes, after authentication and before quota enforcement; the Bedrock router governs tools after both authentications (unified/SigV4, then service auth) and before quota enforcement, and its controller records invoked tools for both a complete and a streamed response
- `test/tool-governance-result-sources.test.ts` — each adapter's `resultSources`: pairing a result with the call that produced it per family (OpenAI chat `tool`/legacy `function` messages, Responses `function_call_output`/`custom_tool_call_output`/`mcp_call`/hosted `*_call`, Anthropic `tool_result`/`mcp_tool_result`/hosted `*_tool_result`, Gemini `functionResponse`), and a result whose call is missing from the body falling back to `UNKNOWN_SOURCE`
- `test/tool-governance-trust-chain.test.ts` — the trust step in `evaluate()`: no taint changes nothing, strip/monitor/reject each denying the sensitive tools with reason `trust_chain`, a mixed refusal naming both reasons, label union across the user and key blocks, a forced tool_choice on a withheld tool turning strip into reject, an older admin's block (no labels) never tainting, an ordinary policy denial still carrying reason `policy`, the strip notice naming the sources, and `policyBlocksFromRequest` keeping label lists
- `test/tool-governance-trust-wiring.test.ts` — the middleware and the call gate end to end: strip removes the sensitive tool after an untrusted result and names the source in the notice and the event; the usage fold records `reason` and the `source` entries; a mixed reject names both reasons; no untrusted result taints nothing; a nested call inside a replayed container call counts as a source and the gate then refuses a nested sensitive call; the same call passes without the taint; under Monitor (trust chain or a plain policy deny) the gate passes the nested call but still records it `detected`
- `test/tool-governance-bedrock-adapter.test.ts` — the Bedrock adapter: Converse declares/forces/strips/notes and pairs `toolResult`↔`toolUse` for `resultSources`; an Anthropic-shaped invoke body delegates to the Anthropic adapter and any other invoke body declares nothing; invoked tools read from a Converse response and from native stream events, with the stream parser's placeholder tool ignored; a strip that would empty an already-tool-using Converse conversation is refused instead of stripped; a reject through the middleware answers with Bedrock's own 403 `AccessDeniedException` shape
- `test/tool-governance-stream-tap.test.ts` — `tapStreamedTools`: tool-start frames are recorded from written chunks and every write still reaches the client unaltered; an ungoverned request or a scan error leaves the write alone; a native and an Anthropic-shaped tool-start frame are reassembled correctly when split across two or three writes, including a split inside the `data:` prefix; a frame that arrives whole is not double-counted when the following write starts a new line; 70 KiB with no newline never throws, and a following tool-start frame is still recorded
- `test/realtime/relay-transform.test.ts` — the relay's client hook as a transform: forwarding a replacement instead of the original, dropping a frame with a reply to the client and nothing forwarded upstream, sending a `thenUpstream` frame after the forwarded one in order, a throwing hook forwarding the original, binary frames passing untouched when the hook returns nothing, and the handle's own `sendUpstream`/`sendClient`
- `test/realtime/realtime-tool-gate.test.ts` — `createRealtimeToolGate`: declarations — strip removes a denied tool and appends the notice to the frame's own `instructions` (and leaves them untouched when the frame carries none), reject drops the frame and answers with the Realtime error event, `response.create` is judged the same way as `session.update`, monitor and non-tool frames are left alone; the trust chain in a session — strip forwards the result and follows it with a corrective `session.update` that withholds the sensitive tool, reject refuses the result, monitor changes nothing but still records the source, and a result for an unknown call counts as `<unknown>`
- `test/realtime/realtime-tools.test.ts` — the realtime relay's frame parsing: declared tools read off `session.update`, invoked tools off `response.done`
- `test/sap-rpt-controller.test.ts` — the SAP-RPT controller: a 200 relayed byte-for-byte with headers (marking `res.locals.sapRelay`), a `--deployed` request resolved identically to its bare twin, cells billed against the resolved twin, a deep-context call accounted on the `--deep-context` id, SAP's 422/400 relayed verbatim and billing nothing, 404/403 in the SAP shape for an unknown or unentitled model (without marking it a SAP relay), 502 when the deployment cannot be reached, and `executeBeforePlugins`/`executeAfterPlugins` never called
- `test/sap-rpt-usage.test.ts` — the cell fold from `metadata` (`cellsFromResponse`), the `--deep-context` id `accountedModel` produces only for a `context_mode: "deep"` response (stripped of `--deployed` first), and `rptError`'s envelope shape
- `test/sap-rpt-routes.test.ts` — auth then quota then the controller, an OpenAI-shaped 401 from auth and the real `quotaEnforcement` 429 (no `message`) both reshaped into the SAP shape (the 429's `msg` composed from its fields, the original fields preserved on `detail[0].quota`), a relayed upstream 401 from SAP itself left untouched via `res.locals.sapRelay`, `predict-parquet` routed to its own handler, and tool governance never mounted on this route

### Selected admin suites (`services/admin/test/`)

- `test/unit/services/usage-counters.test.ts` — bucket folding, upsert, window derivation, rebuild from rows (watermarks, AWS attribution, retention)
- `test/unit/usage-event-processor-counters.test.ts` — the processor's buckets land with the rows in one transaction (real SQLite)
- `test/unit/services/cost-recalculation-rebuild.test.ts` — the daily recalculation rebuilds the buckets and republishes on every run, and a rebuild failure leaves its own counts intact
- `test/unit/services/cost-recalculation-schedule.test.ts` — when that run happens: 5 minutes after startup and every 24 hours from then, or at `platform.maintenance.dailyRunAtUtc` each day, re-armed on a configuration activation
- `test/unit/services/tool-policy-service.test.ts` — admin: pattern validation, the single default policy, the effective block a validation response carries for a user and for a key
- `test/unit/services/tool-trust-labels.test.ts` — admin: `validatePolicyWrite` accepting valid sensitive/untrusted patterns and rejecting malformed ones, and `recordToolUsage` writing `reason` on the raw row and rolling trust-chain hits into `ToolUsageDaily.trustChained`
- `test/unit/services/tool-usage-service.test.ts` — admin: the daily aggregate upsert arithmetic and the retention boundaries read from `platform.toolGovernance.retention`
- `test/integration/http/tool-policy-validation.test.ts` — admin, cds.test HTTP: the pattern syntax and mode rejected with 400, the default policy's `isDefault` fixed
- `test/integration/http/tool-policies-odata.test.ts` — admin, cds.test HTTP: the ToolPolicies OData surface, the assignment actions, the ToolInventory day-range projection, and creating a policy with sensitive tools and untrusted sources (refusing a malformed untrusted pattern, cascading their deletion with the policy)
- `test/unit/services/sap-rpt-pricing.test.ts` — admin: `pricingTwins` tries the exact id, then a deep-context id's bare model, then the `--deployed` twins; `deriveDeepContextRows` adds one pricing-only row per large SAP-RPT model (none for the small ones), always as `accessType: 'deployment'` regardless of the parent's own accessType, clamps the derived `displayName` to 100 characters, and mirrors the parent's `absent` flag
- `test/integration/http/users-odata.test.ts` (`usageUnits` describe block) — admin, cds.test HTTP: `usageUnits()` lists the models whose usage is counted in cells, from a seeded `unit: 'cells'` `ApiKeyUsage` row
- `services/admin/app/model-library-app/test/costDisplay.test.ts` — Model Library detail's cost math and display: `capacityUnitsPerMillion`, `operandsBracket`, `costRows` (including the manual-price and image/audio cost factor rows), and `costUnitLabel`, which labels SAP-RPT models' cost per 1K cells and everything else per 1K tokens

## Shared Test Utilities (`libs/test-utils/`)

The package `@sap-llm-gateway/test-utils` is built from `libs/test-utils/src/` (the gateway's `pretest` scripts build it first) and imported in the suites as `@libs/test-utils`. It exports:

| Export | Purpose |
|---|---|
| `getGatewayUrl()`, `getAdminServiceUrl()`, `getOllamaServiceUrl()`, `getTestServiceUrls()` | service URLs from `GATEWAY_URL`, `ADMIN_SERVICE_URL` and `OLLAMA_SERVICE_URL`, with local defaults |
| `describeLive` | `describe` when `ADMIN_SERVICE_URL` is set, `describe.skip` otherwise (see [Live-server suites](#live-server-suites)) |
| `guardActiveConfiguration()` | restores the configuration that was active before a suite that activates one against a live admin |
| `liveModels` | the SAP AI Core model names the live-call tests use, by role (`cheapChat`, `vision`, `reasoning`, `claude`, `gemini`, `nova`, `mistral`, `embedding`, `deployedTwin`); `cli-tools/check-test-models.js` checks them and may rewrite this one file |
| `getAvailablePort()`, `getAvailablePorts()`, `isPortAvailable()` | free ports for test servers |
| `pinEphemeralServersToLoopback()`, `withLoopbackHost()` | bind port-0 test servers to `127.0.0.1`, so they never collide with listeners on other interfaces |
| `TestHelpers.delay()`, `TestHelpers.waitForCondition()` | waiting helpers |

## Running Tests

**Root level:**

```bash
pnpm test                      # the gateway suites (pnpm test = test:gateway)
pnpm test:all                  # every workspace package's test script
pnpm test:gateway              # gateway suites
pnpm test:admin                # admin suites
pnpm test:ollama               # ollama suites

pnpm test:gateway:unit         # gateway test/clients and test/config only
pnpm test:gateway:integration  # gateway test/integration
pnpm test:gateway:usage        # gateway suites matching "usage-tracking"
pnpm test:admin:unit           # admin test/unit
pnpm test:admin:integration    # admin test/integration
pnpm test:admin:http           # admin test/integration/http

pnpm test:watch                # gateway in watch mode
pnpm test:coverage             # coverage in every package that defines it
```

**Service level** (from `services/gateway` or `services/admin`): `pnpm test`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:watch` and `pnpm test:coverage`; the gateway adds `test:usage`, `test:pseudonymization` and `test:pseudonymization:integration`, the admin `test:http` and narrower `test:http:*` scripts. The admin scripts run Jest against SQLite (`cds.requires.db.kind=sqlite`).

**Suites that need the CI environment.** Some gateway suites only run when their environment is present: the file_search database suites need `FILE_SEARCH_TEST_DSN`, the S3 suites the `FILE_SEARCH_TEST_S3_*` variables, and the live-call suites a SAP AI Core service key. A bare local run skips them; the CI pipeline provides all of them (the throwaway database and MinIO it starts are described under [UI Journeys](#ui-journeys-opa5-in-ci)). A change to one of those areas is verified with the CI environment, not with a bare `pnpm test`.

### Live-server suites

Some admin integration suites send HTTP requests to a running admin service. They are declared with `describeLive` from `@libs/test-utils` and run only when `ADMIN_SERVICE_URL` is set; a bare `jest` run skips them, so it never writes rows into a developer's running admin. Do not point `ADMIN_SERVICE_URL` at your own development admin: the suites create and activate test data there.

## How CI Runs the Tests

`pnpm run ci` (`node ci/preflight.js && node ci/ci-pipeline.js`) runs the whole pipeline locally; `.github/workflows/ci.yml` runs the same pipeline on GitHub. The phases are those of `ci/ci-pipeline.js`; `ci/CI_PIPELINE.md` describes each in detail:

| Phase | What it does |
|---|---|
| 1. Environment Setup & Cleanup | validates the SAP AI Core service key; backs up the `.env` files, `admin.db` and the Postgres and Valkey volumes |
| 2. Security Validation | secret detection, supply-chain indicators, dependency audit (`ci/audit-gate.js`: fails on a high or critical advisory, and on a moderate one in the production dependencies, unless allowlisted in `ci/audit-allowlist.json`) |
| 3. Service Compilation | builds the gateway and the admin service |
| 4. Unit Testing | each service's `test:unit`; the i18n literal check and the UI5 type check of every cockpit app |
| 5. Integration Test Environment Setup | starts admin, gateway and Ollama as host processes |
| 6. Full Test Suite | `pnpm run test` for gateway, admin and Ollama: every suite, so a new `*.test.ts` is picked up without a CI change |
| 6.5. sail-proxy CLI End-to-End | packs the npm tarball, installs it in a temporary directory and exercises run, status, apikey, inference and stop |
| 6.6. UI journeys | the OPA5 journeys against the Phase 5 admin (below) |
| 7. Docker Build Validation | builds the four images (see [Docker images and build](/developer/docker-images#images-in-ci)) |
| 8. Docker Container Runtime Validation | starts Postgres and the admin container and checks the schema deployment |
| 9. Docker Security Scanning | Trivy scans each image; a CRITICAL finding with a fixed version, or a scan whose output cannot be read, fails the run; HIGH and unfixed CRITICAL findings are reported only |
| 10. Cleanup | stops what the run started and restores what Phase 1 backed up |

Phases 7 to 9 are skipped when no image-relevant file changed or when `SKIP_DOCKER_BUILD` is set; the GitHub workflow sets it unless a manual run asks for the images.

## UI Journeys (OPA5 in CI)

Role-based UI5 control-level tests for the admin cockpit run on every `pnpm run ci` as
**Phase 6.6** (after the CLI end-to-end phase, as the last consumer of the CI database),
against the dev-mode admin the pipeline starts in Phase 5. They cover the
shell (navigation entries and profile per role, the home page's key-metric tiles and its "My quota"
card), the
API-keys app and the AWS-credentials app (list visibility, object page, edit, create), the
Model Library (entitled models, filters, model detail, manual prices, catalogs), Users & Quotas
(admin only: list, object page, edit, deactivate/reactivate lifecycle, reset quota), Security
Notifications (client IP on the list and the object page) and Tool Policies (admin only: the
seeded Default policy in monitor mode, creating a policy with an inline allow and a deny entry) as
`admin@test.com` and `user@test.com`.

**Where things live**

| Path | Purpose |
|---|---|
| `ci/scripts/ui-journeys/roles.js` | the role matrix — what each role must and must not see or edit |
| `ci/scripts/ui-journeys/fixtures.js` | fixture names (`UI Fixture — …`) and dev user emails, plus a `quota` block (minimal limits so an accidental real request is refused, and the seeded usage figures) and a `securityEvent` block (client IP, user agent, endpoint, request ID of the seeded notification) |
| `ci/scripts/ui-journeys/seed.js` | deletes every draft, API key, AWS credential and non-default model catalog, then creates the fixtures over OData (as the admin); posts synthetic usage for the quota fixtures through the admin's `processUsageEvents` action and a security event through `logSecurityEvent` |
| `ci/scripts/ui-journeys/run.js` | runs `ui5-test-runner` per role × app, writes `ci/reports/ui-journeys/<app>-<role>/` (HTML report, `junit.xml`, screenshots); an `APPS` entry can restrict itself to certain roles via `roles` — `users-app` and `tool-policies-app` are `roles: ['admin']`, since both are admin-only apps; `connections-app`, also admin-only, is to get the same restriction when its journeys arrive (planned) |
| `services/admin/app/<app>/webapp/test/integration/` | the OPA5 pages and journeys of each app (`opaTests.qunit.html` is the entry) |
| `services/admin/app/shell/webapp/test/integration/` | Shell journeys: navigation entries and profile per role, home page key-metric tiles, the My quota card's bullet charts and reset text, and the Settings dialog (a theme applied live on Save and kept for the account, Cancel discarding, a language Save reloading once) |
| `services/admin/app/model-library-app/webapp/test/integration/` | Model Library journeys: grid count per role, filters, leaderboard/chart (admin), detail cost operands and role-gated actions, manual price round trip (admin), catalogs create / stage and save members / discard a staged removal / the unsaved-changes guard / admin tabs / delete, and (`ProfilesJourney.js`, admin only) quota profiles create / edit the limits / the unsaved-profile guard / assign and unassign / delete refused while assigned — `minTests: 7` in `run.js` covers the added journey |
| `services/admin/app/users-app/webapp/test/integration/` | Users & Quotas journeys (admin only): list sort/status/seeded usage, object page constraints/usage/API Keys/Entitlement (including the assigned quota-profile field), Usage bullet charts, edit field control, deactivate/reactivate lifecycle with locked credentials, reset quota |
| `services/admin/app/security-notifications-app/webapp/test/integration/` | Security Notifications journeys: list Client IP column, object page notification details (Client IP, User Agent, Endpoint, Request ID) |
| `services/admin/app/tool-policies-app/webapp/test/integration/` | Tool Policies journeys (admin only, `minTests: 4`): the list shows the seeded Default policy in monitor mode, creating a policy with an inline allow entry, an inline deny entry and an inline Sensitive-Tools entry, the Tool Inventory page and back, and assigning then unassigning a user from the policy's own Assigned Users table. The API key side of the assignment actions is covered by `test/integration/http/tool-policies-odata.test.ts`; `PoliciesJourney.js`'s own comments carry why the earlier, header-based shape of those actions could not be driven from OPA at all |
| `services/admin/app/connections-app/webapp/test/integration/` | Connections journeys (admin only, `minTests: 5`; planned, the journeys arrive in a later task): list, creating a connection, the object page sections, setting a credential, adding a model, setting a price and publishing |
| `services/admin/app/grounding-app/webapp/test/integration/` | Grounding journeys (`minTests: 11`, both roles): the Vector Stores and Files lists, creating a store, uploading a file with real ingestion until it completes, attaching and detaching, deleting an attached file with its detach, a batch job and Test Retrieval; `AdministrationJourney.js` runs three tests per role — the admin opens the Administration overview, sees every user's fixture store and shares then unshares its own share fixture (a store no other role has a namesake of); the user is sent back from an Administration link and finds the admin's seeded shared store read-only and searchable. The seed creates the share fixture and that shared store (with one ingested file) as the admin and purges only stores the role owns, unsharing them first. They need a file_search database for the gateway the pipeline starts in Phase 5 (Integration Test Environment Setup) |

The local pipeline starts a throwaway PostgreSQL with pgvector (`ci/scripts/file-search-test-db.js`,
container `sail-ci-pgvector`, port 55434). The gateway's file_search integration suites run against
its `filesearch_test` database, and the gateway the pipeline starts in Phase 5 (Integration Test Environment Setup)
uses a second database,
`filesearch_ci_gateway`, so the Grounding journeys have a working file_search. Set
`FILE_SEARCH_TEST_DSN` to use a database of your own instead; GitHub does that with a service
container.

The file_search S3 suites run against a throwaway MinIO (`ci/scripts/file-search-test-s3.js`,
container `fs-test-minio-<random>`, `127.0.0.1:59000`). The image is `pgsty/minio`, the MinIO
community fork (github.com/pgsty/minio), AGPLv3, for CI/test use only, pinned by digest: the official
MinIO images are no longer pullable. If it disappears, the fallback is
`versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499`
(one command, checks SigV4; not wired). The helper picks random credentials per run, creates
the bucket with one signed `PUT`, and exports `FILE_SEARCH_TEST_S3_ENDPOINT`, `_BUCKET`, `_REGION`,
`_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`; the pipeline passes them to the Phase 6 gateway suites
only (the Phase 5 gateway and the journeys stay on the `db` backend). On GitHub a workflow step starts
it, since a service container cannot pass `server /data`, and an `if: always()` step removes it.
The suites gate on these test variables only, through `s3TestConfigFromEnv()`, which refuses any
endpoint other than 127.0.0.1 or localhost — never on the product `FILE_SEARCH_S3_*` variables, so no
test run can reach AWS. The suites pass the MinIO keys to `createS3Backend` through its `credentials`
option; `test/setupTests.ts` deletes `FILE_SEARCH_S3_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` before
and after every test, so an S3 test that relies on them fails instead of signing with a developer's
real keys. To run them by hand:

```bash
eval "$(node ci/scripts/file-search-test-s3.js start)"   # fails, naming the holder, if 59000 is taken
cd services/gateway && npx jest test/fileSearch/s3Backend.minio.test.ts
node ci/scripts/file-search-test-s3.js stop               # docker rm -f -v by name
```

For trials with a gateway, `docker/docker-compose.yml` has an opt-in `minio` profile on
`127.0.0.1:59100` (`http://minio:9000` inside the network); it refuses to start unless
`MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` are set in your shell.

`run.js` injects the selected role's expectations into the page URL (`?role=…&expect=<base64url JSON>`);
journeys read them from `expectations.js` and never assert against literals. **To add a role
expectation, edit `roles.js`** (for example a new entry in `shell.visibleNav`); to check something
new, add one journey file and list it in the app's `opaTests.qunit.js`. The first test of every
page calls `whoami` and fails immediately if the browser is not signed in as the expected role.

**Running locally.** The journeys purge and seed the database they run against, so they only
run when `ADMIN_SERVICE_URL` is set, the seed refuses any target that is not a dev-mode
`admin@test.com` admin, and it refuses port 4004 outside the pipeline — pointing
`ADMIN_SERVICE_URL` at your own dev admin would purge its API keys and AWS credentials.
`pnpm run ci` handles this
(it backs up `services/admin/db/admin.db` in Phase 1 and restores it in Phase 10). For a
standalone run, start a throwaway admin on a scratch database first:

```bash
cd services/admin
npx cds deploy --to sqlite:/tmp/ui-journeys.db
CDS_CONFIG='{"[development]":{"requires":{"db":{"kind":"sqlite","impl":"@cap-js/sqlite","credentials":{"url":"/tmp/ui-journeys.db","database":"/tmp/ui-journeys.db"}}}}}' PORT=4014 pnpm run dev:ts:mock
# in another terminal, from the repository root
ADMIN_SERVICE_URL=http://localhost:4014 pnpm run ui:journeys
```

**The `[development]` key and the `database` entry are both load-bearing.** A top-level
`CDS_CONFIG` block is overridden by the profile the dev server runs under, and
`credentials.database` beats `credentials.url` — so the shorter spelling starts a throwaway that
serves the DEV database instead of the scratch file, and the seed then purges the dev API keys and
AWS credentials.

**Check the running service, not its log.** The log line
`connect to db > sqlite { url: '/tmp/ui-journeys.db', database: '/tmp/ui-journeys.db' }` is printed
by a process that may then lose the port to another admin (`EADDRINUSE`, further down the same log)
and exit, leaving the seed pointed at whatever owns the port. `pnpm run dev:ts:mock` is a nodemon
supervisor that respawns `cds serve` after every kill and every file change, so an old throwaway
can come back and hold the port long after you think it is gone: stop one by killing the
`pnpm run dev:ts:mock` process, not the listener. Ask the service which database it serves —
`curl -u admin@test.com:x http://localhost:<port>/odata/v4/admin/ToolPolicies?\$select=name` on a
scratch database answers with `Default` alone.

`seed.js` enforces the same rule from its side: it refuses any target holding an API key or AWS
credential whose owner is neither a mocked fixture user nor a `*.service.key`, naming what it found.
The CI pipeline restores its database afterwards and opts out with `UI_JOURNEYS_IN_PIPELINE=1`.

The Model Library journeys need the gateway the pipeline starts in Phase 5
(`refreshModelLibrary` reads the model list; it spends no tokens). Locally, either restrict a run to
the other apps with `UI_JOURNEYS_APPS=shell,api-keys-app,aws-credentials-app`, run the full
pipeline, or give the throwaway admin a scratch *copy* of a database that already holds a
library snapshot (copy `admin.db` and its `-wal` file while the dev admin is stopped) and set
`UI_JOURNEYS_SKIP_LIBRARY_REFRESH=1` so the seed keeps that snapshot instead of asking the
gateway — `UI_JOURNEYS_APPS=model-library-app UI_JOURNEYS_SKIP_LIBRARY_REFRESH=1
ADMIN_SERVICE_URL=http://localhost:4014 pnpm run ui:journeys`. The pipeline never sets that flag. `run.js` and `seed.js` read `UI_JOURNEYS_APPS`, so a restricted run seeds only the fixtures its
apps read: the model-library fixtures (the seed drops every non-default catalog, refreshes the
snapshot and creates the fixture catalog, its assignment and one default-catalog exclusion) for
`model-library-app`, the quota fixtures for `shell` or `users-app`, and the security event for
`security-notifications-app`.

The Users & Quotas and shell "My quota" journeys need the seeded usage rows, and the admin only
persists a `processUsageEvents` batch once it has model data from a gateway
(`modelCostService.hasValidModelData()`, which reads `GET <GATEWAY_URL>/v1/models`, by default
`http://localhost:3000`). Without one the seed still reports success and those journeys then time
out waiting for usage that was never stored, so start the gateway — or a stub that answers
`/v1/models` — on a private port and give the throwaway admin `GATEWAY_URL=http://localhost:<port>`
next to its `CDS_CONFIG`. The pipeline starts the real gateway in Phase 5, so this is a standalone
concern only. When the scratch copy predates the current schema, run
`npx cds deploy --to sqlite:/tmp/ui-journeys.db` against the copy before starting the admin;
otherwise the first read fails with `no such table: sap_llm_gateway_admin_Users`. Deploying
recreates every table, so the copy loses its library snapshot — when the model-library journeys
are part of the run, copy a database that already has the current schema instead.

The dev admin serves each app's `webapp/` live (cds-plugin-ui5), so no build is needed before a
run. Docker and Kyma images strip `app/*/dist/test` and exclude the test-only UI5 libraries, so
deployed images carry no test page (a locally built admin still serves them from `dist`).
