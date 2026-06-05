---
title: SAIL-PROXY Developer Guide - Chapter 8
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-7-docker-deployment.md) | [Content Table](README.md) | [Next Chapter >>](chapter-9-testing-strategy.md)

---

## Workspace Layout

### Monorepo Structure

**Root Directory Organization**:
```
sap-llm-gateway/
├── services/                   # Core microservices
│   ├── gateway/               # Main proxy service
│   ├── admin/                 # CAP-based management service
│   └── ollama/                # Ollama compatibility service
├── libs/                      # Shared libraries
│   ├── test-utils/           # Shared test utilities
│   ├── logger/               # Shared logging utilities
│   └── types/                # Shared TypeScript types
├── docker/                   # Docker deployment configuration
├── npm-dist/                 # CLI distribution packages
│   └── sail-proxy/          # npm-installable CLI tool
├── docs/                     # Documentation
│   ├── user/                # User documentation
│   ├── developer/           # Developer documentation
│   └── assets/              # Images and diagrams
├── config/                   # Global configuration templates
├── cli-tools/               # Development CLI utilities
│   ├── pre-commit-checks.js  # Git pre-commit validation
│   ├── sync-api-config.js    # API config synchronization
│   ├── check-workspace-protocol.js  # Workspace validation
│   └── check-postgres-credentials.js # Security validation
├── scripts/                  # Build and deployment scripts
│   └── setup-git-hooks.js    # Git hooks installer
├── package.json             # Root package configuration
├── pnpm-workspace.yaml      # Workspace configuration
├── tsconfig.base.json       # Base TypeScript configuration
├── .eslintrc.js             # ESLint configuration
├── .prettierrc              # Prettier configuration
└── CLAUDE.md                # Project-specific instructions
```

### Workspace Configuration

**pnpm Workspace Setup** (`pnpm-workspace.yaml`):
```yaml
packages:
  - 'services/*'
  - 'libs/*'
  - 'npm-dist/*'
  - 'docker'
  - 'scripts'

sharedWorkspaceLockfile: true
strictPeerDependencies: false
```

**Root Package Configuration** (`package.json`):
```json
{
  "name": "sap-llm-gateway",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "services/*",
    "libs/*",
    "npm-dist/*"
  ],
  "scripts": {
    "build": "pnpm -r build",
    "dev:gateway": "pnpm --filter gateway dev",
    "dev:admin": "pnpm --filter admin dev",
    "dev:all": "pnpm -r --parallel dev",
    "test:all": "pnpm -r test",
    "test:gateway": "pnpm --filter gateway test",
    "test:admin": "pnpm --filter admin test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.0.0"
  }
}
```

### Service Directory Structure

#### Gateway Service (`services/gateway/`)

```
services/gateway/
├── src/                      # Source code
│   ├── index.ts             # Application entry point
│   ├── app.ts               # Express application setup
│   ├── middleware/          # Express middleware
│   │   ├── auth.ts         # Authentication middleware
│   │   ├── rateLimit.ts    # Rate limiting middleware
│   │   └── logging.ts      # Logging middleware
│   ├── routes/             # API route handlers
│   │   ├── openai.ts       # OpenAI API compatibility
│   │   ├── anthropic.ts    # Anthropic API compatibility
│   │   ├── bedrock.ts      # AWS Bedrock compatibility
│   │   └── unified.ts      # Unified model endpoints
│   ├── services/           # Business logic services
│   │   ├── AuthService.ts  # Authentication service
│   │   ├── ModelService.ts # Model management
│   │   └── UsageTracker.ts # Usage tracking
│   ├── translators/        # API format translators
│   │   ├── OpenAITranslator.ts
│   │   ├── AnthropicTranslator.ts
│   │   └── BedrockTranslator.ts
│   ├── plugins/           # Plugin system
│   │   ├── PluginManager.ts
│   │   └── hooks/         # Plugin hook implementations
│   ├── config/            # Configuration management
│   │   ├── ConfigManager.ts
│   │   └── api_config.json # Model mappings and settings
│   └── utils/             # Utility functions
│       ├── logger.ts      # Logging utilities
│       ├── crypto.ts      # Cryptographic utilities
│       └── validation.ts  # Input validation
├── test/                  # Test files (from CLAUDE.md)
│   ├── setupTests.ts      # Global test setup
│   ├── clients/           # Client integration tests
│   ├── config/            # Configuration tests
│   ├── integration/       # Integration tests
│   └── usage-tracking*.test.ts # Usage tracking tests
├── dist/                  # Compiled JavaScript output
├── config/               # Service-specific configuration
├── package.json          # Service dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── jest.config.js        # Jest test configuration
├── .env.example          # Environment variable template
└── README.md             # Service documentation
```

#### Admin Service (`services/admin/`)

```
services/admin/
├── app/                   # Fiori Elements applications
│   ├── shell/            # Main navigation shell
│   ├── apikeys/          # API key management app
│   ├── awscredentials/   # AWS credential management app
│   ├── configurations/   # Configuration management app
│   ├── analytics/        # Usage analytics app
│   └── security/         # Security events app
├── srv/                  # CAP service definitions
│   ├── admin-service.cds # Service definition
│   ├── admin-service.js  # Service implementation
│   └── handlers/         # Custom handlers
├── db/                   # Database models and data
│   ├── schema.cds        # Core data model
│   ├── auth.cds          # Authentication model
│   └── data/             # Initial data files
├── test/                 # Test files (from CLAUDE.md)
│   ├── setupTests.ts     # Global test setup
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   │   └── http/         # HTTP endpoint tests
│   ├── security/         # Security tests
│   └── bruno/            # API testing collections
├── config/               # CAP and service configuration
├── package.json          # CAP dependencies and scripts
├── server.js             # CAP server entry point
├── .cdsrc.json           # CAP runtime configuration
└── README.md             # Service documentation
```

### Shared Libraries (`libs/`)

#### Test Utilities (`libs/test-utils/`)

```
libs/test-utils/
├── src/
│   ├── factories/        # Test data factories
│   │   ├── ApiKeyFactory.ts
│   │   ├── UserFactory.ts
│   │   └── RequestFactory.ts
│   ├── assertions/       # Custom test assertions
│   │   ├── ApiKeyAssertions.ts
│   │   └── ResponseAssertions.ts
│   ├── mocks/           # Mock implementations
│   │   ├── MockCacheAdapter.ts
│   │   ├── MockHttpResponse.ts
│   │   └── MockSAPAICore.ts
│   ├── setup/           # Test environment setup
│   │   ├── setupTestEnvironment.ts
│   │   └── teardownTestEnvironment.ts
│   └── index.ts         # Export all utilities
├── package.json
├── tsconfig.json
└── README.md
```

**Example usage** (from `/CLAUDE.md`):
```typescript
import { 
  TestDataFactory, 
  TestAssertions, 
  TestMocks,
  setupTestEnvironment,
  teardownTestEnvironment 
} from '@sap-llm-gateway/libs/test-utils';

// Create test data
const apiKeyRequest = TestDataFactory.createApiKeyRequest();
const validationResponse = TestDataFactory.createValidationResponse(true);

// Test assertions
TestAssertions.hasRequiredProperties(obj, ['id', 'name']);
const isValid = TestAssertions.isValidApiKeyFormat('sk-test123...');

// Mock helpers
const mockCache = TestMocks.createMockCacheAdapter();
const mockResponse = TestMocks.createMockHttpResponse(data, 200);
```

#### Logger Library (`libs/logger/`)

```
libs/logger/
├── src/
│   ├── Logger.ts         # Core logger implementation
│   ├── formatters/       # Log formatters
│   │   ├── JSONFormatter.ts
│   │   └── ConsoleFormatter.ts
│   ├── transports/       # Log transports
│   │   ├── FileTransport.ts
│   │   ├── ConsoleTransport.ts
│   │   └── RedisTransport.ts
│   └── index.ts
├── package.json
└── tsconfig.json
```

#### Shared Types (`libs/types/`)

```
libs/types/
├── src/
│   ├── api/             # API-related types
│   │   ├── OpenAI.ts    # OpenAI API types
│   │   ├── Anthropic.ts # Anthropic API types
│   │   └── Bedrock.ts   # AWS Bedrock types
│   ├── auth/            # Authentication types
│   │   ├── User.ts
│   │   ├── APIKey.ts
│   │   └── Permissions.ts
│   ├── config/          # Configuration types
│   │   ├── GatewayConfig.ts
│   │   └── AdminConfig.ts
│   └── common/          # Common utility types
│       ├── Response.ts
│       └── Error.ts
├── package.json
└── tsconfig.json
```

### TypeScript Configuration

#### Base Configuration (`tsconfig.base.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node", "jest"],
    "baseUrl": ".",
    "paths": {
      "@sap-llm-gateway/libs/*": ["./libs/*/src"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

#### Service-Specific Configuration

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../libs/test-utils" },
    { "path": "../../libs/logger" },
    { "path": "../../libs/types" }
  ]
}
```

### Build and Development Scripts

#### Workspace-Level Scripts

**Package.json scripts** (from `/CLAUDE.md`):
```json
{
  "scripts": {
    "build": "pnpm run build",
    "build:gateway": "pnpm run build:gateway",
    "build:admin": "pnpm run build:admin",
    "dev": "pnpm run dev",
    "dev:gateway": "pnpm run dev:gateway",
    "dev:admin": "pnpm run dev:admin",
    "dev:all": "pnpm run dev:all",
    "test:all": "pnpm test:all",
    "test:gateway": "pnpm test:gateway",
    "test:admin": "pnpm test:admin",
    "test:gateway:unit": "pnpm test:gateway:unit",
    "test:gateway:integration": "pnpm test:gateway:integration",
    "test:gateway:usage": "pnpm test:gateway:usage",
    "test:admin:unit": "pnpm test:admin:unit",
    "test:admin:integration": "pnpm test:admin:integration",
    "test:admin:http": "pnpm test:admin:http",
    "test:watch": "pnpm test:watch",
    "test:coverage": "pnpm test:coverage",
    "docker:build": "pnpm run docker:build",
    "docker:up": "pnpm run docker:up",
    "docker:down": "pnpm run docker:down"
  }
}
```

#### Development Workflow Scripts

The project uses pnpm workspace scripts for building services in dependency order. The root package.json defines build commands that leverage pnpm's workspace topology awareness to automatically build packages in the correct sequence.

### Development CLI Tools (`cli-tools/`)

The `cli-tools/` directory contains Node.js scripts for development workflow automation, git hooks, and project maintenance tasks.

#### Git Hook Scripts

**Pre-commit Validation** (`pre-commit-checks.js`):
- Orchestrates all pre-commit validation checks
- Automatically runs before each git commit
- Ensures code quality and consistency before commits reach the repository
- Called by `.git/hooks/pre-commit`

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

#### Project Setup Scripts

**Git Hooks Installer** (`scripts/setup-git-hooks.js`):
- Installs pre-commit hooks into `.git/hooks/`
- Automatically runs during `pnpm install` via postinstall script
- Can be manually run: `node scripts/setup-git-hooks.js`
- Cross-platform compatible (Windows, macOS, Linux)

**Development Environment Setup** (`create-dev-env-config.js`):
- Interactive setup wizard for local development environment
- Creates `.env` files with proper configuration
- Validates SAP AI Core credentials
- Usage: `pnpm run setup:dev`

#### Maintenance and Utility Scripts

**Version Synchronization** (`sync-version.js`):
- Ensures version consistency across all package.json files
- Syncs version from root to all workspace packages
- Usage: `pnpm run version:sync`

**Commit Synchronization** (`sync-commits.js`):
- Helps maintain synchronized commits across related repositories
- Useful for keeping documentation and code in sync

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

#### Deployment Scripts

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

#### Usage Examples

**Running individual checks manually**:
```bash
# Check API config synchronization
node cli-tools/sync-api-config.js

# Validate workspace protocol
node cli-tools/check-workspace-protocol.js

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

### Dependency Management

#### Shared Dependencies

**Root-level shared dependencies**:
```json
{
  "devDependencies": {
    "typescript": "^5.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0",
    "jest": "^29.0.0",
    "@types/node": "^20.0.0"
  }
}
```

#### Inter-Workspace Dependencies

**Gateway service dependencies**:
```json
{
  "dependencies": {
    "@sap-llm-gateway/libs/types": "workspace:*",
    "@sap-llm-gateway/libs/logger": "workspace:*"
  },
  "devDependencies": {
    "@sap-llm-gateway/libs/test-utils": "workspace:*"
  }
}
```

### Code Organization Patterns

#### Folder Naming Conventions

- **PascalCase**: TypeScript classes and interfaces (`AuthService.ts`, `APIKey.ts`)
- **camelCase**: Functions and variables (`getUserById`, `apiKeyRepository`)
- **kebab-case**: File names with multiple words (`rate-limit.ts`, `usage-tracking.test.ts`)
- **lowercase**: Directories (`services`, `middleware`, `config`)

#### Import/Export Patterns

**Barrel Exports** (`libs/types/src/index.ts`):
```typescript
// Re-export all types from subdirectories
export * from './api/OpenAI.js';
export * from './api/Anthropic.js';
export * from './auth/User.js';
export * from './auth/APIKey.js';
export * from './config/GatewayConfig.js';
```

**Relative Imports in Services**:
```typescript
// Prefer relative imports within same service
import { AuthService } from '../services/AuthService.js';
import { logger } from '../utils/logger.js';

// Use workspace imports for shared libraries
import { User, APIKey } from '@sap-llm-gateway/libs/types';
import { TestDataFactory } from '@sap-llm-gateway/libs/test-utils';
```

---

*Next: Learn about the comprehensive [Testing Strategy](chapter-9-testing-strategy.md) across the monorepo.*