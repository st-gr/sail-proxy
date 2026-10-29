---
title: Debugging and troubleshooting (developer)
description: Logging, log level resolution, tracing requests and common failure modes.
---

# Debugging & Troubleshooting

This page is for developers working on the services. Operational problems of a running installation are covered in [Troubleshooting](/guide/troubleshooting) and in the Troubleshooting sections of [Docker Compose](/deploy/docker#troubleshooting) and [SAP BTP Kyma](/deploy/kyma#troubleshooting).

## Development Debugging

### Running with more output

```bash
LOG_LEVEL=debug pnpm run dev:gateway     # every gateway component at debug
LOG_LEVEL=trace pnpm run dev:gateway     # including SSE chunk traces
pnpm run dev:admin                       # admin with cds watch
```

`LOG_LEVEL` is read by the shared logger of both services; how it combines with the configuration is described in [Log level resolution](#log-level-resolution). Two other switches add output in specific places:

- `DEBUG=true` in `services/gateway/.env` makes the API key middleware log the request headers (with sensitive values hidden) and the web search plugin save its direct responses as payload files; it also registers in-memory test AWS credentials from `TEST_AWS_ACCESS_KEY_ID`, `TEST_AWS_SECRET_ACCESS_KEY` and `TEST_AWS_SALT` (`services/gateway/src/services/awsCredentialsService.ts`). It does not change the log level. Never set it on a deployed installation.
- The admin's `dev:ts:mock` script sets `DEBUG=sql`, which makes CAP log its SQL statements; `DEBUG=cds:*` or CAP's `CDS_LOG_LEVELS_<module>` variables raise CAP's own loggers (the Docker admin image sets `CDS_LOG_LEVELS_CDS=debug` and `DEBUG=cds:*`).

### Debugger

The gateway's dev script runs `nodemon` with `ts-node -r tsconfig-paths/register src/index.ts`; the admin's `dev:ts` scripts do the same for the admin, and `pnpm run dev:admin` runs `cds watch`. The simplest way to stop at breakpoints in either is to start the script from a VS Code **JavaScript Debug Terminal**, which attaches to the Node.js processes it starts, including the ones `nodemon` and `cds watch` restart. Sources map back to the TypeScript files because both services run them through `ts-node`.

To debug one gateway test suite, run Jest in band from `services/gateway` in the same kind of terminal:

```bash
npx jest --runInBand test/plugin-loader-header-match.test.ts
```

## Logging and Observability

### Structured Logging

Both services and the shared libraries log through `@libs/logger` (`libs/logger/index.ts`). A log line names its **component**, the first argument of every call, and in the gateway the request it belongs to:

```
2026-10-13T08:00:00.000Z [gateway-1760342400000-k3j9x2a1b] INFO  [PluginExecutor] Executing 'before' plugin: pseudonymizationPlugin
```

- **Levels** are `trace`, `debug`, `info`, `warn` and `error`.
- **Components** are free-form names: services use their own (`PluginLoader`, `PluginExecutor`, `ConfigService`, `AnthropicController`, `PayloadLogger`, …), and a plugin's `utils.logger` logs under the plugin's rule id. A component name is what `platform.logging.components` keys on.
- **Request ids**: the gateway gives every request an id of the form `gateway-<timestamp>-<random>` and puts it into the log context, so `grep` on the id follows one request through the log. The same id names the request's payload log files and its usage records.
- **Output** goes to the console (stdout and stderr), which is what Docker and Kubernetes collect.

### Payload logging

With payload logging on, the gateway writes the bodies it handles to JSON files under `<log folder>/payloads/` (`services/gateway/src/utils/payloadLogger.ts`), named `<timestamp>_<request id>_<stage>.json`. The stages are numbered: `00_…` is the request as the client sent it, `01_…`/`02_…` what the gateway sent upstream, `03_…` what came back, and later numbers what the client received. Switch it on with `platform.logging.payload_logging_enabled` in the configuration or `PAYLOAD_LOGGING_ENABLED=true` in the environment (the environment wins); the folder is `platform.logging.log_folder_path` (default `./logs`, relative to `services/gateway`).

Payload files contain complete prompts and responses, including personal data before pseudonymization. Use them on development installations only and delete them afterwards. How they serve as evidence for masking is shown in [Pseudonymization security assessment](/developer/pseudonymization-assessment#_5-evidence-payload-log-chain).

### Log level resolution

The shared logger (`libs/logger`) resolves its effective level from two sources, and the
`platform.logging` block in `api_config.json` is only one of them.

- **`platform.logging.defaultLevel`** sets the level for any component that has no entry in
  `platform.logging.components`. Per-component entries in `components` override it for their own
  component and are unaffected by the precedence below.
- **`LOG_LEVEL` (environment) wins.** If `LOG_LEVEL` is set to a level the logger recognizes, it
  takes precedence and `defaultLevel` is ignored. `LOG_LEVEL` ships **set** in both `.env` samples
  (`services/gateway/.env.sample`, `services/admin/.env.sample`) and in the Kyma manifests, so in a
  stock deployment the environment is what actually governs the level.
- **Recognized levels** are `trace`, `debug`, `info`, `warn`, `error`. Both `LOG_LEVEL` and
  `defaultLevel` are matched **case-insensitively**.
- **An unrecognized value is silently ignored** — it does not raise an error; the previously
  effective level (the built-in default of `info`, or a lower layer's value) stays in place. The
  schema lists the choices in uppercase because that is what operators type into the config form.
- **The shipped configurations carry no `components` entries** (`"components": {}`), so in a stock
  install `LOG_LEVEL` governs every component. An entry is an explicit pin: it outranks `LOG_LEVEL`,
  and a stored configuration that still carries entries keeps those components at their level
  whatever `LOG_LEVEL` says. Remove the entries (create and activate a new configuration) to hand
  them back to `LOG_LEVEL`.
- **The Docker admin image sets `LOG_LEVEL=info`** (`docker/admin.Dockerfile`). Its earlier `debug`
  never took effect, because the logger only applied `LOG_LEVEL` inside a top-level `logging` block;
  it now applies it whenever it is recognized.
- **A top-level `api_config.logging` block is deprecated.** It is still read when
  `platform.logging` is absent, with a one-time warning to move it; when both exist,
  `platform.logging` wins and the top-level block is ignored with a one-time warning.
- **A configuration reload** (`reinitialize()`, called by the gateway's `configService` on every
  configuration change) replaces the component levels instead of adding to them, so a removed
  entry stops applying.

Resolution order, highest priority first: a matching `components[<component>]` entry → a recognized
`LOG_LEVEL` → a recognized `defaultLevel` → the built-in `info`.

## Database Debugging

- **Admin, local**: the development database is `services/admin/db/admin.db` (SQLite). `DEBUG=sql` (set by `dev:ts:mock`) logs every statement. Open the file with any SQLite client while the admin is stopped, or read it through OData with the mocked users (`curl -u admin@test.com:x http://localhost:4004/odata/v4/admin/...`). Schema changes, the boot-time self-heal and the single-connection rule for transactions are described in [Admin service (CAP)](/developer/admin-cockpit).
- **Admin, Docker and Kyma**: PostgreSQL. `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` opens a shell in the Docker installation.
- **Gateway**: the gateway's own database is the file_search database (see [The hosted file_search tool](/developer/file-search-tool)); credentials, configuration and usage live in the admin.

## Tracing a Request

1. Find the request in the gateway log: the controller logs the model and subpath, then the plugin, quota and upstream steps, all with the same request id.
2. If the request was refused before reaching a controller, look for the authentication middleware (`401`/`403`) or `quotaEnforcement` (`429`, with scope, dimension and window in the body). A refused credential also raises a `failed_auth` security event, visible in the cockpit's [Security notifications](/guide/cockpit/security-notifications).
3. For what was actually sent upstream, switch payload logging on and repeat the request.
4. Upstream errors from SAP AI Core are logged with SAP's status and message. The calls file search depends on (model list, embedding, rerank) run with per-attempt timeouts and one retry, described in [The hosted file_search tool](/developer/file-search-tool#sap-ai-core-calls-per-attempt-timeouts-and-one-retry).

## Common Issues and Solutions

### Port conflicts

`Error: listen EADDRINUSE :::3000` (gateway) or `:4004` (admin) means another process holds the port, often an earlier `nodemon` or `cds watch` that was not stopped:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN     # which process listens
kill <pid>
```

Stop a `nodemon` or `cds watch` supervisor rather than the listener it started: the supervisor restarts a killed child.

### Hooks or plugins do not run

The gateway logs `Registered <n> plugin rules` at start under `PluginLoader`. When a hook does not fire, the usual causes are a rule id missing from `hooks.definitions` (logged as a warning), a `callback.id` without a rule for the phase, or an activated configuration that lacks the hook. See [Plugin system](/developer/plugins#troubleshooting).

### Valkey unreachable

Without Valkey, the gateway keeps working: rate limits and quotas fall back to per-process memory counters and raise a throttled `quota_unenforced` security event, security events queue in memory and are flushed to the admin, and usage is sent to the admin directly. Quotas are then enforced per gateway process only.

### Admin unreachable

The gateway validates credentials against the admin. While the admin is unreachable, credentials already in the validation cache keep working, and a gateway with a local credential store falls back to it; a credential the gateway cannot validate is refused. Check the admin's `/api/health` and the gateway's log for `AdminServiceClient` errors.

### Health endpoints

| Service | Endpoint |
|---|---|
| Gateway | `GET /health` on port 3000 |
| Admin | `GET /api/health` on port 4004 |
| Ollama adapter | `GET /health` on port 11434 |
| nginx (Docker) | `/health` (nginx itself), `/gateway/health`, `/admin/api/health` |
