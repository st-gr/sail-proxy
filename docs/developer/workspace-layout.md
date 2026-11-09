---
title: Workspace layout
description: Packages, folders and conventions of the pnpm monorepo.
---

# Workspace Layout

This repository is organized as a monorepo using pnpm workspaces. Each service and library with its own `package.json` is a separate package; the workspace configuration is defined in `pnpm-workspace.yaml` at the root of the repository.

## Monorepo Structure

**Root Directory Organization**:
```
sail-proxy/
├── services/                  # The services
│   ├── gateway/               # Gateway: routing, translation and provider integration
│   ├── admin/                 # Admin service (SAP CAP) and the Admin Cockpit apps
│   └── ollama/                # Ollama-compatible adapter service
├── libs/                      # Shared code, imported through the @libs/* path alias
│   ├── test-utils/            # Shared test utilities (package @sap-llm-gateway/test-utils)
│   ├── service-key-parser/    # SAP service key parser (package @sap-llm-gateway/service-key-parser)
│   ├── logger/                # Shared logger
│   ├── types/                 # Shared TypeScript types
│   ├── config/                # Shared configuration types and helpers
│   ├── service-auth/          # Service-to-service authentication
│   ├── aws-token-validation/  # Validation tokens and metadata exchange
│   ├── aws-signing/           # S3 request signing
│   └── cache-invalidation/    # Cache invalidation service
├── npm-dist/
│   └── sail-proxy/            # The npm-installable standalone CLI (@st-gr/sail-proxy)
├── docker/                    # Dockerfiles, docker-compose.yml, nginx and setup-docker.js
├── kyma/                      # SAP BTP Kyma deployment (scripts and templates)
├── ci/                        # Local CI pipeline (pnpm run ci) and CI helper scripts
├── docs/                      # This documentation site (VitePress)
├── cli-tools/                 # Development CLI utilities
├── scripts/
│   └── setup-git-hooks.js     # Git hooks installer
├── package.json               # Root package (sap-llm-gateway) with the workspace scripts
├── pnpm-workspace.yaml        # Workspace configuration
└── eslint.config.mjs          # ESLint flat configuration
```

## Workspace Configuration

**pnpm Workspace Setup** (`pnpm-workspace.yaml`):
```yaml
packages:
  - "services/*"
  - "services/*/app/*"
  - "libs/*"
  - "npm-dist/*"
  - "docs"

node-linker: isolated
hoist-pattern: ["*"]
package-import-method: hardlink
```

`services/*/app/*` makes every cockpit UI5 app under `services/admin/app/` a workspace package of its own. Only `libs/test-utils` and `libs/service-key-parser` have a `package.json` of their own; the other folders under `libs/` are plain source folders that the services compile in.

**Root Package Configuration** (`package.json`): the root package is private, named `sap-llm-gateway`, and pins `packageManager: pnpm@10.12.4`. Its scripts delegate to the packages with `pnpm --filter`:

```json
{
  "scripts": {
    "build": "pnpm --filter @sap-llm-gateway/test-utils build && pnpm --filter @sap-llm-gateway/service-key-parser build && pnpm run --recursive build",
    "dev:gateway": "cross-env DEPLOY_TARGET=local pnpm --filter gateway dev",
    "dev:admin": "cross-env DEPLOY_TARGET=local pnpm --filter admin dev",
    "dev:all": "run-p dev:gateway dev:admin",
    "test:gateway": "pnpm --filter gateway test",
    "test:admin": "pnpm --filter admin test",
    "test:all": "pnpm run --recursive test",
    "ci": "node ci/preflight.js && node ci/ci-pipeline.js",
    "setup:dev": "node cli-tools/create-dev-env-config.js"
  }
}
```

## Service Directory Structure

### Gateway Service (`services/gateway/`)

```
services/gateway/
├── src/
│   ├── index.ts               # Application entry point (Express app, middleware and routes)
│   ├── routes/                # Route definitions per API family
│   ├── controllers/           # Request handlers (OpenAI, Anthropic, Bedrock, Google, files, …)
│   ├── services/              # Translation, provider clients, usage tracking, configuration
│   ├── middlewares/           # API key auth, quota enforcement, model substitution, error handler
│   ├── plugins/               # Built-in plugins (pseudonymization, file_search, custom tools, …)
│   ├── toolGovernance/        # Tool policy evaluation and recording
│   ├── fileSearch/            # Hosted file_search: extractors, chunking, vector stores
│   ├── realtime/              # OpenAI Realtime WebSocket relay
│   ├── responses/             # Responses API bridge to orchestration
│   ├── google/                # Gemini bridge to orchestration
│   ├── sapRpt/                # SAP-RPT tabular prediction helpers
│   ├── clients/               # Admin service client
│   ├── config/                # Unified authentication configuration
│   ├── types/                 # Gateway-local types
│   └── utils/                 # Utility functions
├── test/
│   ├── setupTests.ts          # Global test setup
│   ├── clients/  config/      # Unit tests (test:unit)
│   ├── unit/                  # Further unit tests
│   ├── integration/           # Integration tests (test:integration)
│   ├── fileSearch/  realtime/ # Feature suites
│   └── *.test.ts              # Most suites live directly under test/
├── scripts/                   # file_search evaluation and benchmark scripts
├── config/local.json          # Local configuration
├── api_config.json            # Gateway configuration file (source of the synced copies)
├── package.json               # Service dependencies and scripts
├── package.docker.json        # Manifest used by the Docker image
├── tsconfig.json              # TypeScript configuration
├── jest.config.json           # Jest test configuration
└── .env.sample                # Environment variable template
```

### Admin Service (`services/admin/`)

```
services/admin/
├── app/                       # Admin Cockpit: the shell and one UI5 app per tile
│   ├── shell/                 # Navigation shell
│   ├── api-keys-app/  aws-credentials-app/  usage-analytics-app/
│   ├── security-notifications-app/  model-library-app/  grounding-app/
│   ├── users-app/  tool-policies-app/  config-app/  sap-rates-app/
│   ├── connections-app/  plugins-app/
│   └── services.cds           # Annotations shared by the apps
├── src/
│   ├── index.ts               # Server start (cds serve, or programmatic start for Docker)
│   ├── db/                    # CDS data model (schema.cds, data-model.cds) and seed data
│   ├── srv/                   # CDS services (admin-service.cds, validation-service.cds) and handlers
│   ├── services/              # Business logic (usage processing, costs, quotas, users, …)
│   ├── auth/  middleware/     # Authentication setup and middleware
│   ├── siem/                  # SIEM export
│   ├── schemas/               # JSON schemas (gateway configuration)
│   └── utils/                 # Utility functions
├── test/
│   ├── setupTests.ts          # Global test setup
│   ├── unit/                  # Unit tests
│   ├── integration/           # Integration tests
│   │   └── http/              # HTTP endpoint tests
│   ├── security/              # Security tests
│   └── bruno/                 # API testing collections
├── _i18n/                     # Service-level translations
├── config/local.json          # Local configuration
├── server.js                  # CAP custom server bootstrap
├── .cdsrc.json                # CAP runtime configuration
├── package.json               # CAP dependencies, scripts and cds.requires
├── package.docker.json        # Manifest used by the Docker image
└── .env.sample                # Environment variable template
```

### Ollama Service (`services/ollama/`)

```
services/ollama/
├── index.js                   # Express entry point
├── routes/                    # ollamaRoutes.js, openaiRoutes.js
├── controllers/               # ollamaController.js
├── services/                  # ollamaAdapter.js, shared.js
├── test/                      # unit/ and integration/
└── .env.sample
```

## Shared Libraries (`libs/`)

### Test Utilities (`libs/test-utils/`)

```
libs/test-utils/
├── src/
│   ├── index.ts               # Package entry point (built to dist/)
│   ├── port-utils.ts          # Free-port helpers
│   ├── test-config.ts         # Service URLs, describeLive
│   ├── live-models.ts         # The models the live-call suites use
│   ├── loopback-listen.ts     # Pins test servers to 127.0.0.1
│   └── active-config-guard.ts # Guards the active gateway configuration in tests
├── package.json
└── tsconfig.json
```

The tests import it through the path alias; the package must be built first (every `pretest*` script runs `pnpm --filter @sap-llm-gateway/test-utils build`):
```typescript
import {
  getAdminServiceUrl,
  getGatewayUrl,
  pinEphemeralServersToLoopback,
  describeLive,
  liveModels
} from '@libs/test-utils';

// Suites that need a running admin service run only when ADMIN_SERVICE_URL is set
describeLive('admin round trip', () => { /* … */ });

// Model ids for live calls come from one table
const model = liveModels.cheapChat;
```

### Logger, Types and the Other Libraries

`libs/logger/index.ts`, `libs/types/*.ts` (`api.ts`, `auth.ts`, `config.ts`, `providers.ts`) and the other folders are single-file or few-file modules without a package of their own. The services import them as `@libs/<folder>`, for example `import { getDefaultLogger } from '@libs/logger';`.

## TypeScript Configuration

There is no shared base configuration. Each service has its own `tsconfig.json`; the gateway's and the admin service's set `baseUrl` to the repository root, map `@libs/*` to `libs/*` and compile the `libs/` sources together with the service:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "../..",
    "strict": true,
    "baseUrl": "../..",
    "paths": {
      "@libs/*": ["libs/*"]
    }
  },
  "include": ["src/**/*", "../../libs/**/*", "../../config/**/*"]
}
```

Jest resolves the same alias with `moduleNameMapper` (`"^@libs/(.*)$": "<rootDir>/../../libs/$1"`), and the dev scripts register it at runtime with `tsconfig-paths/register`.

## Build and Development Scripts

The root `package.json` scripts call the package scripts through `pnpm --filter`; `pnpm run build` builds the two library packages first and then every package. The commands are listed in [Development setup](/developer/setup) and [Running and testing the gateway](/developer/gateway-testing).

## Development CLI Tools (`cli-tools/`)

The `cli-tools/` directory contains Node.js scripts for development workflow automation, git hooks, and project maintenance tasks.

### Git Hook Scripts

**Pre-commit Validation** (`pre-commit-checks.js`):
- Orchestrates all pre-commit validation checks
- Automatically runs before each git commit
- Ensures code quality and consistency before commits reach the repository
- Called by `.git/hooks/pre-commit`
- Also rejects staged text files with literal NUL bytes (`check-nul-bytes.js`)

Individual validation scripts called by pre-commit-checks:

**API Config Synchronization** (`sync-api-config.js`):
- Ensures three `api_config.json` files remain identical
- Source: `services/gateway/api_config.json`
- Auto-syncs to: `services/admin/api_config.json` and `npm-dist/sail-proxy/src/templates/api_config.template.json`
- Automatically stages synced files in your commit
- Triggers only when any api_config file is being committed

**Workspace Protocol Check** (`check-workspace-protocol.js`):
- Validates that `npm-dist/sail-proxy/package.json` uses `workspace:*` protocol
- Prevents accidental commits of concrete dependency versions
- Ensures proper monorepo workspace dependencies

**PostgreSQL Credentials Check** (`check-postgres-credentials.js`):
- Auto-fixes PostgreSQL credentials to safe defaults in docker configs
- Prevents accidental leakage of production credentials
- Checks: `docker/docker-compose.yml` and `docker/configs/providers/*/dex.config*.yaml`
- Sets credentials to: `admin_user`/`admin_password`

### Project Setup Scripts

**Git Hooks Installer** (`scripts/setup-git-hooks.js`):
- Installs pre-commit hooks into `.git/hooks/`
- Automatically runs during `pnpm install` via postinstall script
- Can be manually run: `node scripts/setup-git-hooks.js`
- Cross-platform compatible (Windows, macOS, Linux)

**Development Environment Setup** (`create-dev-env-config.js`):
- Runs `docker/setup-docker.js` interactively (it asks for the SAP AI Core service key), then patches `services/admin/.env` for SQLite local development
- Creates the services' `.env` files
- Usage: `pnpm run setup:dev`

### Maintenance and Utility Scripts

**Version Synchronization** (`sync-version.js`):
- Ensures version consistency across all package.json files
- Syncs the version from the root to the libs, the services, `docker/package.json`, `npm-dist/sail-proxy` and the services' `package.docker.json`
- Usage: `pnpm run version:sync`

**Header Management** (`manage-headers.js`):
- Manages source file headers (license, copyright, etc.)
- Ensures consistent header format across all source files

**Package Preparation** (`prepare-for-pack.js`, `restore-workspace-protocol.js`):
- Prepares packages for npm publishing
- Temporarily replaces `workspace:*` with concrete versions
- Restores workspace protocol after packaging

**Model Deployment** (`sail-model-deploy.js`):
- CLI tool for deploying models to SAP AI Core
- Handles model registration and configuration

### Deployment Scripts

**Pod Deployment** (`deploy-to-pod.js`):
- Deploys compiled gateway `.js` files to a running Kubernetes pod without a full restart
- 5-step workflow: analyze changed files → build TypeScript → find pod → copy files → (optional) cache clear
- Accepts git commit IDs, commit ranges (`HEAD~3..HEAD`), or `--working` for uncommitted changes
- Path mapping logic converts TypeScript source paths to compiled JS paths in the container (e.g., `services/gateway/src/foo.ts` → `/app/services/gateway/dist/services/gateway/src/foo.js`)
- Also copies `.d.ts` declaration files alongside each `.js` file
- Automatically skips non-deployable files (tests, docs, api_config.json, Helm templates)
- Options:
  - `--working` — deploy uncommitted working tree changes (staged + unstaged)
  - `--dry-run` — show what would be copied without actually copying
  - `--skip-build` — skip the TypeScript build step (use when already built)
  - `--cache-clear` — clear Node module cache via inspector protocol (default: off)
  - `--no-cache-clear` — explicitly skip module cache clearing (default)
  - `--namespace <ns>` — Kubernetes namespace (default: `sail-proxy`)
  - `--container <name>` — container name (default: `gateway`)
  - `--selector <label>` — pod label selector (default: `app=gateway`)
- Post-deploy: push a config reload from the admin service to trigger the gateway to re-require modules and reload plugins with updated code
- Note: if `--cache-clear` fails, files are on disk but the running process still uses old code — a pod restart or admin config push is needed

### Usage Examples

**Running individual checks manually**:
```bash
# Check API config synchronization
node cli-tools/sync-api-config.js

# Validate workspace protocol
node cli-tools/check-workspace-protocol.js

# Report live-call test models the gateway no longer routes or SAP is retiring; --apply rewrites libs/test-utils/src/live-models.ts
node cli-tools/check-test-models.js

# Check PostgreSQL credentials
node cli-tools/check-postgres-credentials.js

# Run all pre-commit checks
node cli-tools/pre-commit-checks.js
```

**Reinstalling git hooks**:
```bash
node scripts/setup-git-hooks.js
```

**Setting up development environment**:
```bash
# Interactive setup
pnpm run setup:dev

# Force overwrite existing config
pnpm run setup:dev:force
```

**Deploying to a running pod**:
```bash
# Deploy uncommitted working tree changes
node cli-tools/deploy-to-pod.js --working

# Deploy changes from specific commits
node cli-tools/deploy-to-pod.js abc1234 def5678

# Deploy changes from a commit range (last 3 commits)
node cli-tools/deploy-to-pod.js HEAD~3..HEAD

# Dry-run mode — show what would be copied without copying
node cli-tools/deploy-to-pod.js --working --dry-run

# Skip build step and use a custom namespace
node cli-tools/deploy-to-pod.js --working --skip-build --namespace my-namespace

# Full workflow: deploy with cache clearing, then push config from admin
node cli-tools/deploy-to-pod.js --working --cache-clear
# After deploy completes, push config from the admin service to trigger reload
```

## Code Organization Patterns

### Naming Conventions

- **camelCase file names** for source modules: `apiKeyAuth.ts`, `anthropicController.ts`, `usageEventProcessor.ts`
- **kebab-case file names** for tests and scripts: `apiKeyAuth-log-redaction.test.ts`, `create-dev-env-config.js`
- **PascalCase** for classes and interfaces, **camelCase** for functions and variables
- **lowercase or camelCase** directories (`services`, `middlewares`, `fileSearch`, `toolGovernance`)

### Import Patterns

```typescript
// Relative imports within the same service
import apiKeyAuth from '../middlewares/apiKeyAuth';

// Path-alias imports for the shared libraries
import { getDefaultLogger } from '@libs/logger';
import { getAdminServiceUrl } from '@libs/test-utils';
```
