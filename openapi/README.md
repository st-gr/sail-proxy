# OpenAPI descriptions

| File | Describes |
|---|---|
| `gateway.yaml` | Every client-callable route of the gateway (`services/gateway`) |
| `ollama.yaml` | Every route of the Ollama-compatible service (`services/ollama`) |
| `admin-odata.json` | `AdminService`, the admin's OData V4 API (generated, OpenAPI `3.0.2`) |
| `admin-rest.yaml` | The admin's REST routers: the configuration status (`config-rest-api.ts`), the cockpit's Grounding layer (`grounding-rest-api.ts`), and the Plugins app's routes (`plugins-rest-api.ts`) |
| `internal-routes.json` | Routes that are served but deliberately left out of the descriptions, each with the reason |

All hand-written documents are OpenAPI `3.1.0`.

`admin-odata.json` is generated from the CDS model by `services/admin/scripts/generate-openapi.js` (`pnpm --filter admin openapi`), not edited by hand. It keeps the generator's `3.0.2`: its output uses `nullable`, which 3.1 dropped. Only `AdminService` is described, served at `/admin/odata/v4/admin`; the gateway's service-to-service `ValidationService` is not. `services/admin/test/unit/openapi-odata.test.ts` fails when the committed file differs from a fresh generation or does not validate.

## Conventions in `gateway.yaml`

- One path item per route, under its canonical path (`/openai/v1/...`, `/v1/models`, `/google/v1beta/...`).
  The other paths the same router serves are listed in the path item's `x-sail-aliases`
  (`/openai/api/v1/...`, the OpenRouter copies of Files, Uploads and Vector Stores, `/openai/v1/models`,
  `/google/v1/...`).
- Paths are the Express routes as mounted: a route with one parameter for several operations
  (`/google/v1beta/models/{modelAndMethod}`, `/aws-bedrock/model/{modelId}/{subpath}`) is one operation.
- Tags are the sections of `docs/reference/api-endpoints.md`, in its order. `docs/scripts/gen-endpoints.mjs` generates
  that page's tables from the operations (`x-sail-upstream`, `x-sail-credential`, `x-sail-aliases`) and prints a tag's
  `description` under its table.
- Every operation has `operationId`, `summary`, `x-sail-upstream` (what answers the request),
  `x-sail-credential` (what credential it takes), `security` and its responses.
- A vendor route links the vendor's API reference in `externalDocs` and its `description` says what sail-proxy
  changes, taken from the code; sail-proxy's own routes carry full schemas in `components.schemas`.
- Realtime (`/openai/v1/realtime`, `/v1/realtime`) is a WebSocket upgrade, not an Express route, and is not
  described here.

## Conventions in `admin-rest.yaml`

- Paths are relative to the admin's `/api` mount, which the Docker and Kyma start performs
  (`services/admin/src/index.ts`); the server is `/admin/api` (nginx). The other mounts of the routers
  (`/api/admin` and `/api/grounding` in `services/admin/src/srv/admin-service.ts`, `/admin` in `services/admin/server.js`)
  run only in a local `cds serve` and are not described.
- The security scheme `cockpitSession` is oauth2-proxy's session cookie (`_oauth2_proxy`, its default name; no
  configuration renames it).
- `GET`/`PUT /api-config` and `POST /api-config/rollback` are served but answer 500 in Docker and Kyma; they are
  listed in `adminRest` with the defect until the routes are fixed.
- Every operation has `operationId`, `summary`, `description` and `x-sail-upstream`. The Grounding routes forward
  to the gateway's `/api/admin/grounding` router: their schemas are the bodies the gateway's grounding controllers
  build (`services/gateway/src/controllers/grounding*.ts`, `vectorStoresController.ts`, `filesController.ts`), and
  each also documents the answers the admin gives itself (401 `authentication_required`, 400 `invalid_id` and
  `unsupported_identity`, 502 `gateway_unreachable`). `GET /grounding/model-cost` is answered by the admin.
- The Plugins routes (`/plugins/...`) are answered by the admin from its own plugin store. Their errors are
  `{error, message}`; a refused package's `error` is the code of the package check (`libs/plugin-package`).
  The two `ValidationService` functions the gateway calls to sync plugins (`getPlugins`, `getPluginPackage`) are
  not described, like the rest of that service.

## `internal-routes.json`

`{ "gateway": [...], "adminRest": [...], "ollama": [...] }`. Each entry has `method`, `path` (OpenAPI form,
`{param}`) and `reason`: who calls the route and with which credential. Gateway entries also have `upstream`,
`credential` and `section`, so the reference page can render its Administration section from them.

## Kept true by tests

`services/gateway/test/openapi-coverage.test.ts` lists the routes the gateway mounts (full mode, with an admin
service) and fails when one is neither in `gateway.yaml` nor in `internal-routes.json`, or when either file
names a route that is no longer served. It also checks that standalone mode drops only internal routes and that
the document validates as OpenAPI 3.1.

`services/gateway/test/openapi-contract.test.ts` sends real requests to the gateway app (standalone mode, the
model list from a fixture, no SAP AI Core) and checks each answer against the status and schema the document
gives for it: `/health`, `/`, the `/v1/models` routes, a 401 on a vendor route and the SAP-RPT refusals.

`services/ollama/test/openapi-coverage.test.js` does the same for the Ollama service (the app is listened on a
loopback port, no gateway is called) and checks `/health`, `/`, `/api/version`, `/api/ps`, the `/api/show` 400 and the
501 stubs against their schemas. The `ollama` list in `internal-routes.json` is empty: every route is documented.

`services/admin/test/unit/openapi-rest.test.ts` reads the router mounts and the app-level `/api/...` routes from
`services/admin/src/index.ts` (the Docker and Kyma start), lists every route the two routers serve
under them and fails when one is neither in `admin-rest.yaml` nor in the `adminRest` list, or when either names a
route that is no longer served. It checks the answers the Grounding router gives itself, and gateway answers passed
through it (the gateway mocked as in `srv/grounding-rest-api.test.ts`), against the document's schemas.

`docs/scripts/gen-endpoints.test.mjs` (in `pnpm docs:check`) fails when the committed
`docs/reference/api-endpoints.md` differs from the one generated from `gateway.yaml` and `internal-routes.json`.

A new gateway route therefore needs an operation in `gateway.yaml` (or an entry in `internal-routes.json`) in
the same change.
