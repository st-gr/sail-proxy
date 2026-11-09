---
title: Development setup
description: Node, pnpm, Valkey, the dev servers and local authentication.
---

# Development Setup

## Prerequisites & Recommendations

### Operating System
**Recommended**: Linux or WSL2 on Windows
- Better Docker performance and native Unix tooling
- Consistent behavior with production environments
- Superior development experience for Node.js projects

**Fully Supported**: macOS (including Apple Silicon M1/M2/M3)
- **Apple Silicon**: Excellent native performance with ARM64 optimization
- **Intel Macs**: Full AMD64 compatibility 
- Docker Desktop provides seamless multi-architecture support
- Setup script automatically detects and optimizes for your Mac architecture

**Supported**: Windows (with limitations)
- Windows users should consider WSL2 for optimal experience
- Docker Desktop required for Windows/macOS

### Required Software

**Node.js 20+** (Critical requirement):
```bash
# Check current version
node --version  # Must be 20.0.0 or higher

# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20

# Verify native ESM support
node -e "import('fs').then(() => console.log('ESM supported'))"
```

**pnpm 10** (Required for monorepo; the root `package.json` pins `packageManager: pnpm@10.12.4`, CI uses pnpm 10 on Node 24):
```bash
# Install pnpm globally (or let Corepack pick the pinned version: corepack enable)
npm install -g pnpm@10

# Verify installation
pnpm --version

# Enable pnpm shell integration
pnpm setup
source ~/.bashrc
```

**Git & Development Tools**:
```bash
# Essential tools
git --version
curl --version
docker --version
docker-compose --version

# Optional but recommended
jq --version      # JSON processing
htop             # Process monitoring
code --version   # VS Code (or preferred editor)

# For CI Pipeline (if running pnpm run ci)
trivy --version  # Container security scanner
```

**file_search extractor tools** (for document uploads and the `FILE_SEARCH_TEST_BINARIES=1` suites): `pandoc`, `pdftotext` (poppler) and `tesseract` with English language data (OCR of PDF pages without a text layer). The gateway image and CI install them; locally on macOS:

```bash
brew install pandoc poppler tesseract   # tesseract ships eng (plus osd); not tesseract-lang (every language, several hundred MB)
tesseract --list-langs                  # must list eng
```

Without tesseract the gateway logs one warning that OCR is off and leaves such pages empty; `FILE_SEARCH_OCR=off` switches OCR off on purpose.

Legacy Word `.doc` files are read with `antiword` (the gateway image and CI install it). It has no Homebrew
formula, so on macOS `.doc` uploads fail as not supported and the `.doc` binary suite skips with a warning;
`FILE_SEARCH_DOC=off` switches `.doc` off on purpose. The `file_search` tool page of this section describes the legacy Word extractor and how to add more OCR languages.

**Compose version requirement:** `docker-compose --version` above must report the **Compose v2 plugin, 2.24.0 or newer** (`docker compose version` also works and is the preferred invocation — the legacy standalone `docker-compose` v1 binary does not qualify, even though the command name is the same). `docker/docker-compose.yml` uses the `env_file` long-form syntax (`path:` / `required:`) to make the gateway's Postgres credentials file optional, which v1 and pre-2.24 v2 do not parse. Docker Desktop bundles a recent enough Compose plugin; on Linux, install/update via the [Compose plugin](https://docs.docker.com/compose/install/linux/) rather than the standalone binary.

**Apple Silicon (M1/M2/M3) Specific Notes**:
- **Docker Desktop**: Ensure "Use Rosetta for x86/amd64 emulation" is enabled
- **Colima Alternative**: If using Colima instead of Docker Desktop, additional setup is required:
  ```bash
  # Install Docker Compose (required for Colima)
  brew install docker-compose
  
  # Configure Docker CLI to find Compose plugin
  mkdir -p ~/.docker
  cat > ~/.docker/config.json << 'EOF'
  {
    "cliPluginsExtraDirs": [
      "/opt/homebrew/lib/docker/cli-plugins"
    ]
  }
  EOF
  
  # Verify Compose plugin is available
  docker --help   # Should see 'compose*' under "Management Commands"
  docker compose version
  
  # Stop existing Colima instance (if running)
  colima stop
  
  # Start with increased resources for CI builds
  colima start --memory 8 --cpu 4 --disk 100
  
  # Verify settings
  colima status
  ```
  > **Note**: The default Colima settings (2GB memory) are insufficient for the CI build process, which builds every cockpit UI5 application and may cause "cannot allocate memory" errors during Docker builds. The Docker Compose plugin configuration is required because Colima doesn't include it by default.
- **Architecture**: The project fully supports native ARM64 with automatic detection
- **Performance**: Native ARM64 builds provide optimal performance
- **Compatibility**: Mixed architecture deployments work seamlessly
- The Docker images page of this section has detailed Apple Silicon guidance

### SAP Prerequisites

**SAP BTP Service Key** for AI Core:
- Access to SAP BTP Cockpit
- AI Core service instance with valid service key
- OAuth2 client credentials for API access

Example service key structure:
```json
{
  "clientid": "your-client-id",
  "clientsecret": "your-client-secret",
  "url": "https://your-ai-core-url",
  "serviceurls": {
    "AI_API_URL": "https://your-api-url"
  }
}
```

## Initial Setup

### 1. Repository Clone and Workspace Setup

```bash
# Clone the repository
git clone https://github.com/st-gr/sail-proxy.git
cd sail-proxy

# Install dependencies for all workspaces
pnpm install

# Verify workspace structure
pnpm -r list --depth=0
```

### 2. Environment Configuration

Each service reads its own `.env` file from its service folder (the gateway loads it with `dotenv/config` from the directory it runs in); a `.env` in the repository root is not read.

**Generate the files** (recommended):
```bash
# Runs docker/setup-docker.js interactively (asks for the SAP AI Core service key),
# then patches services/admin/.env for SQLite local development
pnpm run setup:dev

# Overwrite existing .env files
pnpm run setup:dev:force
```

**Or copy the templates** and fill them in by hand:
```bash
cp services/gateway/.env.sample services/gateway/.env
cp services/admin/.env.sample services/admin/.env
cp services/ollama/.env.sample services/ollama/.env   # only for the Ollama service
```

The gateway needs the SAP AI Core credentials from the service key:
```bash
SAP_AI_CORE_URL=https://your-api-url            # serviceurls.AI_API_URL
AUTH_URL=https://your-auth-url/oauth/token      # url + /oauth/token
CLIENT_ID=your-client-id                        # clientid
CLIENT_SECRET=your-client-secret                # clientsecret
SAP_AI_RESOURCE_GROUP=default
```

**Generate secure keys for development**:
```bash
# Generate 256-bit secrets
node -e "console.log('VALIDATION_TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('METADATA_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('AWS_SECRET_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`VALIDATION_TOKEN_SECRET` and `METADATA_ENCRYPTION_KEY` must be the same in the gateway and the admin `.env`. Every variable is described in [Environment variables](/reference/environment-variables).

## Build Process

### Build All Services

```bash
# From the repository root: install all workspaces
pnpm install

# Build libs/test-utils and libs/service-key-parser first, then every package
pnpm run build

# Or build one service
pnpm run build:gateway
pnpm run build:admin
```

### TypeScript Configuration

Each service has its own `tsconfig.json`; there is no shared base config. The gateway's config sets `baseUrl` to the repository root and maps `@libs/*` to `libs/*`, which is why the dev scripts run `ts-node -r tsconfig-paths/register`.

## Development Servers

### Gateway Service

**Start development server**:
```bash
# From services/gateway (nodemon + ts-node)
pnpm run dev

# Or from the repository root (sets DEPLOY_TARGET=local)
pnpm run dev:gateway

# Default: http://localhost:3000
```

**Kill stuck processes**:
```bash
# Kill processes on gateway port
sudo kill -9 $(sudo lsof -t -iTCP:3000 -sTCP:LISTEN)
```

### Admin Service (CAP)

**Prerequisites for Admin service**:
```bash
# Start Valkey/Redis (required dependency)
docker run -d --name valkey --restart unless-stopped \
  -p 127.0.0.1:6379:6379 valkey/valkey:8

# Verify connectivity
docker exec valkey valkey-cli ping  # Should return PONG
```

The image matches the `valkey` service of `docker/docker-compose.yml`.

**Start development server**:
```bash
# From the repository root (cds watch, DEPLOY_TARGET=local)
pnpm run dev:admin

# Or from services/admin: TypeScript entry point with nodemon and mocked authentication
cd services/admin
pnpm run dev:ts:mock

# Default: http://localhost:4004
```

**Kill stuck processes**:
```bash
# Kill processes on admin port
sudo kill -9 $(sudo lsof -t -iTCP:4004 -sTCP:LISTEN)
```

**Database reset**:
```bash
cd services/admin
# Deletes db/admin.db (with its -shm and -wal files) and deploys the schema into a new, empty file
pnpm run db:reset
```

### Ollama Service (Optional)

```bash
# Start Ollama service from the repository root
pnpm run dev:ollama

# Or manually (nodemon index.js)
cd services/ollama
pnpm run dev

# Default: http://localhost:11434 (OLLAMA_PORT)
```

### Start All Services

```bash
# Start both gateway and admin simultaneously (run-p)
pnpm run dev:all

# Gateway, admin and the Ollama service
pnpm run dev:all-with-ollama
```

## Local Development Authentication

For local development of the **Admin Service**, the system provides built-in authentication that works without Docker, Dex or oauth2-proxy.

### Admin Service Local Authentication

When the admin service runs locally (`NODE_ENV=development`, the `dev:mock` and `dev:ts:mock` scripts, or the `[development]` profile of `cds watch`), CAP's mocked authentication is active with the test users configured under `cds.requires.auth["[development]"].users` in `services/admin/package.json`:

```bash
# Start admin service locally
cd services/admin
pnpm run dev
```

**Available Test Users:**

| User | Roles |
|------|-------|
| `admin@test.com` | admin, user, gateway |
| `admin@example.com` | admin, user, gateway |
| `user@test.com` | user |
| `other@test.com` | user |
| `user@example.com` | user |

No password is configured for these users, so CAP accepts any password with HTTP Basic authentication (for example `admin@test.com:admin`).

### Usage Examples

**Browser Access:**
- Navigate to `http://localhost:4004/shell/index.html`
- Log in as any of the test users above

**API Testing (cURL):**
```bash
# Admin access: list API keys through the OData service
curl -u "admin@test.com:admin" http://localhost:4004/odata/v4/admin/ApiKeys

# User access
curl -u "user@test.com:user" http://localhost:4004/odata/v4/admin/ApiKeys
```

**API Testing (Bruno/Postman):**
- Set Authorization to "Basic Auth"
- Username: `admin@test.com`, any password

### Development vs Docker Deployment

| Mode | Authentication | Requirements | Use Case |
|------|---------------|--------------|-----------|
| **Local Development** | CAP Mocked Auth | None | Quick development, API testing |
| **Docker Deployment** | oauth2-proxy + Dex | Docker, postgres, dex | Production-like testing, multi-user scenarios |

**To switch to Docker mode:**
```bash
# Use Docker Compose for full oauth2-proxy + Dex setup
pnpm run docker:up
# Access via http://localhost:8080 with demo users
```

The Docker setup and its users are described in [Docker Compose](/deploy/docker) and [Authentication providers](/deploy/authentication).

## IDE Configuration

### VS Code Setup

The repository ships no `.vscode` folder. A useful set of extensions (`.vscode/extensions.json`):
```json
{
  "recommendations": [
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "SAPSE.vscode-cds"
  ]
}
```

### Debug Configuration

A launch configuration (`.vscode/launch.json`) that starts the services the way their `dev` scripts do:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Gateway",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}/services/gateway",
      "program": "${workspaceFolder}/services/gateway/src/index.ts",
      "runtimeArgs": ["-r", "ts-node/register", "-r", "tsconfig-paths/register"],
      "env": {
        "NODE_ENV": "development"
      },
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Admin",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}/services/admin",
      "program": "${workspaceFolder}/services/admin/src/index.ts",
      "runtimeArgs": ["-r", "ts-node/register", "-r", "tsconfig-paths/register"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  ]
}
```

## Code Quality Tools

### ESLint Configuration

The root `eslint.config.mjs` is a flat config that extends the CAP recommended rules (`@sap/cds/eslint.config.mjs`). The repository has no root `lint` script and no Prettier configuration; type safety is checked by `tsc` in each service's `build` script and, for the cockpit apps, by `pnpm run typecheck:ui5`.

### Pre-commit Hooks

The project uses Git pre-commit hooks to ensure code quality and consistency. These hooks are automatically installed during `pnpm install` via the postinstall script.

**Installation**:
```bash
# Hooks are automatically installed during pnpm install
pnpm install

# Or manually reinstall hooks
node scripts/setup-git-hooks.js
```

**What the pre-commit hook validates**:
1. **API Config Synchronization** - Ensures `api_config.json` files remain identical:
   - Source: `services/gateway/api_config.json`
   - Auto-synced to: `services/admin/api_config.json`
   - Auto-synced to: `npm-dist/sail-proxy/src/templates/api_config.template.json`

   When you commit changes to any of these files, the hook automatically copies the gateway version to the other locations and stages them in your commit.

2. **workspace:* Protocol** - Validates `npm-dist/sail-proxy/package.json` uses workspace protocol for local dependencies

3. **PostgreSQL Credentials** - Auto-fixes PostgreSQL credentials to safe defaults in docker configuration files

4. **NUL bytes** - Rejects staged text files that contain literal NUL bytes

**Hook Implementation**:
- Location: `.git/hooks/pre-commit` (written by `scripts/setup-git-hooks.js`)
- Script: `cli-tools/pre-commit-checks.js`
- Cross-platform compatible (Windows, macOS, Linux)
- Uses Node.js for all file operations (no grep/sed/awk)

**Bypassing hooks** (use with caution):
```bash
# Skip pre-commit hooks for emergency commits
git commit --no-verify -m "emergency fix"
```

## CI Pipeline Tools

### Trivy Security Scanner (Optional)

**For running the full CI pipeline** (`pnpm run ci`), install Trivy for Docker container security scanning:

**macOS**:
```bash
brew install trivy
```

**Linux**:
```bash
# Install Trivy via install script
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Or on Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y trivy
```

**Verify installation**:
```bash
trivy --version
```

**Note**: Trivy is optional for development. If not installed, the CI pipeline will skip security scanning and continue with other validations. However, it's recommended for:
- Full CI validation before commits
- Security vulnerability detection in Docker images
- Production-ready container builds

See the [Trivy installation guide](https://aquasecurity.github.io/trivy/latest/getting-started/installation/) for more options.

## Development Workflow

### Standard Development Loop

1. **Start services**:
   ```bash
   pnpm run dev:all
   ```

2. **Make changes** to source code

3. **Test changes**:
   ```bash
   # Gateway tests in watch mode
   pnpm test:watch
   
   # Or specific service tests
   cd services/gateway && pnpm test
   ```

4. **Verify code quality**:
   ```bash
   pnpm run build          # tsc for every package
   pnpm run typecheck:ui5  # cockpit UI5 apps
   ```

5. **Manual testing**:
   ```bash
   # Test API endpoints
   curl -X GET http://localhost:3000/v1/models \
     -H "Authorization: Bearer test-key"
   ```

### Hot Reloading

The development servers support hot reloading:
- **Gateway**: `nodemon` restarts `ts-node` on source changes
- **Admin**: `cds watch` (the `dev` script) or `nodemon` (the `dev:ts*` scripts) restarts on changes
- **File watching**: Monitors TypeScript source files for changes

## Environment Verification

### Health Check Script

Create a development health check:
```bash
#!/bin/bash
# dev-health-check.sh

echo "=== SAIL-PROXY Development Environment Check ==="

# Node.js version
echo "Node.js: $(node --version)"
echo "pnpm: $(pnpm --version)"

# Service availability
echo "Gateway: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health || echo 'DOWN')"
echo "Admin: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:4004/api/admin/health || echo 'DOWN')"

# Dependencies
echo "Valkey: $(docker exec valkey valkey-cli ping 2>/dev/null || echo 'DOWN')"

# Build status
echo "Build: $(pnpm run build >/dev/null 2>&1 && echo 'OK' || echo 'FAILED')"

echo "=== End Health Check ==="
```

### Common Setup Issues

**Node.js Version Problems**:
```bash
# Error: Unexpected token 'export'
# Solution: Upgrade to Node.js 20+
nvm install 20 && nvm use 20
```

**pnpm Workspace Issues**:
```bash
# Error: Cannot resolve workspace
# Solution: Install from project root
cd <project-root> && pnpm install
```

**TypeScript Build Errors**:
```bash
# Error: Cannot find module types
# Solution: reinstall the workspace from the repository root
cd <project-root> && pnpm install
```

**Port Conflicts**:
```bash
# Find processes using development ports
lsof -i :3000 -i :4004 -i :6379

# Kill conflicting processes
sudo kill -9 <process-id>
```

## Next Steps

After completing the development setup:

1. **Explore the architecture** in [Architecture](/developer/architecture)
2. **Review the Gateway service** in [Gateway service](/developer/gateway)
3. **Run the test suite** as described in [Running and testing the gateway](/developer/gateway-testing)
4. **Set up debugging** for your preferred IDE
5. **Review coding standards** and contribution guidelines
