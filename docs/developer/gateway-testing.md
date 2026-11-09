---
title: Running and testing the gateway
description: Unit, integration and live suites, and how to run the gateway locally.
---

# Running & Testing the Gateway

## Local Development

### Starting the Gateway Service

**From project root**:
```bash
# Start gateway in development mode
pnpm run dev:gateway

# With specific environment
NODE_ENV=development pnpm run dev:gateway

# With debug logging (error, warn, info, debug, trace)
LOG_LEVEL=debug pnpm run dev:gateway
```

**From service directory**:
```bash
cd services/gateway
pnpm run dev            # nodemon + ts-node

# Production build and start (node dist/index.js)
pnpm run build
pnpm start
```

The gateway reads `services/gateway/.env`; see [Development setup](/developer/setup) for creating it.

### Stopping Stuck Processes

**Kill processes on Gateway port**:
```bash
sudo kill -9 $(sudo lsof -t -iTCP:3000 -sTCP:LISTEN)
```

**Comprehensive port cleanup**:
```bash
# Check what's using the port
lsof -i :3000

# Kill all Node.js processes (use with caution)
pkill -f node

# Or kill specific process by PID
kill -9 <process-id>
```

## Testing Framework

### Test Structure

**Gateway test organization**:
```
services/gateway/test/
├── setupTests.ts              # Global test setup (pins test servers to 127.0.0.1)
├── clients/                   # Admin service client tests (test:unit)
├── config/                    # Configuration tests (test:unit)
├── unit/                      # Further unit tests
├── integration/               # Integration tests (test:integration)
├── fileSearch/                # file_search suites, with fileSearch/integration/ for the DSN- and binary-gated ones
├── realtime/                  # Realtime relay suites
├── pseudonymization-precision/
├── fixtures/
└── *.test.ts                  # Most suites, including usage-tracking*.test.ts (test:usage)
```

### Running Tests

Every `test*` script except the two `test:pseudonymization*` scripts first builds `libs/test-utils` (`pretest*`), and every one except `test:pseudonymization:integration`, a ts-node script, runs Jest with `NODE_ENV=test`.

**All gateway tests**:
```bash
# From project root
pnpm test:gateway

# Specific test categories
pnpm test:gateway:unit         # test/clients/ and test/config/
pnpm test:gateway:integration  # test/integration/
pnpm test:gateway:usage        # suites matching usage-tracking

# From gateway service directory
cd services/gateway
pnpm test                      # All gateway tests
pnpm test:unit                 # test/clients/ and test/config/
pnpm test:integration          # test/integration/
pnpm test:pseudonymization     # suites matching pseudonymization

# One suite
pnpm test -- test/anthropic-stream-errors.test.ts
```

**Watch mode for development**:
```bash
pnpm test:watch
# Or from gateway directory
cd services/gateway && pnpm test:watch
```

**Coverage reports**:
```bash
pnpm test:coverage
```

### Test Configuration

**Jest configuration** (`services/gateway/jest.config.json`):
```json
{
  "preset": "ts-jest",
  "testEnvironment": "node",
  "roots": ["<rootDir>/test", "<rootDir>/src"],
  "testMatch": ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  "setupFilesAfterEnv": ["<rootDir>/test/setupTests.ts"],
  "testTimeout": 30000,
  "moduleNameMapper": {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@libs/(.*)$": "<rootDir>/../../libs/$1"
  },
  "clearMocks": true,
  "restoreMocks": true,
  "testPathIgnorePatterns": ["/node_modules/", "/dist/", "test/integration/gateway-startup.test.ts"],
  "forceExit": true
}
```

### Gated Suites and Their Environment

A bare local run skips the suites that need infrastructure or live credentials. They run when their variable is set:

| Variable | Enables |
|----------|---------|
| `FILE_SEARCH_TEST_DSN` | `file_search` suites against a PostgreSQL database with pgvector (each suite creates its own schema). Use a database of its own, never the one `FILE_SEARCH_DATABASE_URL` points at. |
| `FILE_SEARCH_TEST_BINARIES=1` | Extractor suites that spawn `pandoc`, `pdftotext`, `tesseract` and `antiword` |
| `FILE_SEARCH_TEST_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | `file_search` S3 blob storage suites (MinIO); `node ci/scripts/file-search-test-s3.js start` starts one and exports them |
| `FILE_SEARCH_LIVE_PROBE=1`, `FILE_SEARCH_LIVE_GATE`, `FILE_SEARCH_VISION_LIVE_PROBE=1`, `FILE_SEARCH_CONTEXT_LIVE_PROBE=1` | `file_search` live probes that send real model requests to SAP AI Core with the credentials in `services/gateway/.env` (embedder, the `file_search` tool, vision parsing, contextual chunking) |
| `ADMIN_SERVICE_URL` | `describeLive` suites that talk to a running admin service (they write rows into its database) |

`GATEWAY_URL` (default `http://localhost:3000`) and `ADMIN_SERVICE_URL` (default `http://localhost:4004`) are read by `libs/test-utils/src/test-config.ts`. The GitHub workflow (`.github/workflows/ci.yml`) sets `FILE_SEARCH_TEST_DSN` and `FILE_SEARCH_TEST_BINARIES` for the `pnpm run ci` step and starts MinIO, so the gated suites run there. The variables of the gateway itself are described in `services/gateway/.env.sample` and in [Environment variables](/reference/environment-variables).

### Live-Call Model Table

The model names the live-call tests use are kept in one file, `libs/test-utils/src/live-models.ts`, by role (`cheapChat`, `vision`, `reasoning`, `claude`, `gemini`, `nova`, `mistral`, `embedding`, `deployedTwin`); mocked tests keep their own literals. `cli-tools/check-test-models.js` reports live-call model names the gateway no longer routes or SAP AI Core is retiring and proposes successors:

```bash
# The gateway must run with SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true
GATEWAY_API_KEY=sk-... node cli-tools/check-test-models.js [--gateway-url URL] [--days N]

# Rewrite libs/test-utils/src/live-models.ts with the proposed successors
GATEWAY_API_KEY=sk-... node cli-tools/check-test-models.js --apply
```

Exit codes: `0` every live name is current, `1` a name is unknown, deprecated or expiring, `2` the gateway could not be read.

### Shared Test Utilities

```typescript
import { getGatewayUrl, liveModels, TestHelpers } from '@libs/test-utils';

describe('Gateway API Tests', () => {
  it('lists models', async () => {
    const response = await fetch(`${getGatewayUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` }
    });
    expect(response.status).toBe(200);
  });

  it('waits for a condition', async () => {
    const ready = await TestHelpers.waitForCondition(() => true, 1000);
    expect(ready).toBe(true);
    expect(liveModels.cheapChat).toBeDefined();
  });
});
```

The exports are listed on the [Workspace layout](/developer/workspace-layout) page.

## API Testing

### Manual API Testing

**Test model listing**:
```bash
# Test health endpoint
curl -X GET http://localhost:3000/health

# Test model listing (requires valid API key)
curl -X GET http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-your-api-key"

# Test OpenAI endpoint
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_completion_tokens": 50
  }'
```

**Test streaming**:
```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Count to 10"}],
    "stream": true
  }'
```

**Test Anthropic endpoint**:
```bash
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "x-api-key: sk-your-api-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "anthropic--claude-4.5-haiku",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### Integration Testing

The integration suites under `test/integration/` and most route suites build the Express router they test with `supertest` and stub the upstream (SAP AI Core, the admin service) with local servers or Jest mocks; `src/index.ts` is not imported, because it starts the server. Suites that need a running gateway read its URL from `getGatewayUrl()`.

## Performance Testing

### Load Testing

**Using artillery.js** (not part of the repository; an example configuration):
```yaml
# artillery-config.yml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 10
  defaults:
    headers:
      Authorization: 'Bearer sk-your-test-key'
      Content-Type: 'application/json'

scenarios:
  - name: 'Chat Completions'
    weight: 100
    flow:
      - post:
          url: '/openai/v1/chat/completions'
          json:
            model: 'gpt-5-mini'
            messages:
              - role: 'user'
                content: 'Hello world'
            max_tokens: 50
```

**Run load test**:
```bash
npm install -g artillery
artillery run artillery-config.yml
```

### Memory and CPU Profiling

**Node.js profiling**:
```bash
# After pnpm run build, from services/gateway
# CPU profiling
node --prof dist/index.js

# Heap profiling
node --inspect dist/index.js

# Memory usage monitoring
node --trace-gc dist/index.js
```

**Memory leak detection**:
```typescript
// Add to test setup
process.on('warning', (warning) => {
  console.warn('Node.js Warning:', warning);
});

// Monitor memory usage in tests
const getMemoryUsage = () => {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    external: Math.round(usage.external / 1024 / 1024)
  };
};
```

## Debugging

### Debug Configuration

**VS Code debugging** (`.vscode/launch.json`):
```json
{
  "configurations": [
    {
      "name": "Debug Gateway",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}/services/gateway",
      "program": "${workspaceFolder}/services/gateway/src/index.ts",
      "env": {
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug"
      },
      "runtimeArgs": ["-r", "ts-node/register", "-r", "tsconfig-paths/register"],
      "skipFiles": ["<node_internals>/**"],
      "console": "integratedTerminal"
    },
    {
      "name": "Debug Gateway Tests",
      "type": "node", 
      "request": "launch",
      "program": "${workspaceFolder}/services/gateway/node_modules/.bin/jest",
      "args": ["--config", "jest.config.json", "--runInBand", "--no-cache"],
      "env": { "NODE_ENV": "test" },
      "cwd": "${workspaceFolder}/services/gateway",
      "console": "integratedTerminal"
    }
  ]
}
```

### Logging Configuration

**Log levels**: the shared logger (`libs/logger`) has the levels `error`, `warn`, `info`, `debug` and `trace`. `LOG_LEVEL` sets the level; the gateway configuration can set levels per component. The debugging page of this section describes log level resolution.

**Structured logging**:
```typescript
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// component, message, metadata
logger.info('ChatController', 'Request processed', {
  requestId: (req as any).debugRequestId,
  endpoint: req.path,
  duration: Date.now() - startTime
});
```

## Continuous Integration

### GitHub Actions

The workflow `.github/workflows/ci.yml` installs Node 24 and pnpm 10, the `file_search` extractor binaries, a pgvector service container and MinIO, and runs `pnpm run ci` (`ci/preflight.js`, then `ci/ci-pipeline.js`) with `NODE_ENV=test`, SQLite for the admin tests and the gated `file_search` suites switched on. The pipeline is described in `ci/CI_PIPELINE.md`.

Calls from GitHub-hosted runners to SAP AI Core can stall (the connection opens, then no response arrives), while the
same calls from inside a Kyma cluster do not. The CI pipeline can therefore route the gateway's SAP traffic through a
small relay that you run in your own Kyma cluster: set the repository secret `SAP_RELAY_BASE`, and the gateway started
by the pipeline uses the relay for every SAP call, including the deployment URLs SAP returns
(`SAP_DEPLOYMENT_URL_BASE`). Without the secret, nothing changes and SAP is reached directly. Setup, operation and key
rotation are in `ci/sap-relay/README.md`.

### Pre-commit Hooks

The pre-commit hook (`cli-tools/pre-commit-checks.js`) runs no tests; it synchronizes `api_config.json` and runs the validation checks described in [Development setup](/developer/setup).

## Environment-Specific Testing

### Test Environments

**CI testing** (the environment the workflow sets for the gateway suites):
```bash
NODE_ENV=test CI=true \
FILE_SEARCH_TEST_DSN=postgresql://postgres:postgres@localhost:55432/filesearch_test \
FILE_SEARCH_TEST_BINARIES=1 \
pnpm test:gateway
```

**Integration testing with real SAP AI Core**: the live probes load the SAP AI Core credentials from `services/gateway/.env` themselves; set only their gate variable (table above), for example:
```bash
cd services/gateway
FILE_SEARCH_LIVE_PROBE=1 pnpm test -- test/fileSearch/integration/embedder.test.ts
```
