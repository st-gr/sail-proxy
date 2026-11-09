---
title: Environment variables
description: Every environment variable of the gateway and the admin service, grouped as in their .env.sample files.
---

# Environment variables

The gateway reads `services/gateway/.env` and the admin service reads `services/admin/.env`. Each has a commented template next to it, `.env.sample`, and the tables below follow the order of those templates. The standalone CLI writes the gateway's variables for you ([Standalone CLI](/deploy/cli)); Docker and Kyma take them from the files and secrets described in [Docker Compose](/deploy/docker) and [SAP BTP Kyma](/deploy/kyma).

Settings that can change at runtime, such as model substitutions or logging levels, are not environment variables but keys of the [gateway configuration](/reference/configuration).

## Gateway

### Core service configuration

| Variable | Sample value | Description |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment: `development`, `production` or `test` |
| `LOG_LEVEL` | `INFO` | Log level: `ERROR`, `WARN`, `INFO`, `DEBUG` or `TRACE` |
| `PORT` | `3000` | Port the gateway listens on |

### Reverse proxy and client IP

| Variable | Sample value | Description |
|---|---|---|
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse proxies in front of the gateway. `0` ignores forwarded headers and uses the socket peer. Measure the value against your ingress chain: send a request from a known address and raise the value until the `clientIP` of the resulting security event matches it |

### SAP AI Core integration

| Variable | Sample value | Description |
|---|---|---|
| `SAP_AI_CORE_URL` | `https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com` | SAP AI Core API URL, from the service key |
| `SAP_AI_RESOURCE_GROUP` | `default` | SAP AI Core resource group |
| `SAP_AI_REGION` | `prod.us-east-1` | SAP AI Core region |
| `SAP_DEPLOYMENT_URL_BASE` | unset | CI only: routes SAP deployment URLs through a relay. Leave unset |
| `AUTH_URL` | `https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token` | OAuth token URL, from the service key |
| `CLIENT_ID` | | OAuth client id, from the service key |
| `CLIENT_SECRET` | | OAuth client secret, from the service key |

### SAP AI Core deployment configuration

| Variable | Sample value | Description |
|---|---|---|
| `SAP_AI_DEPLOYMENT_ID` | unset | A fixed orchestration deployment id. Alternative to auto-discovery |
| `SAP_AI_AUTO_DISCOVER_DEPLOYMENT` | `true` | Find a running orchestration deployment automatically |
| `SAP_AI_DEPLOYMENT_FILTER_SCENARIO` | `orchestration` | Scenario id auto-discovery considers |
| `SAP_AI_DEPLOYMENT_CACHE_TTL_SECONDS` | `604800` | How long a discovered deployment is cached, in seconds (default 300) |

### Unified authentication system

| Variable | Sample value | Description |
|---|---|---|
| `GATEWAY_STANDALONE` | `false` | `true` forces standalone mode: no admin service, no Valkey, whatever else is set |
| `RATE_LIMIT_RPM` | unset | Standalone only: requests per minute per API key, counted in memory (default 100). With an admin service, per-key limits come from the credential |
| `UNIFIED_TOKEN_SYSTEM_ENABLED` | `true` | Validate credentials through the admin service. Without `true`, the gateway runs standalone |
| `UNIFIED_AUTH_FALLBACK_TO_LOCAL` | `true` | Fall back to local validation when the admin service is unavailable |
| `UNIFIED_AUTH_CACHE_TTL_SECONDS` | `300` | Cache lifetime of validation responses, in seconds |
| `UNIFIED_AUTH_TOKEN_CACHE_TTL_SECONDS` | `60` | Cache lifetime of token validation data, in seconds |
| `UNIFIED_AUTH_CACHE_MAX_SIZE` | `5000` | Maximum entries in the validation cache |
| `UNIFIED_AUTH_CACHE_ENCRYPT_SECRETS` | `true` | Encrypt sensitive data in the cache |
| `UNIFIED_AUTH_REQUEST_TIMEOUT_MS` | `5000` | Timeout of requests to the admin service, in milliseconds |
| `UNIFIED_AUTH_MAX_RETRY_ATTEMPTS` | `3` | Retries of failed admin service requests |
| `UNIFIED_AUTH_CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before the circuit breaker opens |
| `UNIFIED_AUTH_CIRCUIT_BREAKER_TIMEOUT_MS` | `30000` | Circuit breaker timeout, in milliseconds |
| `UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS` | `30000` | Admin service health check interval, in milliseconds |

The gateway runs standalone when `GATEWAY_STANDALONE` is `true`, or when `UNIFIED_TOKEN_SYSTEM_ENABLED` is not `true`, or when `VALKEY_URL` or `ADMIN_SERVICE_URL` is empty. Standalone means no admin service, a local in-memory cache and the [standalone administration endpoints](/reference/authentication#administration-endpoints).

### Admin service integration

| Variable | Sample value | Description |
|---|---|---|
| `ADMIN_SERVICE_URL` | `http://localhost:4004` | Admin service URL. Empty means standalone |
| `ADMIN_SERVICE_TIMEOUT` | `10000` | Admin service request timeout, in milliseconds |
| `ADMIN_SERVICE_RETRIES` | `2` | Retries of admin service requests |
| `ADMIN_SERVICE_RETRY_DELAY` | `1000` | Delay between retries, in milliseconds |
| `CONFIG_FETCH_RETRIES` | `8` | Retries when fetching the configuration from the admin service |
| `CONFIG_FETCH_INITIAL_DELAY` | `2000` | Initial delay of those retries, in milliseconds |
| `CONFIG_FETCH_MAX_DELAY` | `30000` | Maximum delay of those retries, in milliseconds |
| `VALIDATION_TOKEN_SECRET` | | Shared secret for the service tokens between gateway and admin service; must be the same in both. AWS SigV4 through the admin service needs it. Generate a 64-character hex string |
| `METADATA_ENCRYPTION_KEY` | | Encryption key for metadata; must match the admin service. 64-character hex string |

Generate each secret with, for example, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Cache configuration

| Variable | Sample value | Description |
|---|---|---|
| `VALKEY_URL` | `redis://localhost:6379` | Valkey or Redis URL for the distributed cache. Empty means a local cache only (and standalone mode) |
| `VALKEY_HOST` | unset | Host of the pseudonymization plugin's entity cache, which does not read `VALKEY_URL`. Unset keeps that cache in memory, per process. `REDIS_HOST` is accepted as a fallback |
| `VALKEY_PORT` | `6379` | Port for `VALKEY_HOST`. `REDIS_PORT` is accepted as a fallback |
| `CONFIG_CHANGE_CHANNEL` | `sap-llm-gateway:config-changed` | Valkey pub/sub channel for configuration changes. Change it when a second gateway shares a Valkey with a live one: channels are global, so a second gateway on the default channel overwrites the live one's configuration |

### File search configuration

| Variable | Sample value | Description |
|---|---|---|
| `FILE_SEARCH_DATABASE_URL` | unset | PostgreSQL DSN with the pgvector extension for the `file_search` endpoints; falls back to `POSTGRES_URL`. Unset, every file search endpoint answers `503 file_search_unavailable`. For local development, give it its own database |
| `FILE_SEARCH_MIGRATION_DATABASE_URL` | unset | Optional separate, privileged credential for the schema migration, so the running gateway holds no `CREATE` rights |
| `FILE_SEARCH_MIGRATE_NEVER_BLOCK` | `false` | `true` lets a failed migration pass the deploy step; file search then answers `503` |
| `FILE_SEARCH_S3_ACCESS_KEY_ID` | unset | S3 access key for the `s3` blob storage backend ([File storage](/deploy/file-storage)) |
| `FILE_SEARCH_S3_SECRET_ACCESS_KEY` | unset | S3 secret key for the `s3` blob storage backend |
| `FILE_SEARCH_OCR` | `auto` | `off` disables OCR of scanned PDF pages even where `tesseract` is installed. The standalone CLI sets `off` |
| `FILE_SEARCH_VISION` | `auto` | `off` disables vision transcription of PDF pages even for stores that opted in. The standalone CLI sets `off` |
| `FILE_SEARCH_DOC` | `auto` | `off` disables reading legacy `.doc` files even where `antiword` is installed. The standalone CLI sets `off` |
| `TESSDATA_PREFIX` | unset | Directory with the `.traineddata` files OCR uses, when it is not tesseract's built-in data directory |

Converting documents also needs `pandoc` and `pdftotext` on `PATH`. Reranker teacher-label collection has no environment variable; it is configured under `capabilities.file_search.teacher_logging` in the [gateway configuration](/reference/configuration).

### Development and debugging

| Variable | Sample value | Description |
|---|---|---|
| `DEBUG` | `false` | `true` turns on verbose logging and creates test AWS credentials from the three `TEST_AWS_*` variables |
| `TEST_AWS_ACCESS_KEY_ID` | | Access key id of the test AWS credentials (only with `DEBUG=true`) |
| `TEST_AWS_SECRET_ACCESS_KEY` | | Secret key of the test AWS credentials (only with `DEBUG=true`) |
| `TEST_AWS_SALT` | | Salt of the test AWS credentials (only with `DEBUG=true`) |
| `PAYLOAD_LOGGING_ENABLED` | `false` | `true` or `false` overrides the configuration key `platform.logging.payload_logging_enabled` in either direction. Payload logs contain full request and response bodies |
| `LOG_FOLDER_PATH` | `./logs` | Fallback folder for payload logs, used only when the configured `platform.logging.log_folder_path` cannot be read |
| `WEBSEARCH_FORCE_ORCHESTRATION` | `false` | `true` sends web search through SAP orchestration instead of a direct Perplexity deployment; citations are then of lower quality |
| `SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES` | `true` | Include extended model attributes in model responses |
| `SAP_MODEL_CACHE_DURATION_SECONDS` | `3600` | How long model information is cached, in seconds |
| `IMAGE_TOKEN_OVERHEAD` | `85` | Fixed tokens added per image when the gateway counts image input tokens itself (orchestration route only) |

### Optional advanced configuration

| Variable | Sample value | Description |
|---|---|---|
| `CONFIG_FILE_PATH` | `./api_config.json` | Path of the gateway configuration file |
| `CONNECTIONS_FILE_PATH` | not set (commented out) | Standalone only: path of the connections file (`connections.json`). Unset, the gateway uses `connections.json` next to the configuration file. The `sail-proxy` CLI sets it to the file in its configuration directory |
| `CONFIG_BACKUP_DIR` | `./config-backups` | Directory for configuration backups |
| `MAX_CONFIG_BACKUPS` | `10` | Number of configuration backups kept |
| `CONFIG_BACKUP_RETENTION_DAYS` | `30` | Days configuration backups are kept |
| `AUDIT_LOG_DIR` | `./logs/audit` | In the sample; not read by the current code |
| `ENABLE_AUDIT_ENCRYPTION` | `true` | In the sample; not read by the current code |
| `AZURE_AUTHORITY_HOST` | `https://login.microsoftonline.com` (commented out) | Microsoft Entra authority for Azure OpenAI connections that sign in with a client secret. Set it only for a sovereign cloud |

## Admin service

### Database

The admin service is a CAP application; it reads its database settings as `cds.*` keys in dot notation.

| Variable | Sample value | Description |
|---|---|---|
| `cds.requires.db.kind` | `postgres` | Database kind: `postgres`, or `sqlite` for local development |
| `cds.requires.db.impl` | `@cap-js/postgres` | Database driver |
| `cds.requires.db.credentials.host` | `postgres` | PostgreSQL host |
| `cds.requires.db.credentials.port` | `5432` | PostgreSQL port |
| `cds.requires.db.credentials.user` | | PostgreSQL user |
| `cds.requires.db.credentials.password` | | PostgreSQL password |
| `cds.requires.db.credentials.database` | `sap_llm_gateway` | Database name; for SQLite, the file, for example `db/admin.db` |
| `cds.requires.db.schema_evolution` | `auto` | Schema evolution mode |
| `cds.sql.dialect` | `postgres` | SQL dialect |
| `DB_PATH` | commented out | In the sample; not read by the current code |

### Gateway, cache and security

| Variable | Sample value | Description |
|---|---|---|
| `GATEWAY_URL` | `http://localhost:3000` | Gateway URL |
| `VALKEY_URL` | `redis://localhost:6379` | Valkey or Redis URL for the distributed cache |
| `VALIDATION_TOKEN_SECRET` | | Must be the same value as in the gateway. Also signs the gateway's service token; outside `NODE_ENV=development`, AWS SigV4 signing keys are never handed out while it is unset or the built-in default |
| `METADATA_ENCRYPTION_KEY` | | Must be the same value as in the gateway |
| `INSTALLED_PLUGINS_ENABLED` | on (unset) | `false` switches off installing gateway plugins from the cockpit: uploads and enabling are refused, and installed plugins are removed from the gateways when they next hear from the admin. Plugins that ship with the gateway are not affected, and disabling and removing stay available. See [Plugins](/guide/cockpit/plugins#switching-installation-off) |
| `AWS_SECRET_ENCRYPTION_KEY` | | Encrypts stored AWS secret access keys. Keep it across upgrades and restores ([Backup, restore and upgrade](/deploy/backup-and-upgrade)) |

### Runtime and sign-in

| Variable | Sample value | Description |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment |
| `DEPLOY_TARGET` | `development` | `development`, `docker`, `xsuaa`, `btp` or `xsa`; selects the sign-in method |
| `ROLE_MAPPING` | `{"sap-llm-gateway-admin":"admin","sap-llm-gateway-user":"user"}` | JSON map from identity provider groups to roles ([Roles](/guide/roles)) |
| `OAUTH2_PROXY_OIDC_ISSUER_URL` | `http://dex:5556/dex` | OIDC issuer URL for JWT validation behind oauth2-proxy |
| `IDENTITY_PROVIDER` | `local` | Only `local` changes behaviour: with `local` and no groups on the request, roles come from `LOCAL_USER_MAPPING` |
| `LOCAL_USER_MAPPING` | unset | JSON map from email to role, for example `{"admin@example.com":"admin"}`. A missing entry or invalid JSON yields the role `user` |
| `BASE_URL` | unset | Public base URL of the admin service, for the post-logout redirect. Set it behind any proxy, for example `https://sail.example.com` |
| `LOGOUT_REDIRECT_URL` | unset | Where to go after logout; defaults to `${BASE_URL}/admin/shell/index.html` |
| `DEV_SESSION_SECRET` | unset | Session secret, read only with `DEPLOY_TARGET=development`; falls back to an insecure built-in value |
| `DEBUG_METADATA` | unset | Any value logs decoded JWT metadata on the Docker sign-in path. It prints token contents |
| `SAP_AI_REGION` | `us-east-1` | SAP AI Core region recorded on generated AWS credentials |

### Audit, SIEM, notifications and logging

| Variable | Sample value | Description |
|---|---|---|
| `AUDIT_RETENTION_DAYS` | `90` | In the sample; not read by the current code |
| `ENABLE_AUDIT_ENCRYPTION` | `true` | In the sample; not read by the current code |
| `SIEM_CREDENTIAL_KEY` | | Master key encrypting stored SIEM sink credentials. Changing it makes them undecryptable; they must be entered again |
| `CONNECTION_CREDENTIAL_KEY` | | Master key encrypting stored Connection credentials (external provider API keys and secrets). No default: without it no connection credential can be stored. Changing it makes them undecryptable; they must be entered again |
| `SECURITY_NOTIFICATION_MIN_DELETE_AGE_DAYS` | `30` | Minimum age in days before a security notification can be deleted |
| `SECURITY_NOTIFICATION_MAX_SNOOZE_DAYS` | `30` | Maximum days a security notification can be snoozed |
| `UPDATE_CHECK_ENABLED` | `true` | The cockpit shows a banner when a newer release exists, checked from the browser at most once a day. `false`, `0`, `no` or `off` turns the banner off |
| `LOG_LEVEL` | `info` | Log level |
| `PORT` | `4004` | Port the admin service listens on |

## Standalone CLI and upgrade command

These variables are read by the `sail-proxy` command line, not by the services.

| Variable | Default | Meaning |
|---|---|---|
| `SAIL_PROXY_UPDATE_CHECK` | on | `false` stops the CLI from asking npm whether a newer version exists. Without it the CLI asks at most once a day |
| `SAIL_PROXY_BACKUP_PASSPHRASE` | unset | Passphrase (at least 12 characters) for the backup of `sail-proxy upgrade` and for `sail-proxy restore`. Unset, the command asks at a hidden prompt. Prefer the prompt on a shared machine: other users can read a process's environment |

See [Upgrade on Kyma](/deploy/upgrade-kyma) and [Upgrade on Docker](/deploy/upgrade-docker).

## Ollama service

The Ollama-compatible service has its own `.env`; its variables are listed on [Ollama API](/reference/ollama-api#configuration).
