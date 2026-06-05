# CI Pipeline Documentation

## Overview

This project includes a comprehensive, industry-standard CI pipeline that ensures code quality, security, and reliability across all services.

## Pipeline Structure

### Local Development
```bash
# Run the complete CI pipeline locally
pnpm run ci

# Or run it directly
node ci-pipeline.js
```

### GitHub Actions
The pipeline runs automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

## Pipeline Phases

### Phase 1: Environment Setup & Cleanup
- ✅ Validates `SAP_AI_CORE_SERVICE_KEY` JSON format
- 🧹 Cleans existing `.env` files
- 📦 Installs dependencies recursively with `pnpm`
- 🐳 Runs Docker setup script
- 🗄️ Starts Valkey cache container

### Phase 2: Service Compilation
- 🔨 Builds Gateway service (TypeScript → JavaScript)
- 🔨 Builds Admin service (CAP + TypeScript)
- 📦 Builds SAIL-PROXY npm distribution package
- 📁 Creates proper dist directories
- 🗄️ Resets database for clean testing

### Phase 3: Unit Testing
- 🧪 Gateway unit tests
- 🧪 Admin unit tests
- ❌ **Fail-fast**: Pipeline stops on any test failure

### Phase 4: Integration Environment
- 🚀 Starts Admin service in mock mode (35s startup)
- 🔑 Creates API key for Ollama service via REST API
- 🚀 Starts Gateway service (10s startup)
- 🚀 Starts Ollama service
- 🔍 Health checks for all services

### Phase 5: Full Test Suite
- 🧪 Gateway complete test suite
- 🧪 Admin complete test suite  
- 🧪 Ollama complete test suite

### Phase 6: Security Scanning
- 🛡️ npm audit for dependency vulnerabilities
- 🐳 Trivy Docker image vulnerability scanning
- 🔍 Static code analysis for security issues
- 🚨 Secret and credential detection
- ⚠️ Security TODO/FIXME identification

### Phase 7: Docker Validation
- 🐳 Tests `docker-compose build --no-cache`
- ✅ Ensures deployment readiness

## Key Features

### 🔄 Industry Standards
- **Fail-fast**: Any failure stops the entire pipeline
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