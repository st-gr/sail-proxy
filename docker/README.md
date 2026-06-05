# SAIL-PROXY Docker Deployment

This directory contains the Docker deployment configuration for SAIL-PROXY (SAP AI Core Multi-Provider API Gateway). The Docker deployment provides a production-ready setup with enterprise authentication, PostgreSQL database, Redis caching, and Nginx reverse proxy.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Apple Silicon Support](#apple-silicon-support)
- [Known Issues](#known-issues)
- [Authentication Providers](#authentication-providers)
- [Configuration](#configuration)
- [Services](#services)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Maintenance](#maintenance)

## Overview

The Docker deployment provides a complete, containerized setup of SAIL-PROXY with the following features:

- **Multi-provider authentication**: Local development, GitHub OAuth, Okta SAML, and LDAP/Active Directory
- **Microservices architecture**: Separate containers for gateway, admin, database, cache, and authentication
- **Multi-architecture support**: Native ARM64 support for Apple Silicon (M1/M2/M3) and AMD64 compatibility
- **Production-ready**: Built-in security hardening, SSL support, and monitoring capabilities
- **Automated setup**: Interactive script for configuration and deployment with architecture detection
- **High availability**: Support for horizontal scaling and external databases

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Nginx     │────▶│ OAuth2-Proxy│────▶│    Dex      │
│  (Reverse   │     │   (Auth)    │     │   (IdP)     │
│   Proxy)    │     └─────────────┘     └─────────────┘
└──────┬──────┘              │                   │
       │                     │                   │
       ▼                     ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Gateway   │────▶│    Admin    │     │ External IdP│
│  Service    │     │  Service    │     │ (Okta/LDAP) │
└──────┬──────┘     └──────┬──────┘     └─────────────┘
       │                   │
       ▼                   ▼
┌─────────────┐     ┌─────────────┐
│   Valkey    │     │ PostgreSQL  │
│  (Cache)    │     │ (Database)  │
└─────────────┘     └─────────────┘
```

## Quick Start

### Prerequisites

- Docker Engine 20.10+ and Docker Compose 2.0+
- Node.js 18+ (for setup script)
- 4GB RAM minimum (8GB recommended for production)
- SAP AI Core service key (optional, for AI Core integration)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-org/sail-proxy.git
   cd sail-proxy/docker
   ```

2. **Run the setup script** (Required - generates .env files)
   ```bash
   node setup-docker.js
   # Or if inquirer is not installed:
   npx -y -p inquirer@8.2.6 node setup-docker.js
   ```
   
   **Automated Setup** (for CI/CD):
   ```bash
   # Option 1: Use CI flag for full automation with local development setup
   node setup-docker.js --ci
   
   # Option 2: Combine with SAP AI Core service key for production automation
   export SAP_AI_CORE_SERVICE_KEY='{"serviceurls":{"AI_API_URL":"https://api.ai..."},...}'
   node setup-docker.js --ci --force
   ```
   
   ⚠️ **Important**: This step is required before `docker-compose build` or you'll get ".env file not found" errors.

3. **Start the services**
   ```bash
   docker-compose up -d
   ```

4. **Access the application**
   - Admin UI: http://localhost:8080/admin/app/shell
   - Gateway API: http://localhost:8080/v1/chat/completions

## Apple Silicon Support

All Docker images in this project are built as multi-architecture images supporting both AMD64 (Intel/AMD) and ARM64 (Apple Silicon M1/M2/M3) platforms. No special configuration is needed for Apple Silicon Macs - simply use the standard docker-compose commands.

**Architecture Detection**: The setup script automatically detects your platform and will show confirmation that all services support native ARM64 for optimal performance.

### Setup Script Options

The `setup-docker.js` script provides an interactive configuration experience:

```bash
# Show help
node setup-docker.js --help

# Force overwrite existing configuration
node setup-docker.js --force

# CI/CD mode - use default options (local auth, no backup, localhost)
node setup-docker.js --ci

# Combine flags
node setup-docker.js --ci --force

# Show version
node setup-docker.js --version
```

**CI/CD Mode (`--ci` flag)**:
When the `--ci` flag is used, the script automatically selects:
- **Authentication Provider**: Local Development (hardcoded users)
- **Backup Creation**: Skipped (no backup prompt)
- **Logout Redirect URL**: Auto-shell (default)
- **Base URL**: http://localhost:8080 (development)

This enables fully automated setup in CI/CD pipelines without interactive prompts.

> **Note**: Nginx configuration is now handled via environment variables at container startup. No rebuild is required when changing authentication providers or base URLs - simply restart the containers.

## Known Issues

### Rancher Desktop WSL2 Volume Mount Bug

**⚠️ Critical Issue**: When using Rancher Desktop with WSL2, individual file volume mounts are incorrectly mounted as directories, causing `EISDIR: illegal operation on a directory, read` errors.

#### Symptoms
- Node.js applications fail to read mounted configuration files
- Error message: `Error: EISDIR: illegal operation on a directory, read`
- Files appear as directories inside containers: `drwxr-xr-x ... /app/services/admin/api_config.json`
- Only affects single-file mounts, directory mounts work correctly

#### Root Cause
Rancher Desktop uses a staging directory approach for WSL2 volume mounts:
1. Creates staging directories under `/mnt/wsl/rancher-desktop/run/docker-mounts/<guid>`
2. Mounts the staging directory (not the original file) into the container
3. Linux mount semantics interpret the directory mount on a file path as a directory

#### Affected Volume Mounts
```yaml
# These file mounts fail with Rancher Desktop + WSL2:
volumes:
  - ../services/admin/api_config.json:/app/services/admin/api_config.json
  - ../services/gateway/api_config.json:/app/services/gateway/api_config.json

# These directory mounts work correctly:
volumes:
  - ../logs/admin:/app/services/admin/logs
```

#### Solution

**Recommended: Run docker-compose from Windows Shell (Automatic Detection)**

The setup script automatically detects if you're running under WSL2 with Rancher Desktop and displays a prominent warning:

```
╔═════════════════════════════════════════════════════════════════════╗
║                           ⚠️  WARNING                               ║
╠═════════════════════════════════════════════════════════════════════╣
║ Do not run docker-compose from Windows WSL2 (e.g. Ubuntu) with SUSE ║
║ Rancher Desktop - bug: single file mounts may be interpreted as     ║
║ directories.                                                        ║
║                                                                     ║
║ See: https://github.com/rancher-sandbox/rancher-desktop/issues/5632 ║
║                                                                     ║
║ Please execute docker-compose from a Windows shell, not WSL.        ║
╚═════════════════════════════════════════════════════════════════════╝
```

**To avoid this issue:**
1. Run the setup script and docker-compose commands from **Windows PowerShell** or **Windows CMD**
2. Do not run docker-compose from within WSL2 (e.g., Ubuntu terminal)
3. The bug does not occur when orchestrating from the Windows host

**Alternative Workarounds (if you must use WSL2):**
- **Option A**: Use directory mounts instead of file mounts in docker-compose.yml
- **Option B**: Switch to Docker Desktop for Windows (does not have this bug)
- **Option C**: Use native Linux Docker (not Windows-hosted Rancher Desktop)

#### Verification Commands
```bash
# Check if files are mounted as directories (problematic):
docker exec -it <container> ls -ld /app/services/admin/api_config.json

# Expected (file): -rwxr-xr-x ... /app/services/admin/api_config.json
# Actual (bug):    drwxr-xr-x ... /app/services/admin/api_config.json

# Check Docker mount sources:
docker inspect <container> | jq '.[0].Mounts'
# Look for /mnt/wsl/rancher-desktop/run/docker-mounts/<guid> paths
```

#### References
- [Rancher Desktop Issue #5632](https://github.com/rancher-sandbox/rancher-desktop/issues/5632) - Single file mounts may be interpreted as directories (primary issue)
- [Rancher Desktop Issue #1307](https://github.com/rancher-sandbox/rancher-desktop/issues/1307) - WSL Linux: Moby: mounting files is broken
- [Rancher Desktop Issue #4286](https://github.com/rancher-sandbox/rancher-desktop/issues/4286) - Failure to start container with file mounts
- [Rancher Desktop Issue #2461](https://github.com/rancher-sandbox/rancher-desktop/issues/2461) - Docker compose doesn't mount files

#### Status
This is a known limitation of Rancher Desktop's WSL2 integration. The issue affects `docker-compose` but not `docker run` commands.

**Automatic Detection**: The setup script (`docker/setup-docker.js`) automatically detects if you're running under WSL2 with Rancher Desktop and displays a warning directing you to run docker-compose from a Windows shell instead. This is the recommended and simplest solution.

### WSL2 Compatibility Notes

When running from WSL2 with Windows-hosted Docker:
- ✅ **Directory volume mounts**: Work reliably
- ❌ **Individual file mounts**: Prone to staging directory issues
- ✅ **Environment variables**: Always work correctly
- ✅ **Named volumes**: Work reliably
- ⚠️ **Path permissions**: May require adjustment for mounted directories

## Authentication Providers

### Local Development
- **Purpose**: Development and testing only
- **Users**: admin@example.com (admin), user@example.com (user)
- **Security**: ⚠️ Not for production use

### GitHub OAuth
- **Purpose**: Team-based authentication using GitHub organizations
- **Setup**: Requires GitHub OAuth App registration
- **Features**: Organization and team-based role mapping

### Okta SAML
- **Purpose**: Enterprise SSO with SAML 2.0
- **Setup**: Requires Okta application configuration
- **Features**: Group-based role mapping, automatic certificate management

### LDAP/Active Directory
- **Purpose**: Corporate directory integration
- **Setup**: Supports both local test LDAP and external AD
- **Features**: Group-based authorization, secure bind authentication

## Docker Image Management

### Image Modes

The project supports two Docker image management modes:

#### Local Build Mode (Default)
- **Behavior**: Builds images locally from source code
- **Use Case**: Development, testing Dockerfile changes, custom builds
- **Setup**: Creates `docker-compose.override.yml` with `pull_policy: build`, creates `.env` for version consistency
- **Environment Files**:
  - `.env.docker`: Used by setup script 
  - `.env`: Created automatically for manual docker-compose commands with consistent versioning
- **Commands**:
  ```bash
  docker-compose build        # Build all images (uses .env for version tags)
  docker-compose up --build   # Build and start (uses .env for version tags)
  ```

#### Registry Mode
- **Behavior**: Pulls pre-built images from container registry (e.g., ghcr.io)
- **Use Case**: Production deployments, faster startup, CI/CD pipelines
- **Setup**: Removes override file, configures registry in `.env.docker`, creates `.env` for manual commands
- **Environment Files**:
  - `.env.docker`: Used by setup script for automated pulls
  - `.env`: Created automatically for manual docker-compose commands
- **Commands**:
  ```bash
  docker-compose pull         # Pull images from registry (uses .env)
  docker-compose up -d        # Start with registry images (uses .env)
  ```

### Switching Between Modes

After initial setup, you can switch modes using these commands:

```bash
# Switch to local build mode
pnpm run docker:use-local

# Switch to registry mode  
pnpm run docker:use-registry
```

**Important**: When using registry mode, always run `docker-compose pull` before `docker-compose up` to avoid local builds. The setup script will offer to do this automatically for interactive sessions.

### Alternative Registry-Only Approach

For strict registry-only mode (never attempts local builds):

```bash
# Use docker-compose.registry.yml overlay
docker-compose -f docker-compose.yml -f docker-compose.registry.yml up
```

## Configuration

### Environment Files

The setup script creates the following environment files:

- `services/gateway/.env` - Gateway service configuration
- `services/admin/.env` - Admin service configuration
- `services/ollama/.env` - Ollama service configuration (optional)
- `docker/.env.auth` - Authentication configuration
- `docker/.env.postgres` - PostgreSQL configuration
- `docker/.env.docker` - Docker image registry configuration

### Key Configuration Options

#### SAP AI Core Integration
- Configure during setup or skip for local development
- Supports service key JSON import or manual entry
- **Automated setup**: Use `SAP_AI_CORE_SERVICE_KEY` environment variable for CI/CD
- Required for production deployments

**Environment Variable Configuration**:
```bash
# Set the complete SAP BTP AI Core service key as JSON
export SAP_AI_CORE_SERVICE_KEY='{"serviceurls":{"AI_API_URL":"https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com"},"url":"https://your-subdomain.authentication.us10.hana.ondemand.com","clientid":"your-client-id","clientsecret":"your-client-secret"}'

# Run setup script - it will automatically detect and use the service key
node setup-docker.js
```

When `SAP_AI_CORE_SERVICE_KEY` is set, the setup script will:
- Skip the interactive SAP AI Core configuration prompts
- Parse and validate the JSON service key
- Extract all required configuration values automatically
- Fall back to interactive mode if the JSON is invalid

#### Role Mapping
- Maps external groups/teams to application roles (admin/user)
- Automatically configured based on authentication provider
- Customizable through ROLE_MAPPING environment variable

#### Security Tokens
- Automatically generated during setup
- Shared between gateway and admin services
- Must match for proper service communication

## Services

### Core Services

1. **Gateway Service** (Port 3000)
   - Handles API requests and routing
   - Integrates with SAP AI Core
   - Implements caching and rate limiting

2. **Admin Service** (Port 4004)
   - Web UI for administration
   - API key and AWS credential management
   - Usage tracking and analytics

3. **PostgreSQL** (Port 5432)
   - Primary database for all services
   - Stores API keys, credentials, and usage data
   - Supports draft handling for UI applications

4. **Valkey (Redis)** (Port 6379)
   - High-performance caching
   - Session storage for authentication
   - Circuit breaker state management

### Authentication Services

5. **Nginx** (Port 8080)
   - Reverse proxy and load balancer
   - JWT validation for API requests
   - SSL termination (production)
   - **Configurable via environment variables** - no rebuild required for configuration changes
   - See [nginx/README.md](nginx/README.md) for detailed configuration options

6. **OAuth2-Proxy** (Port 4180)
   - Handles authentication flow
   - Session management
   - Group/role forwarding

7. **Dex** (Port 5556)
   - Identity provider hub
   - SAML, LDAP, and OAuth connectors
   - Token issuance

### Optional Services

8. **Ollama** (when enabled)
   - Local LLM hosting
   - Compatible with OpenAI API format

9. **LDAP Server** (when using local LDAP)
   - Test LDAP server for development
   - Pre-configured users and groups

## Production Deployment

### SSL/TLS Configuration

1. **Update base URL** in setup script to use HTTPS
2. **Configure SSL certificates** via environment variables or volume mounts (see docker/nginx/README.md)
3. **Enable secure cookies** in OAuth2-proxy configuration

### External Database

For production, use an external PostgreSQL instance:

1. Update `.env.postgres` with external database credentials
2. Remove the postgres service from docker-compose.yml
3. Ensure network connectivity from containers

### High Availability

1. **Horizontal scaling**: Run multiple gateway/admin instances
2. **Load balancing**: Configure Nginx upstream servers
3. **External cache**: Use managed Redis/Valkey service
4. **Database replication**: Configure PostgreSQL streaming replication

### Monitoring

- Health endpoints: `/health` on all services
- Prometheus metrics: Available on gateway and admin services
- Logging: Centralized logging to `/logs` volumes
- OpenTelemetry: Optional tracing configuration

## Troubleshooting

### Common Issues

1. **"VALIDATION_TOKEN_SECRET does not match"**
   - Delete .env files and re-run setup script
   - Ensure tokens match between services

2. **"User shown as 'User' instead of 'Admin'"**
   - Check ROLE_MAPPING configuration
   - Verify group membership in identity provider
   - Restart containers after configuration changes

3. **PostgreSQL connection errors**
   - Verify PostgreSQL container is running
   - Check database credentials in .env.postgres
   - Ensure proper network connectivity

3a. **Dex authentication failure: "pq: password authentication failed"**
   ```
   dex-1  | failed to initialize storage: failed to perform migrations:
   dex-1  | creating migration table: pq: password authentication failed for user "admin_user"
   ```
   - **Cause**: Existing Docker volumes contain old database credentials that don't match new configuration
   - **Solution**: Delete volumes and recreate database with new credentials
   ```bash
   # Stop all services
   docker-compose down

   # Remove database volumes (WARNING: This deletes all data)
   docker volume rm docker_postgres_data docker_valkey_data

   # Start services with fresh database
   docker-compose up -d
   ```
   - **Prevention**: The setup script now detects this condition and prompts to delete volumes automatically
   - **Note**: If you need to preserve data, ensure you use identical username/password when re-running setup

4. **Authentication redirect loops**
   - Verify BASE_URL matches actual deployment URL
   - Check OAuth2-proxy cookie configuration
   - Ensure proper CORS settings

5. **"EISDIR: illegal operation on a directory, read" (WSL2 + Rancher Desktop)**
   - This indicates a volume mount issue where files are mounted as directories
   - **Quick fix**: Use directory mounts instead of file mounts (see [Known Issues](#known-issues))
   - **Diagnosis**: Check if you're using Rancher Desktop with WSL2
   - **Verification**: Run `docker exec <container> ls -ld /path/to/mounted/file`
   - **Alternative**: Switch to Docker Desktop or bake config files into images

6. **Docker images building instead of pulling from registry (Windows)**
   - This occurs when setup-docker.js fails to pass environment variables to docker-compose on Windows
   - **Symptoms**: Script shows "Pulling Docker images" but then attempts to build locally
   - **Root cause**: Node.js execSync environment variable passing limitations on Windows
   - **Fix**: Update to latest setup-docker.js which uses `--env-file` approach
   - **Verification**: Check that `.env.docker` contains correct `DOCKER_TAG` and registry settings

### Debug Commands

```bash
# Check service logs
docker-compose logs -f [service-name]

# Verify authentication flow
docker logs docker-oauth2-proxy-1 --tail 50
docker logs docker-dex-1 --tail 50

# Test database connection
docker exec docker-postgres-1 psql -U admin_user -d sap_llm_gateway -c "SELECT 1"

# Check service health
curl http://localhost:8080/health

# Diagnose volume mount issues (WSL2 + Rancher Desktop)
docker exec <container-name> ls -ld /app/services/admin/api_config.json
docker inspect <container-name> | jq '.[0].Mounts'

# Check if running in WSL2
echo $WSL_DISTRO_NAME

# Verify Docker Compose environment variable resolution (Windows/PowerShell)
docker compose --env-file .env.docker config | Select-String "image:" | Select-Object -First 5

# Check .env.docker content
Get-Content .env.docker

# Manual environment variable test (PowerShell)
$env:DOCKER_REGISTRY = "ghcr.io"; $env:DOCKER_TAG = "0.9.0"; docker compose config | Select-String "image:"
```

## Security

### Security Features

- **Encrypted tokens**: All sensitive data encrypted at rest
- **JWT validation**: Nginx validates all API requests
- **CORS protection**: Configurable CORS policies
- **Rate limiting**: Built-in rate limiting on gateway
- **Audit logging**: Comprehensive security event tracking

### Credential Management

⚠️ **Important**: The setup script stores SAP AI Core credentials in `.env` files for development convenience. For production deployments:

#### Environment Variable Security:
When using `SAP_AI_CORE_SERVICE_KEY` for automation:
```bash
# ✅ Good: Use in CI/CD environments with proper secret management
export SAP_AI_CORE_SERVICE_KEY="$(cat /secure/path/service-key.json)"

# ✅ Good: Read from secure secret store
export SAP_AI_CORE_SERVICE_KEY="$(vault kv get -field=service_key secret/sap-ai-core)"

# ❌ Avoid: Setting directly in shell scripts or command line history
export SAP_AI_CORE_SERVICE_KEY='{"clientsecret":"visible-in-process-list"}'
```

#### Recommended Approaches:
1. **OS Environment Variables**:
   ```bash
   export CLIENT_SECRET="your-secret-here"
   export AUTH_URL="https://your-auth-domain.com/oauth/token"
   docker-compose up -d
   ```

2. **Docker Secrets** (Docker Swarm):
   ```yaml
   services:
     gateway:
       secrets:
         - sap_client_secret
   secrets:
     sap_client_secret:
       external: true
   ```

3. **Kubernetes Secrets**:
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: sap-credentials
   data:
     CLIENT_SECRET: <base64-encoded-secret>
   ```

4. **External Secret Management**:
   - HashiCorp Vault
   - AWS Secrets Manager
   - Azure Key Vault
   - Google Secret Manager

#### File Security:
```bash
# Set restrictive permissions on .env files
chmod 600 services/gateway/.env
chmod 600 services/admin/.env

# Ensure .env files are in .gitignore
echo "*.env" >> .gitignore
```

### Best Practices

1. **Use strong passwords** for all service accounts
2. **Rotate secrets regularly** using setup script
3. **Enable SSL/TLS** for all production deployments
4. **Restrict network access** using Docker networks
5. **Regular security updates** for all containers
6. **Never commit .env files** to version control

### Security Hardening

See [SECURITY-HARDENING.md](configs/shared/SECURITY-HARDENING.md) for detailed production security configuration.

## Maintenance

### Backup and Restore

```bash
# Backup database
docker exec docker-postgres-1 pg_dump -U admin_user sap_llm_gateway > backup.sql

# Backup configuration
tar -czf config-backup.tar.gz .env* dex.config.yaml

# Restore database
docker exec -i docker-postgres-1 psql -U admin_user sap_llm_gateway < backup.sql
```

### Updates

1. **Pull latest changes**
   ```bash
   git pull origin main
   ```

2. **Rebuild containers**
   ```bash
   docker-compose build --no-cache
   ```

3. **Apply database migrations**
   ```bash
   docker-compose run --rm admin npm run deploy:pg
   ```

4. **Restart services**
   ```bash
   docker-compose down
   docker-compose up -d
   ```

### Log Management

- Logs are stored in `../logs/[service-name]`
- Configure log rotation in production
- Use centralized logging for multiple instances

## Additional Documentation

- [Production Setup Guide](configs/shared/PRODUCTION-SETUP.md)
- [Security Hardening](configs/shared/SECURITY-HARDENING.md)
- [LDAP Integration](configs/providers/ldap/SETUP.md)
- [GitHub OAuth Setup](configs/providers/github/SETUP.md)
- [Okta SAML Setup](configs/providers/okta/SETUP.md)
- [Troubleshooting Guide](DOCKER-MIGRATION-ISSUES.md)
- [Baseline Testing](BASELINE-TESTING.md)

## Support

For issues and questions:

1. Check the [troubleshooting guide](DOCKER-MIGRATION-ISSUES.md)
2. Review logs using `docker-compose logs`
3. Submit issues to the project repository
4. Contact your system administrator for production deployments

## License

This Docker deployment configuration is part of the SAIL-PROXY project. See the main [LICENSE](../LICENSE) file for details.