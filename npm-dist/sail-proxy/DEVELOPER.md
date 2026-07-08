# sail-proxy Developer Guide

## Overview

sail-proxy (SAP AI Core Local LLM Proxy) is a comprehensive CLI tool that allows users to run the SAP LLM Gateway in standalone mode locally. It provides an easy-to-use interface for configuration, service management, automatic authentication, and comprehensive logging of the proxy service.

## Architecture

### Directory Structure
```
npm-dist/sail-proxy/
├── bin/              # CLI entry point
├── src/              # TypeScript source
│   ├── commands/     # CLI commands
│   ├── utils/        # Utility functions
│   └── templates/    # Configuration templates
├── dist/             # Compiled JavaScript
└── bundled/          # Bundled services (gateway/ollama)
```

### Key Components

1. **CLI Framework**: Built with Commander.js with comprehensive command structure
2. **Service Key Parser**: Extracts configuration from SAP BTP service keys
   - Region extraction: `https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com` → `prod.us-east-1`
   - Auth URL: Appends `/oauth/token` to the service key URL
   - Auto-generates security keys (VALIDATION_TOKEN_SECRET, METADATA_ENCRYPTION_KEY)
3. **Process Management**: Advanced PID tracking with proper detached process spawning
4. **API Key Management**: Automatic generation and validation for Ollama integration
5. **Logging System**: Comprehensive logging with rotation, following, and filtering
6. **Gateway Warmup**: Pre-population of model cache using OpenRouter endpoint
7. **Configuration Management**: Advanced config system with api_config.json integration

## Development Setup

### Fresh Clone Setup

After cloning the repository, follow these steps:

```bash
# 1. Install dependencies (uses pnpm workspace)
pnpm install -r

# 2. Link for local development
cd npm-dist/sail-proxy
npm run link:dev

# 3. Test the CLI
sail-proxy --help
sail-proxy --version

# 4. When done testing, unlink
npm run unlink:dev
```

### Important: Workspace Protocol Management

**⚠️ CRITICAL: Never commit `package.json` after running `npm run link:dev`!**

This package uses pnpm's `workspace:*` protocol for internal dependencies. The committed version MUST always have `workspace:*`, not concrete versions like `0.9.1`.

**What happens during builds:**
- `npm run link:dev` → Temporarily replaces `workspace:*` with `0.9.1` for npm compatibility
- `npm run unlink:dev` → Automatically restores `workspace:*` via surgical replacement
- `npm pack`/`npm publish` → `prepack` hook replaces. There is deliberately **no `postpack` hook**: npm re-reads `package.json` from disk after packing, so a postpack restore would poison the registry manifest with `workspace:*`. Restoration is handled by the publish wrapper (`pnpm publish:npm` from the repo root); after a bare `npm pack`, restore manually with `npm run restore-workspace`.

**Surgical Restoration:**
The `restore-workspace` script surgically replaces ONLY the dependency protocol, preserving:
- ✅ Version numbers (keeps 0.9.1)
- ✅ Other dependencies (axios, chalk, etc.)
- ✅ Any other package.json fields
- ✅ Any uncommitted changes you made

**Before committing, verify workspace:* is present:**
```bash
# Check the dependency
grep "workspace:\*" npm-dist/sail-proxy/package.json

# Or manually restore if needed:
npm run restore-workspace
```

**The committed package.json must have:**
```json
"dependencies": {
  "@sap-llm-gateway/service-key-parser": "workspace:*"  // ✅ Correct
}
```

**Never commit:**
```json
"dependencies": {
  "@sap-llm-gateway/service-key-parser": "0.9.1"  // ❌ Wrong!
}
```

## Version Management

### Single Source of Truth

All package versions in this monorepo are synchronized from the root `package.json`:

- **Root package.json**: `0.9.1` (single source of truth)
- **libs/service-key-parser**: Must be `0.9.1`
- **libs/test-utils**: Must be `0.9.1`
- **npm-dist/sail-proxy**: Must be `0.9.1`

### Sync Version Script

Use the `sync-version` script to enforce version consistency:

```bash
# Check if versions are synchronized
npm run check-version

# Sync all versions from root package.json
npm run sync-version
```

**What it does:**
1. Reads version from root `package.json` (e.g., `0.9.1`)
2. Updates all lib packages to match
3. Replaces `workspace:*` with concrete version in npm-dist
4. Creates `.backup` files (which are gitignored)

**When to run:**
- Before `npm publish` (automatically via `prepack` hook)
- Before `npm run link:dev` (automatically included)
- After changing the version in root `package.json`

## Build Process

The build process:
1. **Syncs versions** (`npm run sync-version`)
2. Compiles TypeScript to JavaScript
3. Copies configuration templates
4. Bundles the gateway service (requires building gateway first)
5. Bundles the ollama service (JavaScript, no build needed)

```bash
npm run build        # Full build with bundling (for publishing)
npm run build:local  # Only compile TypeScript (for development)
npm run link:dev     # Build + bundle dependencies + link globally
```

### Development Workflow

When developing within the monorepo, you can avoid bundling for faster iteration:

```bash
# Quick development build (no bundling)
npm run build:local

# Clean commands
npm run clean          # Remove everything (dist + bundled)
npm run clean:dist     # Remove only compiled TypeScript
npm run clean:bundled  # Remove only bundled services

# Development mode
npm run dev           # Run with tsx in development mode
```

The bundled services are excluded from git via `.gitignore` since they're copies of the monorepo services.

## Key Implementation Details

### Service Key Parsing
```typescript
// Extracts region from AI_API_URL
const match = aiApiUrl.match(/https:\/\/api\.ai\.(.+?\..+?)\./);
// Result: prod.us-east-1
```

### Security Key Generation
```typescript
const crypto = require('crypto');
const validationTokenSecret = crypto.randomBytes(32).toString('hex');
const metadataEncryptionKey = crypto.randomBytes(32).toString('hex');
```

### Gateway Startup with Automatic API Key Management
The gateway is started with comprehensive pre-flight checks and automatic setup:

```typescript
// 1. Generate/validate API key for Ollama
await ensureOllamaApiKey(spinner);

// 2. Warm up gateway model cache using OpenRouter endpoint
await warmupGatewayModels(baseUrl, spinner);

// 3. Start gateway with proper environment and logging
const logFile = openSync(getLogPath('gateway.log'), 'a');
gatewayProcess = spawn('node', ['-r', 'tsconfig-paths/register', 'dist/services/gateway/src/index.js'], {
  cwd: gatewayDir,
  env: { ...envConfig, CONFIG_FILE_PATH: getConfigPath('api_config.json') },
  detached: true,
  stdio: ['ignore', logFile, logFile]  // Proper stdio redirection for background mode
});

// 4. Auto-start Ollama if configured
if (envConfig.OLLAMA_AUTOSTART === 'true') {
  await startOllama();
}
```

## Configuration Files

### ~/.sail-proxy/.env
Contains automatically parsed and configured environment variables:
- SAP AI Core configuration (extracted from service key)
- OAuth2 credentials (CLIENT_ID, CLIENT_SECRET, AUTH_URL)
- Port settings (default 3000, configurable)
- Security keys (auto-generated VALIDATION_TOKEN_SECRET, METADATA_ENCRYPTION_KEY)
- Service orchestration (GATEWAY_STANDALONE=true, OLLAMA_AUTOSTART)

### ~/.sail-proxy/api_config.json
Advanced configuration template copied from services/admin:
- Model substitution mappings for different providers
- Plugin hook configurations
- Logging level controls
- Rate limiting and caching settings

### ~/.sail-proxy/ollama.env
Ollama-specific environment configuration:
- Auto-updated with correct gateway port (MAIN_PROXY_URL)
- Auto-populated with generated API key (MAIN_PROXY_API_KEY)
- Synchronized during startup and configuration changes

## Testing

```bash
# Run the CLI
sail-proxy

# Test specific commands
sail-proxy config
sail-proxy run
sail-proxy apikey create "test-app"
sail-proxy status
```

## Publishing

### Pre-Publish Checklist

**Before publishing, verify:**

```bash
# 1. Ensure workspace:* is in package.json
grep "workspace:\*" package.json
# Should see: "@sap-llm-gateway/service-key-parser": "workspace:*"

# 2. Check for uncommitted changes
git status
# Should be clean

# 3. Verify version is correct in root package.json
grep "version" ../../package.json
```

### Publishing to npm

**Always publish via the hardened wrapper from the repo root — never raw `npm publish`:**

```bash
# 1. Ensure you're logged in
npm login

# 2. Publish via the wrapper (safe workspace:* handling)
cd ../..            # repo root
pnpm publish:npm
```

Why the wrapper: `npm publish` re-reads `package.json` from disk *after* packing and ships that manifest to the registry. A `postpack` hook restoring `workspace:*` would therefore poison the registry metadata (consumers hit `EUNSUPPORTEDPROTOCOL`) while the tarball looks correct. `cli-tools/publish-npm.js` refuses to run if a `postpack` hook exists, pre-rewrites and verifies the dependency state, and restores `workspace:*` in a `finally` block whether publish succeeds, fails, or is interrupted.

**What happens during publish:**
1. The wrapper rewrites `workspace:*` → concrete versions and verifies the on-disk state
2. `prepublishOnly` runs `npm run build` (full build with gateway/ollama bundling)
3. `prepack` hook runs `prepare-pack` (defense in depth for the `workspace:*` rewrite)
4. Package is packed and published with concrete versions
5. The wrapper restores `workspace:*` (there is intentionally no `postpack` hook)

For the full release sequence (version bump → npm publish → Docker build/push), see `docs/developer/chapter-14-release.md` — `pnpm release:patch|minor|major` runs all of it.

### Testing the Package Before Publishing

```bash
# Create a tarball without publishing
npm pack

# This creates st-gr-sail-proxy-0.9.1.tgz
# Verify contents:
tar -tzf st-gr-sail-proxy-0.9.1.tgz | grep package.json
tar -xzf st-gr-sail-proxy-0.9.1.tgz
cat package/package.json | grep service-key-parser
# Should show: "0.9.1" (not workspace:*)

# After testing, restore workspace:* yourself — a bare `npm pack` leaves
# concrete versions in package.json (there is deliberately no postpack hook)
npm run restore-workspace
git diff package.json
# Should show no changes after restoring
```

## Troubleshooting

### Common Issues

1. **Module not found errors**: Ensure the gateway is built before bundling
2. **METADATA_ENCRYPTION_KEY error**: Security keys are auto-generated during setup
3. **Port conflicts**: Use the PORT configuration during setup
4. **Process management**: PID files are stored in the config directory

### Debug Mode

Enable debug output by setting DEBUG=true in ~/.sail-proxy/.env

## API Routes

When the gateway is running, these routes are available:

- **Chat Completions**: `/openai/v1/chat/completions`, `/anthropic/v1/messages`
- **Embeddings**: `/openai/v1/embeddings`, `/openai/api/v1/embeddings`
- **AWS Bedrock**: `/aws-bedrock/model/{modelId}/invoke`
- **Management**: `/v1/models`, `/api/admin/api-keys`
- **Health Check**: `/health`

## Future Enhancements

- Multiple profile support
- Telemetry/analytics
- Enhanced Ollama integration
- Auto-update notifications