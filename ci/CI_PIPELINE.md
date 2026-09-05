# CI Pipeline Documentation

## Overview

This project includes a comprehensive, industry-standard CI pipeline that ensures code quality, security, and reliability across all services.

## Pipeline Structure

### Running Locally (builds and runs containers)

`pnpm run ci` runs the same ten phases as GitHub Actions — including the Docker image
build (Phase 7) and the container runtime validation (Phase 8, which `docker compose up`s
postgres and the admin image). So it needs Docker running, a clean set of host ports, and
a real SAP service key. Set that up first.

**1. Free the ports the pipeline owns.** It starts the admin and gateway as HOST
processes (Phase 5) and postgres + Valkey as containers (Phases 1 and 8), so these must be
free before you start:

| Port | Owned during a run by |
|------|-----------------------|
| 3000 | Gateway (host process) |
| 4004 | Admin (host process) |
| 5432 | postgres (Phase 8 `docker compose`) |
| 6379 | Valkey (Phase 1 starts its own container, removes it, then compose reclaims 6379 in Phase 8) |

In practice: **stop your local dev gateway and admin** (`pnpm run dev:gateway` /
`pnpm run dev:admin`), and **bring down any local Valkey on 6379** — including an
ssh-tunnelled one — because the pipeline runs its own. If a port is busy the pipeline
waits (`waitForPortFree`) and then fails.

```bash
# after stopping the dev services, confirm the ports are free:
for p in 3000 4004 5432 6379; do lsof -iTCP:$p -sTCP:LISTEN -nP || echo "$p free"; done
```

**2. Provide the SAP AI Core service key.** Preflight and Phase 1 read
`SAP_AI_CORE_SERVICE_KEY` from the process environment (the GitHub workflow injects it from
a repository secret) and reject a missing, malformed, or sample key. The pipeline **cleans
the services' own `.env` files** in Phase 1 (and restores them in Phase 10), so do NOT put
the key in a service `.env` — export it into the shell you run `ci` from:

```bash
# from the full service-key JSON your SAP AI Core instance issued (single line, no newlines):
export SAP_AI_CORE_SERVICE_KEY="$(cat ~/path/to/service-key.json)"

# or keep it in a GITIGNORED top-level file and source it before the run:
#   printf 'SAP_AI_CORE_SERVICE_KEY=%s\n' "$(tr -d '\n' < service-key.json)" > .env.ci   # add .env.ci to .gitignore
#   set -a; . ./.env.ci; set +a
```

**3. Docker must be running** (Phases 7–8 build and run the admin image; a stopped Docker
daemon fails those phases).

Then run it:

```bash
pnpm run ci          # = node ci/preflight.js && node ci/ci-pipeline.js
```

The run backs up and restores your `.env` files, `admin.db`, and the postgres/valkey
volumes (Phases 1 and 10), so it leaves your environment as it found it. Set
`FORCE_DOCKER_BUILD=1` to force the image build when change-detection would otherwise skip it.

Before backing up `admin.db`, the pipeline checkpoints its SQLite WAL (folding any
committed writes sitting in `admin.db-wal` into the main file) and aborts the run rather
than back up an incomplete database if it can't — so **stop your local dev admin service
first** (see the port table below), or the checkpoint will fail with the DB held open.

### GitHub Actions
The pipeline runs automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

## Pipeline Phases

The authoritative list is `ci/ci-pipeline.js`'s `logger.phase(...)` calls. There are
TEN phases, and security scanning runs at 9 — not 6, as an earlier version of this
document said while the code had already moved on.

### Phase 1: Environment Setup & Cleanup
- ✅ Validates `SAP_AI_CORE_SERVICE_KEY` JSON format
- 💾 Backs up the postgres and valkey volumes, all three `.env` files and `admin.db`,
  then restores them in Phase 10 — a run leaves your environment as it found it
- 🧹 Cleans existing `.env` files
- 🗄️ Starts a Valkey container (removing it again in Phase 8 to free 6379 for compose)

### Phase 2: Security Validation
- 🚨 Secret and credential detection
- 🔗 Supply-chain indicators (known-malicious versions, suspicious preinstall scripts)
- 🛡️ Dependency audit — **throws on a CRITICAL**, unlike the image scan at Phase 9

### Phase 3: Service Compilation
- 🔨 Gateway (TypeScript → JavaScript) and Admin (CAP + TypeScript)

### Phase 4: Unit Testing
- 🧪 `pnpm run test:unit` per service — deliberately narrow: the gateway's
  `test:unit` matches only `test/(clients|config)/`. The full suite is Phase 6.

### Phase 5: Integration Test Environment
- 🚀 Starts Admin, Gateway and Ollama as HOST processes (not containers)
- 🔑 Creates an API key for the Ollama service via REST

### Phase 6: Full Test Suite
- 🧪 `pnpm run test` for gateway, admin and ollama — the whole jest config, so a
  new `test/*.test.ts` file is picked up here with no CI change

### Phase 6.5: sail-proxy CLI End-to-End
- 📦 Packs the npm tarball, installs it in a tmpdir, then exercises
  run/status/apikey/inference/stop

### Phase 7: Docker Build Validation
- 🐳 `docker compose build --no-cache gateway admin ollama nginx`
- The four services are named explicitly: the compose file has FIVE build
  definitions but only four images, because `gateway` and `gateway-migrate`
  share a tag. Building both raced to write it under `--no-cache`.

### Phase 8: Docker Container Runtime Validation
- 🐳 Starts postgres and the **admin** container, and checks schema deployment
- ⚠️ Only admin is validated as a container; the gateway and ollama images are
  built and scanned but never started here

### Phase 9: Docker Security Scanning
- 🐳 Trivy scans each built image
- ⚠️ **Advisory only.** Findings are logged as warnings and the pipeline still
  reports success. This is inconsistent with Phase 2, which throws on a CRITICAL
  dependency finding, and with the "fail-fast" claim below. Deliberate or not, it
  is what the code does — decide the policy before relying on it as a gate.

### Phase 10: Cleanup
- 🛑 Stops spawned services and containers
- ♻️ Restores everything Phase 1 backed up

## Key Features

### 🔄 Industry Standards
- **Fail-fast**: a failed command stops the entire pipeline — with one
  documented exception, the Phase 9 image scan, which only warns (see above)
- **Service orchestration**: Proper startup sequencing
- **Health checks**: Waits for services to be ready
- **Graceful cleanup**: Stops all services and containers
- **Comprehensive logging**: Color-coded output with timestamps

### 🛡️ Security & Quality
- Security vulnerability scanning
- Code quality checks
- Docker image security analysis
- Dependency audit

### 🐳 Docker Integration
- Multi-stage Docker builds
- Security scanning with Trivy
- Container orchestration testing

### 📊 Monitoring & Reporting
- Test result artifacts
- Coverage reports
- Service logs on failure
- Performance metrics

## Usage Examples

### Run Full Pipeline
```bash
pnpm run ci
```

### Run Individual Phases
```bash
# Just unit tests
cd services/gateway && pnpm run test:unit
cd services/admin && pnpm run test:unit

# Just integration tests
cd services/gateway && pnpm run test:integration
cd services/admin && pnpm run test:integration

# Just Docker build
docker-compose -f docker/docker-compose.yml build --no-cache
```

### Environment Variables

| Variable | Description | Required | Security |
|----------|-------------|----------|----------|
| `SAP_AI_CORE_SERVICE_KEY` | SAP AI Core service credentials (JSON) | ✅ **REQUIRED** | 🔒 Must be real credentials, validated |
| `NODE_ENV` | Node environment | Optional | `development` |
| `CI` | CI environment flag | Optional | `false` |

#### Security Requirements for SAP_AI_CORE_SERVICE_KEY

```bash
# ❌ WRONG - Never use defaults/samples
export SAP_AI_CORE_SERVICE_KEY='{"clientid":"test-client",...}'

# ✅ CORRECT - Use real credentials
export SAP_AI_CORE_SERVICE_KEY='{"clientid":"real-client-id","clientsecret":"real-secret",...}'

# 🔒 BEST PRACTICE - Use from secure source
export SAP_AI_CORE_SERVICE_KEY=$(cat /secure/path/to/credentials.json)
```

The pipeline validates:
- JSON format correctness
- Required fields presence (`clientid`, `clientsecret`, `url`, `identityzone`, `identityzoneid`)
- **Security check**: Rejects default/sample values

## Troubleshooting

### Common Issues

**Services not starting:**
```bash
# Check if ports are in use
lsof -i :3000  # Gateway
lsof -i :4004  # Admin  
lsof -i :11434 # Ollama
lsof -i :6379  # Valkey
```

**Docker issues:**
```bash
# Clean Docker state
docker system prune -f
docker volume prune -f
```

**Test failures:**
```bash
# Run tests in verbose mode
cd services/gateway
NODE_ENV=test pnpm run test --verbose
```

### Performance Optimization

The pipeline is optimized for:
- **Parallel execution** where possible
- **Caching** of dependencies and build artifacts
- **Minimal resource usage** with proper cleanup
- **Fast feedback** with fail-fast approach

## Contributing

When adding new services or tests:

1. ✅ Ensure your service has health check endpoint
2. ✅ Add appropriate test scripts to `package.json`
3. ✅ Update CI pipeline if new build steps needed
4. ✅ Add Docker build configuration
5. ✅ Test the full pipeline locally before committing

## Integration with Development Workflow

```bash
# Before committing
pnpm run ci

# Before pushing  
git add .
git commit -m "feat: your changes"
pnpm run ci  # Final check

# Push - GitHub Actions will run the same pipeline
git push
```

This ensures consistent testing across local development and CI environments.