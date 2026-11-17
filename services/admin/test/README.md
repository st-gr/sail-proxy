# Admin service tests

The admin service's Jest suites. The testing guide, [docs/developer/testing-strategy.md](../../../docs/developer/testing-strategy.md), describes the approach, the shared test utilities, the cockpit's UI journeys and how CI runs the suites; this file says what is in this folder and how to run it.

## Layout

Jest (`ts-jest`, `services/admin/jest.config.js`) picks up every `*.test.ts` and `*.spec.ts` under `test/` and under the `test/` folder of the cockpit apps that have one. `test/setupTests.ts` runs before every suite. The suites run in one worker, with a timeout of 30 seconds per test, against SQLite.

| Folder | Content |
|---|---|
| `unit/` | Suites without a running service, grouped in `services/`, `srv/`, `config/`, `entities/`, `middleware/`, `i18n/`, `ui/`, `utils/` and `ci/` |
| `integration/` | Suites that start the service in the test process or call a running one; `http/` holds the HTTP and OData suites (with its own README), `services/` the cost, usage and reconciliation services |
| `security/` | `security-simple.test.ts` |
| `cli-tools/` | Suites for the reconciliation tools in `cli-tools/` |
| `fixtures/` | The test data factory and sample payloads |
| `__mocks__/` | Module mocks |
| `bruno/` | A Bruno collection for manual API calls, with its own README |

Suites directly in `test/` cover one topic each, for example the Docker files, the nginx configuration or the plugin API.

## Running

From `services/admin`:

| Command | Runs |
|---|---|
| `pnpm test` | Every suite |
| `pnpm test:unit` | `test/unit/` |
| `pnpm test:integration` | `test/integration/` |
| `pnpm test:http` | `test/integration/http/` |
| `pnpm test:http:aws`, `pnpm test:http:config`, `pnpm test:http:analytics` | One HTTP suite each |
| `pnpm test:usage-processor`, `pnpm test:model-cost-service` | One suite each |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Every suite, with coverage |

One suite, by a part of its path:

```bash
pnpm test api-config-file
```

Jest flags go right after the script name (`pnpm test --verbose api-config-file`). After a `--` separator Jest reads a flag as a path pattern.

From the repository root, `pnpm test:admin`, `pnpm test:admin:unit`, `pnpm test:admin:integration` and `pnpm test:admin:http` run the same scripts.

## Suites that call a running admin service

Some integration suites send HTTP requests to a running admin service. They are declared with `describeLive` from `@libs/test-utils` and run only when `ADMIN_SERVICE_URL` is set, so a bare run skips them. Do not point `ADMIN_SERVICE_URL` at your own development admin: the suites create and activate test data there. The CI pipeline (`pnpm run ci` from the repository root) starts an admin service for them.

## Test data

Use invented names and values in tests and fixtures, and placeholders that are recognisably fake for keys and secrets. Never copy a name, an address or a credential from a payload log or an `.env` file into this folder.
