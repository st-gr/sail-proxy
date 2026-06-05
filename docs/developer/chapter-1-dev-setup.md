---
title: SAIL-PROXY Developer Guide - Chapter 1
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[Content Table](README.md) | [Next Chapter >>](chapter-2-architecture.md)

---

## Development Setup

### Prerequisites & Recommendations

#### Operating System
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

#### Required Software

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

**pnpm Package Manager** (Required for monorepo):
```bash
# Install pnpm globally
npm install -g pnpm

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
  > **Note**: The default Colima settings (2GB memory) are insufficient for the CI build process, which builds 6 UI5 applications and may cause "cannot allocate memory" errors during Docker builds. The Docker Compose plugin configuration is required because Colima doesn't include it by default.
- **Architecture**: The project fully supports native ARM64 with automatic detection
- **Performance**: Native ARM64 builds provide optimal performance
- **Compatibility**: Mixed architecture deployments work seamlessly
- See [Chapter 7 - Docker Deployment](chapter-7-docker-deployment.md) for detailed Apple Silicon guidance

#### SAP Prerequisites

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

### Initial Setup

#### 1. Repository Clone and Workspace Setup

```bash
# Clone the repository
git clone <repository-url>
cd sap-llm-gateway

# Install dependencies for all workspaces
pnpm install

# Verify workspace structure
pnpm -r list --depth=0
```

#### 2. Environment Configuration

**Create base environment file**:
```bash
# Copy template (if available)
cp .env.example .env

# Or create from scratch
cat > .env << 'EOF'
# SAP AI Core Configuration
OAUTH_URL=https://your-ai-core-url/oauth/token
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret

# Development Settings
NODE_ENV=development
LOG_LEVEL=debug
PORT=3000

# Security Keys (generate new ones for development)
VALIDATION_TOKEN_SECRET=your-256-bit-development-secret
METADATA_ENCRYPTION_KEY=your-256-bit-development-key
AWS_SECRET_ENCRYPTION_KEY=your-256-bit-development-key
EOF
```

**Generate secure keys for development**:
```bash
# Generate 256-bit secrets (from project docs)
node -e "console.log('VALIDATION_TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('METADATA_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('AWS_SECRET_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

#### 3. Service-Specific Configuration

**Gateway Service** (`services/gateway/.env`):
```bash
cd services/gateway
cp .env.example .env  # If template exists
# Configure gateway-specific settings
```

**Admin Service** (`services/admin/.env`):
```bash
cd services/admin
cp .env.example .env  # If template exists
# Configure CAP-specific settings
```

### Build Process

#### Build All Services

```bash
# install deps
pnpm install -r

# Build specific services
change directory to service (gateway, admin)
pnpm run build
```

#### TypeScript Configuration

The project uses workspace-specific `tsconfig.json` files:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node", "jest"]
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

### Development Servers

#### Gateway Service

**Start development server**:
```bash
# From services/gateway root
pnpm run dev

# Default: http://localhost:3000
```

**Kill stuck processes** (from project docs):
```bash
# Kill processes on gateway port
sudo kill -9 $(sudo lsof -t -iTCP:3000 -sTCP:LISTEN)
```

#### Admin Service (CAP)

**Prerequisites for Admin service**:
```bash
# Start Valkey/Redis (required dependency)
docker run -d --name valkey --restart unless-stopped \
  -p 127.0.0.1:6379:6379 valkey/valkey:8

# Verify Redis connectivity
redis-cli ping  # Should return PONG
```

**Start development server**:
```bash
# From service directory
cd services/admin
pnpm run dev:ts:mock

# Default: http://localhost:4004
```

**Kill stuck processes** (from project docs):
```bash
# Kill processes on admin port
sudo kill -9 $(sudo lsof -t -iTCP:4004 -sTCP:LISTEN)
```

**Database reset options** (adapted from `/CAP_PROJECT_SETUP_INSTRUCTIONS.md`):
```bash
pnpm run db:reset

# Unix/Linux (including WSL2)
cd services/admin
rm -rf .cdsrc-private.json db/ && pnpm run dev

# PowerShell (Windows)
cd services/admin
Remove-Item -Recurse -Force .cdsrc-private.json, db/; pnpm run dev
```

#### Ollama Service (Optional)

```bash
# Start Ollama service
pnpm run dev:ollama  # If available

# Or manually
cd services/ollama
pnpm run dev

# Default: http://localhost:11434
```

#### Start All Services

```bash
# Start both gateway and admin simultaneously
pnpm run dev:all

# Monitor all services
pnpm run dev:all --parallel  # If supported
```

### IDE Configuration

#### VS Code Setup

**Recommended extensions** (`.vscode/extensions.json`):
```json
{
  "recommendations": [
    "ms-vscode.vscode-typescript-next",
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "bradlc.vscode-tailwindcss",
    "ms-vscode.vscode-json"
  ]
}
```

**Workspace settings** (`.vscode/settings.json`):
```json
{
  "typescript.preferences.useLabelDetailsInCompletionEntries": true,
  "typescript.suggest.autoImports": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true,
    "source.organizeImports": true
  },
  "files.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.next": true
  }
}
```

#### Debug Configuration

**Launch configuration** (`.vscode/launch.json`):
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Gateway",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/services/gateway/src/index.ts",
      "env": {
        "NODE_ENV": "development"
      },
      "runtimeArgs": ["--loader", "tsx/esm"],
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Admin", 
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/services/admin/server.js",
      "env": {
        "NODE_ENV": "development"
      }
    }
  ]
}
```

### Code Quality Tools

#### ESLint Configuration

**Root ESLint config** (`.eslintrc.js`):
```javascript
module.exports = {
  root: true,
  extends: [
    '@typescript-eslint/recommended',
    'prettier'
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    'no-console': 'warn'
  }
};
```

#### Prettier Configuration

**Code formatting** (`.prettierrc`):
```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false
}
```

#### Pre-commit Hooks

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

**Hook Implementation**:
- Location: `.git/hooks/pre-commit`
- Script: `cli-tools/pre-commit-checks.js`
- Cross-platform compatible (Windows, macOS, Linux)
- Uses Node.js for all file operations (no grep/sed/awk)

**Bypassing hooks** (use with caution):
```bash
# Skip pre-commit hooks for emergency commits
git commit --no-verify -m "emergency fix"
```

### CI Pipeline Tools

#### Trivy Security Scanner (Optional)

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

### Development Workflow

#### Standard Development Loop

1. **Start services**:
   ```bash
   pnpm run dev:all
   ```

2. **Make changes** to source code

3. **Test changes**:
   ```bash
   # Run affected tests
   pnpm test:watch
   
   # Or specific service tests
   cd services/gateway && pnpm test
   ```

4. **Verify code quality**:
   ```bash
   pnpm run lint
   pnpm run typecheck  # If available
   ```

5. **Manual testing**:
   ```bash
   # Test API endpoints
   curl -X GET http://localhost:3000/v1/models \
     -H "Authorization: Bearer test-key"
   ```

#### Hot Reloading

The development servers support hot reloading:
- **Gateway**: Uses `nodemon` or similar for automatic restarts
- **Admin**: CAP framework provides built-in hot reloading
- **File watching**: Monitors TypeScript source files for changes

### Environment Verification

#### Health Check Script

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
echo "Admin: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:4004/health || echo 'DOWN')"

# Dependencies
echo "Redis: $(redis-cli ping 2>/dev/null || echo 'DOWN')"

# Build status
echo "Build: $(pnpm run build >/dev/null 2>&1 && echo 'OK' || echo 'FAILED')"

echo "=== End Health Check ==="
```

#### Common Setup Issues

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
# Solution: Install TypeScript and types
pnpm add -D typescript @types/node
```

**Port Conflicts**:
```bash
# Find processes using development ports
lsof -i :3000 -i :4004 -i :6379

# Kill conflicting processes
sudo kill -9 <process-id>
```

### Next Steps

After completing the development setup:

1. **Explore the architecture** in [Chapter 2](chapter-2-architecture.md)
2. **Review the Gateway service** implementation
3. **Run the test suite** to verify everything works
4. **Set up debugging** for your preferred IDE
5. **Review coding standards** and contribution guidelines

---

*Next: Understand the [system architecture](chapter-2-architecture.md) and component relationships.*