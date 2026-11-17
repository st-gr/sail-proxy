# Gateway tests

The gateway's Jest suites. The testing guide, [docs/developer/testing-strategy.md](../../../docs/developer/testing-strategy.md), describes the approach, the shared test utilities and how CI runs the suites; this file says what is in this folder and how to run it.

## Layout

Jest (`ts-jest`, `jest.config.json`) picks up every `*.test.ts` under `test/` and `src/`. `test/setupTests.ts` runs before every suite. The timeout is 30 seconds per test.

Most suites sit directly in `test/`, named after the feature they cover. The subfolders:

| Folder | Content |
|---|---|
| `clients/`, `config/` | The admin service client and the authentication configuration (`pnpm test:unit` runs these two folders) |
| `integration/` | The admin client, API key validation and its cache, configuration, AWS credentials and service-key authentication. `gateway-startup.test.ts` is excluded in `jest.config.json`; `DISABLED_TESTS.md` says why |
| `unit/` | Image dimension and image token suites |
| `upstreams/` | The adapters and dispatch for external providers |
| `fileSearch/` | The file search tool |
| `realtime/` | The realtime relay |
| `live/` | `*.live.test.ts`: calls to real external providers, skipped unless `CONNECTIONS_LIVE=1` |
| `pseudonymization-precision/` | The precision measurement of the pseudonymization plugin, with its own README |
| `fixtures/`, `helpers/` | Recorded payloads, golden files and helpers the suites share |

## Running

From `services/gateway`:

| Command | Runs |
|---|---|
| `pnpm test` | Every suite |
| `pnpm test:unit` | `test/clients/` and `test/config/` |
| `pnpm test:integration` | `test/integration/` |
| `pnpm test:usage` | Suites whose path matches `usage-tracking` |
| `pnpm test:pseudonymization` | Suites whose path matches `pseudonymization` |
| `pnpm test:pseudonymization:integration` | The script `test/test-pseudonymization.ts` |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Every suite, with coverage |

One suite, by a part of its path:

```bash
pnpm test token-count-service
```

Jest flags go right after the script name (`pnpm test --verbose token-count-service`). After a `--` separator Jest reads a flag as a path pattern.

From the repository root, `pnpm test:gateway`, `pnpm test:gateway:unit`, `pnpm test:gateway:integration` and `pnpm test:gateway:usage` run the same scripts.

## Suites that need an environment

A bare local run skips the suites whose environment is missing:

- The file search database suites need `FILE_SEARCH_TEST_DSN`, the S3 suites the `FILE_SEARCH_TEST_S3_*` variables.
- The live-call suites need a SAP AI Core service key.
- The suites in `live/` need `CONNECTIONS_LIVE=1` and the provider's key.

The CI pipeline (`pnpm run ci` from the repository root) provides the database, the object store and the service key, so a green local `pnpm test` does not show that these suites pass.

## Test data

Use invented names and values in tests and fixtures, and placeholders that are recognisably fake for keys and secrets. Never copy a name, an address or a credential from a payload log or an `.env` file into this folder.
