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
- **Output** goes to the console (stdout and stderr), which is what Docker and Kubernetes collect. On Docker and Kyma the gateway also hands its log to the admin service for the cockpit's Logs page; see [The gateway log in the cockpit](#the-gateway-log-in-the-cockpit).

### Payload logging

With payload logging on, the gateway writes the bodies it handles to JSON files under `<log folder>/payloads/` (`services/gateway/src/utils/payloadLogger.ts`), named `<timestamp>_<request id>_<stage>.json`. The stages are numbered: `00_…` is the request as the client sent it, `01_…`/`02_…` what the gateway sent upstream, `03_…` what came back, and later numbers what the client received. Switch it on with `platform.logging.payload_logging_enabled` in the configuration or `PAYLOAD_LOGGING_ENABLED=true` in the environment (the environment wins); the folder is `PAYLOAD_LOG_DIR` when set, otherwise `platform.logging.log_folder_path` (default `./logs`) + `/payloads`, a relative path resolved against the gateway's working directory (`resolvePayloadDir`; `services/gateway/logs/payloads` under `pnpm dev`). The gateway image sets `PAYLOAD_LOG_DIR=/app/payloads`, a folder of the container owned by the gateway user and deliberately not bind-mounted: a folder Docker creates for a bind mount on a Linux host is root-owned, and the gateway (uid 1001) could not write to it. The files stay in the container or pod (`docker compose cp` / `kubectl cp` copy them out). The standalone CLI sets it to `logs/payloads` in its configuration directory (`npm-dist/sail-proxy/src/utils/gateway-env.ts`). The Anthropic controller's raw stream copies (`*_04_client_native_stream_response.txt`) go to the same folder. While file logging is on, the gateway says so once at startup with the folder, and the admin answers `payloadFileLoggingEnabled` in `getLoggingSettings` (the reported `PAYLOAD_LOGGING_ENABLED`, else the configuration key) for the Logs page's warning.

Payload files contain complete prompts and responses, including personal data before pseudonymization. Use them on development installations only and delete them afterwards. On Docker and Kyma the gateway deletes the `*.json` files and the stream copies of the payload folder by age and size itself (`PAYLOAD_LOG_RETENTION_HOURS`, `PAYLOAD_LOG_MAX_MB`, `services/gateway/src/utils/payloadFolderSweeper.ts`), whether payload logging is on or off. How they serve as evidence for masking is shown in [Pseudonymization security assessment](/developer/pseudonymization-assessment#_5-evidence-payload-log-chain).

### Log level resolution

The shared logger (`libs/logger`) resolves its effective level from two sources, and the
`platform.logging` block in `api_config.json` is only one of them.

- **`platform.logging.defaultLevel`** sets the level for any component that has no entry in
  `platform.logging.components`. Per-component entries in `components` override it for their own
  component and are unaffected by the precedence below.
- **`LOG_LEVEL` (environment) wins.** If `LOG_LEVEL` is set to a level the logger recognizes, it
  takes precedence and `defaultLevel` is ignored. For the gateway, `LOG_LEVEL` is **not set** by
  default (commented out in `services/gateway/.env.sample`, absent from the Kyma gateway manifest),
  so the configuration and the cockpit's Logs page govern its level. `sail-proxy upgrade docker`
  keeps an existing `services/gateway/.env` (`setupGatewayEnv` without overwrite), so a Docker
  installation set up with 0.12.1 or earlier keeps `LOG_LEVEL=INFO` and
  `PAYLOAD_LOGGING_ENABLED=false`, and its Logs page shows the default level as fixed until the line
  is removed. A Kyma render starts from fresh `.env` files built from the sample
  (`removeServiceEnvFiles` in `setup-kyma.js`), so `sail-proxy upgrade kyma` removes both from
  `gateway-config`; only a key added to the ConfigMap by hand stays. The admin keeps `LOG_LEVEL=info` in
  `services/admin/.env.sample`, the Kyma admin manifest and its Docker image.
- **Recognized levels** are `trace`, `debug`, `info`, `warn`, `error`. Both `LOG_LEVEL` and
  `defaultLevel` are matched **case-insensitively**.
- **An unrecognized value is silently ignored** — it does not raise an error; the previously
  effective level (the built-in default of `info`, or a lower layer's value) stays in place. The
  schema lists the choices in uppercase because that is what operators type into the config form.
- **The shipped configurations carry no `components` entries** (`"components": {}`), so in a stock
  install the default level (`LOG_LEVEL` when set, otherwise `defaultLevel`) governs every
  component. An entry is an explicit pin: it outranks `LOG_LEVEL`, and a stored configuration that
  still carries entries keeps those components at their level whatever `LOG_LEVEL` says. Remove the
  entries (create and activate a new configuration) to hand them back to the default level.
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

On Docker and Kyma the gateway takes `platform.logging` from the configuration the admin service
hands it (the change event and the fetch at start), not from its local file; the Logs page's levels
arrive inside that configuration (see below).

### The gateway log in the cockpit

On Docker and Kyma the gateway's log is stored by the admin service and shown on the cockpit's Logs
page ([user guide](/guide/cockpit/logs)). Nothing of it runs in the standalone gateway: the CLI sets
`GATEWAY_LOG_SHIPPING=off`, and `logShippingAllowed` also refuses standalone mode and a missing
`VALKEY_URL`.

**The path.**

1. `libs/logger` calls every registered sink (`addSink`) after it has written the console line. The
   sink of `services/gateway/src/services/logShipper.ts` only turns the entry into a
   `ShippedLogEntry` and pushes it to an array: no I/O on the request path. The array holds at most
   5,000 entries; beyond that, entries are dropped and counted, and the count is written to stderr
   once a minute (never through the logger it listens to).
2. A one-second timer hands the queue over in batches of 200 to the Valkey stream `gateway-log`
   (`securityEventEmitter.appendGatewayLogBatch`), capped at 300 batches, at most 60,000 entries,
   about five minutes of backlog at ordinary rates (300 hand-overs at one a second)
   (`GATEWAY_LOG_STREAM_MAX_BATCHES`: worst case about 150 MB at 200 entries of about 2.5 KB a batch,
   under the Kyma Valkey's 256 MB limit; entries trimmed off the stream are lost without a count).
   A failed publish puts the batch back for the next flush, as far as the queue has room; a
   publish that hangs holds the flushing, so the queue fills and new entries are dropped. Either
   way the request never waits.
3. The admin service reads the stream with the consumer group `gateway-log-ingest`
   (`services/admin/src/services/gatewayLogIngest.ts`). Rows are written with UPSERT keyed by
   `<stream entry id>-<index>`, so a redelivery stores nothing twice; the stream entry is
   acknowledged and deleted only after its rows are committed, and a malformed entry is counted and
   dropped so it cannot block the stream.
4. The table `GatewayLogEntries` (`services/admin/src/db/schema/gateway-log.cds`) is read through the admin-only OData
   entity `GatewayLog` (`$search`: the whole text, literally, over message, component and request id, `srv/gateway-log-search.ts`) and the export route
   `GET /api/logs/gateway/export` (`services/admin/src/srv/admin-service-logs.ts`, at most 100,000 lines, read in pages
   by key). `services/admin/src/services/gatewayLogRetention.ts` deletes by age and count every 10
   minutes; Delete now is `services/admin/src/srv/admin-service-log-delete.ts`.
5. The Logs app (`services/admin/app/logs-app`) polls every 2 seconds for the rows stored after a
   cursor (`storedAt`, set by the ingest on the admin's clock and indexed): the admin's time of the
   previous read (the answer's `Date` header) minus 5 seconds, so a poll that finds nothing still
   moves on and a late entry appears at its place. It merges by `ID`; a full answer reloads the view.

**What is stored.** `shippedEntryOf` keeps the time, level, component, request id, the message (cut
at 2,000 characters) and the error's name and message (cut at 500), for entries at or above
`min_level`. It never stores the metadata object, and it skips the health route's access line.

**The rule for a log call.** A message at INFO, WARN or ERROR is shown to every administrator.
Nothing in it may be conversation content (prompts, answers, tool arguments, search queries, file
names and text of uploads), an upstream body, or a secret. The one exception is an upstream's own
short error message (the `message` field of its error), stored cut at 300 characters
(`UPSTREAM_MESSAGE_LIMIT`): it can quote a few words of a request, as the console does. Content goes into the metadata
argument, which reaches the console and is never stored; a secret goes nowhere, not even into the
metadata. The mechanisms:

- `upstreamErrorText(status, kind, message)` (`services/gateway/src/utils/upstreamErrorLogText.ts`)
  is the one way an upstream's message enters a line: status, classification and the message cut.
  An Error whose message is an upstream's text is marked with `markUpstreamText` (non-enumerable
  `logText`, built by `upstreamErrorText`). The logger hands `logText` to the sinks only; the shipper
  stores it in place of the error's message, also where that message was interpolated into the
  line. `loggableErrorText(error)` gives the same text for a message you build yourself, and
  `upstreamTextMeta(error)` puts the upstream's whole words into the metadata.
- The shipper's sanitisers cut the quoted input of a `JSON.parse` error and the quoted pattern of a
  RegExp `SyntaxError` from the stored message and error; the console keeps them.
- `services/gateway/test/log-message-content-guard.test.ts` reads every `info`, `warn` and `error`
  call of the gateway with the TypeScript compiler and fails on a message that interpolates a name
  that has carried content or a secret (`query`, `body`, `content`, `token`, a `JSON.stringify`, …).
  An upstream's message (`failure.message`, `chunk.error`) passes only as an argument of
  `upstreamErrorText`, whose arguments are still checked for the rest. Fix the call; if a flagged call was reviewed and holds no content, add it to `ALLOWED` with its
  file, a marker string from the call and the reason. An entry that no longer matches a call fails
  the test too.

**Settings and the hand-over.** The Logs page's switches and levels are one record
(the `LoggingSettings` row `gateway` in the admin's database, `services/admin/src/services/loggingSettings.ts`),
cached in memory in the admin.
`overlayLoggingSettings` lays it over the configuration's `platform.logging` and
`observability.gateway_log.enabled` whenever the admin hands the active configuration to the gateway;
the stored configuration versions never contain it. `startLoggingSettingsExpiry` checks once a minute
for a timed level that has run out, and for settings not yet handed over, and hands the configuration
over again, so a failed hand-over is retried. Every hand-over goes through `HandOverQueue`
(`services/admin/src/services/handOverQueue.ts`, used by `services/admin/src/srv/config-service.ts`):
one at a time, and only after the transaction that changed the configuration has committed. Each
hand-over has 3 seconds (`PUBLISH_TIMEOUT_MS`), counted from its start; one that times out is given up
and never blocks the ones behind it. The gateway reports which settings its
environment fixes (`environmentFixedReport`: `LOG_LEVEL`, `PAYLOAD_LOGGING_ENABLED`, a switched-off
`GATEWAY_LOG_SHIPPING`), and the admin refuses values those variables would overrule. The report goes
with the gateway's start-up request on `sap-llm-gateway:service-ready`; a gateway that was running
before the admin started (its request went out while nobody listened) sends it again, alone, as
`gateway-environment-report` in answer to the admin's `admin-service-started` announcement
(`answerAdminServiceStart`). The admin only stores that report and republishes nothing. Either start
order therefore ends with a stored report, with one message per admin start and no polling.

**What the gateway does with a logging change.** A save, a reset and a timed level that ran out
reach the gateway as the event `logging-settings-changed`, which carries the whole active
configuration like an activation does. `handleConfigChangeEvent`
(`services/gateway/src/services/configService.ts`) compares the configuration it holds with the one
that arrived (`differsOnlyInLoggingSettings`, `services/gateway/src/services/loggingOnlyChange.ts`).
When they differ only in the three places the overlay writes (`platform.logging.defaultLevel`,
`platform.logging.components`, `observability.gateway_log.enabled`), the gateway replaces its cached
configuration, hands the levels to the logger and logs `Logging settings applied without a reload`;
the log shipper reads the storage switch from the cached configuration once a second. Nothing else
runs: no plugin reload, no clearing of the model and token caches, no configuration-ready handlers;
only a model list that could not be published yet is tried again, as on every configuration event.
Any other difference takes the full reload: a gateway that missed an activation gets the new
configuration with a logging event, and the content, not the event's type, decides. The full reload
also runs for an event that arrives before the gateway has taken a configuration from the admin
service with a full reload (a configuration it only read from its own file does not count), and
for an event without a configuration, which the gateway then fetches.

**Cost.** The shipper's cost per request is measured with
`services/gateway/scripts/request-overhead-bench.ts`; the method and every result so far are in
`services/gateway/scripts/requestOverheadBench/README.md`. Run its `logger` mode before and after a
change to the logger or the shipper.

### Payload traces and raw capture

On Docker and Kyma the gateway can hand the content of requests to the admin service for the cockpit's
Logs page ([user guide](/guide/cockpit/logs#payload-traces)); like the gateway log, nothing of it runs
in the standalone gateway or without `VALKEY_URL`. A request never waits for it: stages are copied in
memory, everything is published after the response, and a failure drops the trace and is counted, with
one console line a minute.

**Light traces.** With `observability.payload_capture.enabled` (or the Logs page's switch) on,
`services/gateway/src/services/payloadTrace.ts` builds one `PayloadTraceMessage` per request: the facts, the
masked prompt and answer in the clear, and an unmasked prompt only as `sealedPrompt`. It goes to the
Valkey stream `payload-traces` (`securityEventEmitter.publishPayloadTrace`, bounded by MAXLEN). A request of
a raw session leaves a facts-only trace when capture is off.

**Sessions.** The admin service (`services/admin/src/services/rawCaptureSessions.ts`) resolves keys and
e-mail addresses to credential ids when a session starts, writes the running sessions to the Valkey key
`sap-llm-gateway:raw-capture` and publishes on the channel `sap-llm-gateway:raw-capture-changed`. The
gateway reads the key at start and on each message, without a reload, and ends a session itself at its
end time; while it holds a session it reads the key again every 60 s, so a Stop whose read failed ends
the capture within a minute. E-mail addresses match whatever their case. A 30 s check in the admin ends sessions that are due and rewrites the key while one runs, so a
Valkey restart does not lose it. Start and stop are audited.

**How a stage reaches the cockpit.**

1. `middlewares/rawCaptureTap.ts` looks the request's credential up in the session map (one `Map`
   lookup for any other credential) and opens a collector keyed by the request id; it records
   `00_arrival` and what the client received.
2. `savePayload` (`utils/payloadLogger.ts`) calls `recordStage(requestId, stage, data)` for every stage,
   whether payload logging writes a file or not. Headers and URLs are redacted with the payload logger's
   own functions. A stage name that repeats in one request is suffixed `#2`, `#3`.
3. The collector closes 2 s after the response finished (`RAW_CAPTURE_CLOSE_GRACE_MS`), so stages saved
   after the client's `[DONE]`, such as the SAP streaming stage, still land; the client stage goes last.
4. `closeCollector` seals the stages as one JSON array (`@libs/trace-seal`) and appends a
   `RawTraceMessage` to the `raw-traces` stream. `stage_max_bytes`, `max_stages` and `request_max_bytes`
   (`observability.payload_capture.raw`) cut what is kept, and the trace says it was cut. The client stage
   keeps the last of `max_stages` and min(`stage_max_bytes`, `request_max_bytes` / 4) bytes: the stages
   before it may use only the rest of `request_max_bytes`.
5. `services/admin/src/services/payloadTraceIngest.ts` reads both streams with the consumer groups
   `payload-trace-ingest` and `raw-trace-ingest` (20 entries per read, 5 on `raw-traces`, whose entries
   can reach a few MB), stores `PayloadTraces` and `RawTraces` rows keeping
   the sealed text sealed, and acknowledges after the commit. Retention runs in the admin
   (`retention_hours` 48, `raw.retention_hours` 24).
6. The cockpit opens content only through the actions `openPayloadTrace`, `openRawStage` and the two
   downloads, each writing an audit event.

**The seal.** `libs/trace-seal` derives a key with HKDF-SHA256 from `METADATA_ENCRYPTION_KEY` (salt
`sail-proxy-payload-traces`, info `trace-seal-v1`) and encrypts with AES-256-GCM and a fresh 12-byte IV,
in a versioned base64 envelope. The gateway seals, the admin opens, so both need the same value. A
missing secret falls back to a development value so sealing never refuses; `sealKeyStatus` reports
`missing`, `too-short` or `publicly-known`, which the gateway console (once per process, at the first
sealed prompt of a light trace or the first raw capture), the admin's status and the start dialog show. Responses that carry opened
content are sent with `Cache-Control: no-store`. No unmasked content may leave the gateway process in the clear: not in Valkey, the database,
a backup, an audit row or a log line.

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
