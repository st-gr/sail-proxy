---
title: SAIL-PROXY Developer Guide - Chapter 7
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-6-ollama.md) | [Content Table](README.md) | [Next Chapter >>](chapter-8-workspace-layout.md)

---

## Docker & Deployment

### Multi-Architecture Support

SAIL-PROXY fully supports multi-architecture deployments, enabling native performance on both AMD64 (Intel/AMD) and ARM64 (Apple Silicon) platforms.

#### Architecture Support Matrix

| Platform | Local Development | Production Builds | Performance |
|----------|------------------|-------------------|-------------|
| **AMD64 (Intel/AMD)** | ✅ Native | ✅ Native | Optimal |
| **ARM64 (Apple Silicon M1/M2/M3)** | ✅ Native | ✅ Native | Optimal |
| **Mixed Environments** | ✅ Platform Override | ✅ Multi-arch Images | Optimal |

#### Apple Silicon (ARM64) Quick Start

**For Apple Silicon Macs (M1/M2/M3)**, use the ARM64-optimized commands:

```bash
# Setup (detects architecture automatically)
node docker/setup-docker.js

# Build (native ARM64 images)
docker-compose build

# Deploy with platform override (recommended)
docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d
```

The setup script automatically detects Apple Silicon and provides the appropriate commands.

### Docker Build Process

#### Multi-Architecture Build Options

**1. Local Single-Architecture Builds** (Default):
```bash
# Builds native images for your platform (ARM64 on Apple Silicon, AMD64 on Intel)
docker-compose build

# Use existing build script for single-arch
pnpm docker:build
node docker/scripts/build-and-tag.js
```

**2. Multi-Architecture Builds** (Production):

> **Note:** `setup-docker.js` is **NOT required** for building Docker images. The `.dockerignore` file excludes all `.env*` files from the build context, and Dockerfiles never copy `.env` files. This ensures secrets are never baked into images. Run `setup-docker.js` only on the deployment target before running `docker-compose up`.

```bash
# Build for both AMD64 and ARM64 platforms
pnpm docker:buildx
node docker/scripts/build-and-tag-multiarch.js

# Build specific service only
pnpm docker:buildx -- --service gateway

# Build with no cache (use sparingly - increases build time and disk usage)
pnpm docker:buildx -- --no-cache
```

#### Multi-Architecture Builder Setup

The multi-arch script automatically manages Docker Buildx:

```bash
# Check if builder exists and supports multi-arch
docker buildx inspect sail-proxy-builder

# If ARM64 support is missing, install QEMU binaries:
sudo docker run --privileged --rm tonistiigi/binfmt --install arm64,arm

# Recreate builder with full platform support
docker buildx rm sail-proxy-builder
docker buildx create --name sail-proxy-builder --driver docker-container --use --bootstrap
```

#### Troubleshooting Multi-Architecture Builds

Multi-architecture builds are resource-intensive and can encounter specific issues. Here are common problems and solutions:

**Issue: `ENOSPC: no space left on device` during build**

This error occurs when the Docker Buildx builder container runs out of disk space. Your host machine may have plenty of disk space, but the builder uses separate container storage.

```bash
# Step 1: Prune the buildx builder cache
docker buildx prune --builder sail-proxy-builder --all

# Step 2: If needed, prune all Docker build caches
docker builder prune -a
```

**Issue: `SIGSEGV` (segmentation fault) in esbuild during cross-compilation**

This occurs when building AMD64 images on Apple Silicon (or vice versa) due to QEMU emulation issues.

```bash
# Step 1: Update QEMU binaries for cross-compilation
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64

# Step 2: Recreate the builder with fresh configuration
docker buildx rm sail-proxy-builder
docker buildx create --name sail-proxy-builder --driver docker-container --use --bootstrap
```

**Complete Recovery Procedure**

If you encounter build failures (ENOSPC, SIGSEGV, or other errors), run all steps in sequence:

```bash
# 1. Clean up Docker builder cache
docker buildx prune --builder sail-proxy-builder --all

# 2. Update QEMU emulation binaries
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64

# 3. Recreate the builder
docker buildx rm sail-proxy-builder
docker buildx create --name sail-proxy-builder --driver docker-container --use --bootstrap

# 4. Retry the build (without --no-cache to benefit from layer caching)
node docker/scripts/build-and-tag-multiarch.js
```

**Tips for Successful Multi-Arch Builds**

- **Avoid `--no-cache`** unless absolutely necessary - layer caching significantly reduces build time and disk usage
- **Build incrementally** if issues persist: use `--service gateway` to build one service at a time
- **Monitor disk usage** during builds: `docker buildx du --builder sail-proxy-builder`
- **Allow sufficient time**: Multi-arch builds take ~2.5 hours for all services

#### Multi-stage Dockerfile Structure

**Gateway Service Dockerfile** (`services/gateway/Dockerfile`):
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Admin Service Dockerfile** (`services/admin/Dockerfile`):
```dockerfile
FROM node:20-alpine
WORKDIL /app

# Install CAP CLI
RUN npm install -g @sap/cds-dk pnpm

# Copy package files
COPY package*.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build and deploy
RUN npx cds build
RUN npx cds deploy --to sqlite:db/admin.db

EXPOSE 4004
CMD ["npx", "cds", "serve"]
```

#### Build Commands (adapted from project docs)

**Build all images**:
```bash
# Standard build
docker-compose build

# No-cache rebuild (when dependencies change)
docker-compose build --no-cache
```

**Warning about Admin image** (from project docs):
> Admin image takes the longest to build due to CAP framework compilation

**Complete rebuild with volume reset**:
```bash
# WARNING: Destroys all data
docker-compose down
docker volume rm docker_postgres_data docker_valkey_data
docker-compose build --no-cache
docker-compose up -d
```

### Docker Compose Configuration

#### Multi-Platform Deployment Strategy

**Standard Deployment** (works on all platforms):
```bash
docker-compose up -d
```

**Apple Silicon Optimized** (M1/M2/M3 Macs):
```bash
# Recommended: Uses ARM64 override for better compatibility
docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d
```

**Registry-Only Mode** (uses pre-built images):
```bash
docker-compose -f docker-compose.yml -f docker-compose.registry.yml up
```

#### Apple Silicon Override (`docker-compose.arm64.yml`)

For Apple Silicon compatibility, some services require AMD64 emulation:

```yaml
# docker-compose.arm64.yml - Platform overrides for Apple Silicon
services:
  # Force AMD64 emulation for services without ARM64 builds
  dex:
    platform: linux/amd64  # Dex OIDC provider - no native ARM64
  
  oauth2-proxy:
    platform: linux/amd64  # OAuth2-proxy - no native ARM64

# Other services run natively on ARM64:
# - pgvector/pgvector:pg16-trixie (✅ multi-arch)
# - valkey/valkey:8 (✅ multi-arch) 
# - nginx:alpine (✅ multi-arch)
# - Custom services (gateway, admin, ollama, nginx) - built natively
```

#### Service Stack (`docker-compose.yml`)

```yaml
version: '3.8'

services:
  # Core Services
  gateway:
    build: ./services/gateway
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - OAUTH_URL=${OAUTH_URL}
      - CLIENT_ID=${CLIENT_ID}
      - CLIENT_SECRET=${CLIENT_SECRET}
    depends_on:
      - postgres
      - valkey
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  admin:
    build: ./services/admin
    ports:
      - "4004:4004"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/sail_proxy
    depends_on:
      - postgres
      - valkey

  # Infrastructure Services
  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=sail_proxy
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  valkey:
    image: valkey/valkey:8
    command: valkey-server --requirepass ${VALKEY_PASSWORD}
    environment:
      - VALKEY_PASSWORD=${VALKEY_PASSWORD}
    volumes:
      - valkey_data:/data

  # Auth & Proxy Layer
  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:v7.4.0
    command:
      - --config=/etc/oauth2-proxy/oauth2-proxy.cfg
    volumes:
      - ./config/oauth2-proxy.cfg:/etc/oauth2-proxy/oauth2-proxy.cfg
    depends_on:
      - dex

  dex:
    image: dexidp/dex:v2.37.0
    command: ["dex", "serve", "/etc/dex/config.yaml"]
    volumes:
      - ./config/dex.yaml:/etc/dex/config.yaml

  nginx:
    image: nginx:alpine
    ports:
      - "8080:80"
      - "8443:443"
    volumes:
      - ./config/nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - gateway
      - admin
      - oauth2-proxy

volumes:
  postgres_data:
  valkey_data:
```

### Development vs Production Configurations

#### Development Override (`docker-compose.override.yml`)

```yaml
version: '3.8'

services:
  gateway:
    build:
      target: development
    volumes:
      - ./services/gateway:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
      - DEBUG=sail-proxy:*
    command: ["pnpm", "run", "dev"]

  admin:
    volumes:
      - ./services/admin:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
    command: ["pnpm", "run", "dev"]

  # Use SQLite for development
  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_PASSWORD=development
```

### Architecture Detection and Setup

#### Enhanced Setup Script (`docker/setup-docker.js`)

The setup script automatically detects your architecture and provides platform-specific guidance:

```bash
# Run setup (detects architecture automatically)
node docker/setup-docker.js

# For Apple Silicon, the script will show:
# 🍎 Apple Silicon (ARM64) Detected
#    Some services require AMD64 emulation for compatibility.
#    Use the provided ARM64 override file for best performance.
#
# Recommended for Apple Silicon (M1/M2/M3):
# docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d
```

#### Architecture Detection Features

**Automatic Platform Detection**:
- Detects Apple Silicon (M1/M2/M3) vs Intel/AMD processors  
- Shows appropriate docker-compose commands for your platform
- Provides context about emulation vs native performance
- Guides users to optimal deployment strategies

**Platform-Specific Output Examples**:

**AMD64 (Intel/AMD) Systems**:
```bash
Next steps:
1. Build containers: docker-compose build
2. Start services: docker-compose up -d
3. Access: http://localhost:8080/admin/
```

**Apple Silicon (ARM64) Systems**:
```bash
Next steps:
1. Build containers: docker-compose build  # Builds native ARM64 images
2. Start services:
   # Standard (may have emulation overhead):
   docker-compose up -d
   
   # Recommended for Apple Silicon (M1/M2/M3):
   docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d
3. Access: http://localhost:8080/admin/

💡 Apple Silicon Notes:
   • The docker-compose.arm64.yml file forces AMD64 emulation for Dex and OAuth2-proxy
   • These services don't have native ARM64 builds but run well under emulation
   • All other services support native ARM64 for better performance
   • For future builds, consider: pnpm docker:buildx (creates multi-arch images)
```

### Development Docker Workflow (adapted from `/docs/DEVELOPMENT_DOCKER.md`)

#### Local Development Setup

**Initial setup**:
```bash
# Create development environment
cp .env.example .env.development
edit .env.development  # Configure development settings

# Start development stack
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

**Development workflow**:
```bash
# View logs
docker-compose logs -f gateway admin

# Restart specific service after changes
docker-compose restart gateway

# Execute commands in running containers
docker-compose exec gateway bash
docker-compose exec admin npx cds repl
```

### Apple Silicon Troubleshooting

#### Common Apple Silicon Issues and Solutions

**Issue: Services fail to start on Apple Silicon**
```bash
# Solution: Use the ARM64 override file
docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d

# Check which services are struggling
docker-compose logs dex oauth2-proxy
```

**Issue: Slow performance on Apple Silicon**
```bash
# Ensure you're using the ARM64 override (forces selective emulation)
docker-compose -f docker-compose.yml -f docker-compose.arm64.yml up -d

# Verify which containers are running under emulation
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# Expected: Only dex and oauth2-proxy should show platform warnings
```

**Issue: Build errors on ARM64**
```bash
# For local development: Build native ARM64 images
docker-compose build

# For production: Use multi-arch builder
pnpm docker:buildx

# If buildx fails, check platform support
docker buildx inspect sail-proxy-builder
```

**Issue: Multi-arch builder setup problems**
```bash
# Install QEMU binaries for ARM64 cross-compilation
sudo docker run --privileged --rm tonistiigi/binfmt --install arm64,arm

# Recreate the builder
docker buildx rm sail-proxy-builder
docker buildx create --name sail-proxy-builder --driver docker-container --use --bootstrap

# Verify platform support
docker buildx inspect sail-proxy-builder
# Should show: Platforms: linux/amd64, linux/arm64
```

**Issue: Docker Desktop performance on Apple Silicon**
```bash
# Optimize Docker Desktop settings for Apple Silicon:
# 1. Enable "Use Rosetta for x86/amd64 emulation" in Docker Desktop settings
# 2. Allocate adequate resources (4GB+ RAM, 2+ CPUs)
# 3. Enable "Use file sharing implementation" optimizations

# Check resource usage
docker stats

# Monitor emulation overhead
docker-compose logs --tail=100 dex oauth2-proxy | grep -i "platform\|emul"
```

### Multi-Architecture Production Builds

#### Registry Workflow for Multi-Platform Images

```bash
# Build and push multi-architecture images
pnpm docker:buildx

# Verify multi-arch manifest
docker buildx imagetools inspect ghcr.io/st-gr/sail-proxy-gateway:latest

# Deploy using registry mode (pulls appropriate architecture automatically)
docker-compose -f docker-compose.yml -f docker-compose.registry.yml up
```

#### CI/CD Multi-Architecture Pipeline

```yaml
# Example GitHub Actions workflow
name: Multi-Architecture Build
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3
      with:
        driver: docker-container
        platforms: linux/amd64,linux/arm64
    
    - name: Build and push multi-arch images
      run: |
        cd docker
        pnpm docker:buildx
      env:
        DOCKER_REGISTRY: ghcr.io
        DOCKER_ORGANIZATION: st-gr
        DOCKER_TAG: ${{ github.ref_name }}
```

### Fixing Docker Issues

#### 502 Bad Gateway Resolution (adapted from `/DOCKER_502_ERROR_RESOLUTION.md`)

**Common causes and fixes**:

1. **Service startup timing**:
```bash
# Check service status
docker-compose ps

# Wait for all services to be healthy
docker-compose up --wait

# Check health status
docker-compose exec gateway curl -f http://localhost:3000/health
```

2. **Network connectivity issues**:
```bash
# Test inter-service communication
docker-compose exec nginx curl -f http://gateway:3000/health
docker-compose exec nginx curl -f http://admin:4004/health

# Recreate networks
docker-compose down
docker network prune -f
docker-compose up -d
```

3. **Configuration problems**:
```bash
# Validate nginx config
docker-compose exec nginx nginx -t

# Check OAuth2 proxy config
docker-compose logs oauth2-proxy | grep -i error
```

#### Build Issues (adapted from `/DOCKER-BUILD-FIX.md`)

**Node.js version conflicts**:
```dockerfile
# Ensure consistent Node.js version across all services
FROM node:20.11.0-alpine AS base

# Use exact version in package.json
{
  "engines": {
    "node": ">=20.11.0",
    "pnpm": ">=8.15.0"
  }
}
```

**Package manager issues**:
```bash
# Clear Docker build cache
docker builder prune -f

# Rebuild with specific pnpm version
docker-compose build --build-arg PNPM_VERSION=8.15.0
```

### Fiori Elements Integration (adapted from `/FIORI_ELEMENTS_SHELL_EMBEDDING_SOLUTION.md`)

#### Shell Application Configuration

**Embedding Fiori apps in Docker**:
```javascript
// Shell component configuration
sap.ui.define([
  "sap/fe/core/AppComponent",
  "sap/base/util/UriParameters"
], function (AppComponent, UriParameters) {
  return AppComponent.extend("shell.Component", {
    init: function() {
      // Configure for containerized environment
      const baseUrl = window.location.origin + '/admin/';
      this.getModel().setServiceUrl(baseUrl + 'admin/');
      
      AppComponent.prototype.init.apply(this, arguments);
    }
  });
});
```

### Production Deployment

#### Production Environment Variables

**Required environment variables** (`.env.production`):
```bash
# SAP AI Core Configuration
OAUTH_URL=https://your-production-ai-core/oauth/token
CLIENT_ID=production-client-id
CLIENT_SECRET=production-client-secret

# Security Keys (256-bit each)
VALIDATION_TOKEN_SECRET=your-production-secret
METADATA_ENCRYPTION_KEY=your-production-encryption-key
AWS_SECRET_ENCRYPTION_KEY=your-production-aws-key

# Database Configuration
POSTGRES_PASSWORD=secure-production-password
VALKEY_PASSWORD=secure-valkey-password

# OAuth2 Configuration
GITHUB_CLIENT_ID=production-github-client
GITHUB_CLIENT_SECRET=production-github-secret
GITHUB_ORG=your-organization

# SSL Configuration
SSL_CERTIFICATE_PATH=/etc/nginx/ssl/cert.pem
SSL_PRIVATE_KEY_PATH=/etc/nginx/ssl/key.pem

# Production Settings
NODE_ENV=production
LOG_LEVEL=info
```

#### SSL/HTTPS Configuration

**Nginx SSL configuration** (`config/nginx.conf`):
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    
    location /api/ {
        proxy_pass http://gateway:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    location /admin/ {
        proxy_pass http://admin:4004/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

#### Monitoring and Health Checks

**Production monitoring**:
```yaml
# Add to docker-compose.yml
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./config/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana
    ports:
      - "3001:3000"
```

**Health check endpoints**:
```bash
# Service health checks
curl https://your-domain.com/api/health
curl https://your-domain.com/admin/health

# Database connectivity
docker-compose exec postgres pg_isready

# Cache connectivity
docker-compose exec valkey valkey-cli ping
```

### Backup and Recovery

#### Database Backup

```bash
# Backup PostgreSQL data
docker-compose exec postgres pg_dump -U postgres sail_proxy > backup_$(date +%Y%m%d).sql

# Restore from backup
docker-compose exec -T postgres psql -U postgres sail_proxy < backup_20250128.sql
```

#### Configuration Backup

```bash
# Backup configurations
tar -czf config_backup_$(date +%Y%m%d).tar.gz \
  config/ ssl/ .env docker-compose.yml

# Backup volumes
docker run --rm -v docker_postgres_data:/data \
  -v $(pwd):/backup alpine tar czf /backup/postgres_backup.tar.gz /data
```

## Kyma Deployment

### Architecture Overview

The Kyma deployment implements a **"Mesh at the Edge"** pattern, strategically using Istio service mesh only where needed for external access while optimizing backend services for performance.

#### Service Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kyma APIRule (External Access)              │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼──────────────────────────────┐
│              Edge Services (WITH Istio Sidecars)   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │    nginx    │ │oauth2-proxy │ │     dex     │  │
│  │    (2/2)    │ │    (2/2)    │ │    (2/2)    │  │
│  └─────────────┘ └─────────────┘ └─────────────┘  │
└─────────────────┬───────────────┬──────────────────┘
                  │               │
┌─────────────────▼───────────────▼──────────────────┐
│            Backend Services (NO Sidecars)          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │   gateway   │ │    admin    │ │  postgres   │  │
│  │    (1/1)    │ │    (1/1)    │ │    (1/1)    │  │
│  └─────────────┘ └─────────────┘ └─────────────┘  │
│                                   ┌─────────────┐  │
│                                   │   valkey    │  │
│                                   │    (1/1)    │  │
│                                   └─────────────┘  │
└────────────────────────────────────────────────────┘
```

#### Key Benefits

- **External Access**: APIRules require Istio sidecars for proper integration
- **Performance**: Backend services avoid sidecar overhead and latency
- **Security**: mTLS between edge services, optimized plaintext for backends
- **Scalability**: Independent scaling of edge vs. backend components
- **Compatibility**: PERMISSIVE mTLS mode allows mixed mesh/non-mesh communication

### Deployment Process

#### Automated Deployment (Recommended)

```bash
# Navigate to Kyma directory
cd kyma/

# Run integrated deployment script
node scripts/deploy-kyma.js
```

The deployment script performs:
1. **Namespace cleanup**: Removes any existing deployment
2. **Interactive configuration**: Prompts for cluster, registry, and auth settings
3. **Manifest generation**: Creates Kubernetes manifests from templates
4. **Image building**: Builds and pushes container images to registry
5. **Dependency-aware deployment**: Deploys components in correct order
6. **Health verification**: Validates deployment success

#### Manual Deployment Process

> **Prerequisites**: Before running kubectl commands, ensure you have proper cluster access configured. See the [Prerequisites Guide](../../kyma/docs/PREREQUISITES.md) for kubectl, krew, and oidc-login setup instructions.

For detailed control or CI/CD integration:

```bash
# 1. Generate manifests
node scripts/setup-kyma.js

# 2. Build and push images
cd ../docker
docker build -t your-registry/sail-proxy-gateway:tag -f Dockerfile.gateway .
docker build -t your-registry/sail-proxy-admin:tag -f Dockerfile.admin .
docker build -t your-registry/sail-proxy-nginx:tag -f Dockerfile.nginx .
docker push your-registry/sail-proxy-gateway:tag
docker push your-registry/sail-proxy-admin:tag
docker push your-registry/sail-proxy-nginx:tag

# 3. Deploy infrastructure
cd ../kyma
kubectl apply -f manifests/core/namespace.yaml
kubectl apply -f manifests/core/postgres.yaml
kubectl apply -f manifests/core/valkey.yaml
kubectl apply -f manifests/core/network-policies.yaml

# 4. Deploy configuration
kubectl apply -f templates/secrets/
kubectl apply -f templates/configmaps/

# 5. Deploy applications
kubectl apply -f manifests/auth/
kubectl apply -f manifests/core/gateway.yaml
kubectl apply -f manifests/core/admin.yaml
kubectl apply -f manifests/core/nginx.yaml

# 6. Deploy networking
kubectl apply -f manifests/networking/
```

### Configuration Management

#### Environment-Specific Configurations

**Development Configuration**:
```yaml
# kyma/templates/manifests/core/gateway.yaml
env:
- name: LOG_LEVEL
  value: "debug"
- name: PAYLOAD_LOGGING_ENABLED
  value: "true"
```

**Production Configuration**:
```yaml
# Production hardening
env:
- name: LOG_LEVEL
  value: "info"
- name: PAYLOAD_LOGGING_ENABLED
  value: "false"
- name: RATE_LIMIT_ENABLED
  value: "true"
```

#### Secret Management

**Kubernetes Secrets Structure**:
```bash
# Generated secrets (setup-kyma.js)
├── gateway-env          # Gateway service secrets
├── admin-env           # Admin service secrets  
├── postgres-secret     # Database credentials
├── registry-secret     # Container registry access
└── oauth2-proxy-env    # Authentication secrets
```

**ConfigMaps Structure**:
```bash
# Generated configuration (setup-kyma.js)
├── gateway-config      # Non-sensitive gateway config
├── admin-config       # Non-sensitive admin config
├── admin-api-config   # Admin service API configuration
└── dex-config         # OIDC provider configuration
```

### Monitoring and Observability

#### Built-in Kyma Monitoring

```bash
# Access Kyma dashboard
kubectl get apirule -n kyma-system

# Monitor resource usage
kubectl top pods -n sail-proxy
kubectl top nodes

# Check Istio metrics
kubectl get --raw /stats/prometheus | grep sail_proxy
```

#### Custom Metrics Collection

**ServiceMonitor Configuration** (adapted from `/kyma/manifests/monitoring/servicemonitor.yaml`):
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: sail-proxy-metrics
  namespace: sail-proxy
spec:
  selector:
    matchLabels:
      app: gateway
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

#### Log Aggregation

```bash
# Centralized logging
kubectl logs -f deployment/gateway -n sail-proxy
kubectl logs -f deployment/admin -n sail-proxy
kubectl logs -f deployment/nginx -n sail-proxy

# Authentication flow logs
kubectl logs -f deployment/oauth2-proxy -n sail-proxy
kubectl logs -f deployment/dex -n sail-proxy

# Infrastructure logs
kubectl logs -f deployment/postgres -n sail-proxy
kubectl logs -f deployment/valkey -n sail-proxy
```

### Network Security

#### Network Policies

The Kyma deployment includes comprehensive network policies (adapted from `/kyma/manifests/core/network-policies.yaml`):

```yaml
# Example: Gateway egress policy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-policies
  namespace: sail-proxy
spec:
  podSelector:
    matchLabels:
      app: gateway
  policyTypes:
  - Egress
  egress:
  # Allow access to admin service
  - to:
    - podSelector:
        matchLabels:
          app: admin
    ports:
    - protocol: TCP
      port: 4004
  # Allow access to Istio control plane
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: istio-system
```

#### Istio Security

**PeerAuthentication** (PERMISSIVE mTLS):
```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: sail-proxy
spec:
  mtls:
    mode: PERMISSIVE  # Allows mixed mesh/non-mesh communication
```

**DestinationRules** (Service communication):
```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: backend-services
  namespace: sail-proxy
spec:
  host: "*.sail-proxy.svc.cluster.local"
  trafficPolicy:
    tls:
      mode: DISABLE  # Plain text for backend services
```

### Production Hardening

#### Resource Management

```yaml
# Resource limits (example from gateway.yaml)
resources:
  limits:
    cpu: "1000m"
    memory: "512Mi"
  requests:
    cpu: "100m"
    memory: "128Mi"
```

#### Horizontal Pod Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gateway-hpa
  namespace: sail-proxy
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gateway
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

#### Security Scanning

```bash
# Container image scanning
docker scan your-registry/sail-proxy-gateway:tag

# Kubernetes security scanning
kubectl apply -f https://github.com/aquasecurity/trivy-operator/releases/latest/download/trivy-operator.yaml
kubectl get vulnerabilityreports -n sail-proxy
```

### Troubleshooting

#### Common Issues

**Pod Connectivity Problems**:
```bash
# Debug network policies
kubectl describe networkpolicy -n sail-proxy

# Test service connectivity
kubectl exec -it deployment/gateway -n sail-proxy -- curl http://admin:4004/api/health

# Check Istio configuration
kubectl get destinationrule -n sail-proxy
kubectl get peerauthentication -n sail-proxy
```

**Authentication Flow Issues**:
```bash
# Check OAuth2 provider configuration
kubectl logs -f deployment/oauth2-proxy -n sail-proxy
kubectl logs -f deployment/dex -n sail-proxy

# Verify GitHub/Okta organization access
kubectl describe configmap dex-config -n sail-proxy
```

**External Access Problems**:
```bash
# Check APIRule status
kubectl describe apirule -n sail-proxy

# Verify Istio Gateway
kubectl get gateway -n istio-system

# Test external connectivity
curl -I https://your-subdomain.your-cluster-id.kyma.ondemand.com/
```

#### Performance Optimization

**Database Tuning**:
```sql
-- PostgreSQL connection optimization
ALTER SYSTEM SET max_connections = '200';
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET work_mem = '4MB';
SELECT pg_reload_conf();
```

**Cache Optimization**:
```bash
# Valkey memory optimization
kubectl exec -it deployment/valkey -n sail-proxy -- valkey-cli CONFIG SET maxmemory 256mb
kubectl exec -it deployment/valkey -n sail-proxy -- valkey-cli CONFIG SET maxmemory-policy allkeys-lru
```

### Backup and Disaster Recovery

#### Database Backup

```bash
# Automated backup job
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: sail-proxy
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: postgres-backup
            image: postgres:15
            command:
            - /bin/bash
            - -c
            - |
              pg_dump -h postgres -U postgres sail_proxy > /backup/backup_$(date +%Y%m%d_%H%M%S).sql
            env:
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
            volumeMounts:
            - name: backup-storage
              mountPath: /backup
          restartPolicy: OnFailure
          volumes:
          - name: backup-storage
            persistentVolumeClaim:
              claimName: backup-pvc
```

#### Configuration Backup

```bash
# Export all configurations
kubectl get configmaps -n sail-proxy -o yaml > configmaps-backup.yaml
kubectl get secrets -n sail-proxy -o yaml > secrets-backup.yaml
kubectl get apirule -n sail-proxy -o yaml > networking-config.yaml
```

---

*Next: Explore the [Workspace Layout](chapter-8-workspace-layout.md) and monorepo organization.*