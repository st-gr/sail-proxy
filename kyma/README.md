# SAP LLM Gateway - Kyma Deployment

This directory contains the Kubernetes manifests and configuration templates for deploying the SAP LLM Gateway on SAP BTP Kyma runtime.

## Overview

The Kyma deployment provides:
- **Container orchestration** via Kubernetes
- **Public HTTPS access** via Kyma APIRule with TLS termination
- **Internal-only access** via SAP Cloud Connector Service Channel
- **Authentication** supporting Local, GitHub OAuth, LDAP, and Okta SAML
- **IP allowlisting** via Istio AuthorizationPolicy in istio-system namespace
- **Secrets management** via Kubernetes Secrets
- **Configuration management** via Kubernetes ConfigMaps

## Architecture

### Services
- **PostgreSQL** - Primary database (StatefulSet with persistent storage)
- **Valkey/Redis** - High-performance caching and sessions
- **Gateway** - API routing, SAP AI Core integration, request processing
- **Admin** - Web UI, API key management, analytics dashboard
- **NGINX** - Edge proxy with authentication integration
- **Dex** - Identity provider hub supporting multiple connectors
- **OAuth2-Proxy** - Authentication flow management (except local mode)

### Networking
- **Internal communication** - ClusterIP services for inter-service communication
- **External access options**:
  - **Public HTTPS**: Kyma APIRule → Istio Ingress → NGINX → Services
  - **Internal-only**: Cloud Connector Service Channel → ClusterIP services

## Directory Structure

```
kyma/
├── scripts/
│   └── setup-kyma.js          # Interactive setup script
├── manifests/
│   ├── core/                  # Core service deployments
│   │   ├── namespace.yaml     # Namespace definition
│   │   ├── postgres.yaml      # PostgreSQL StatefulSet and Service
│   │   ├── valkey.yaml        # Valkey Deployment and Service
│   │   ├── gateway.yaml       # Gateway Deployment and Service
│   │   ├── admin.yaml         # Admin Deployment and Service
│   │   └── nginx.yaml         # NGINX Deployment and Service
│   ├── auth/                  # Authentication services
│   │   ├── dex.yaml           # Dex Deployment and Service
│   │   ├── dex-rbac.yaml      # RBAC for Dex Kubernetes storage
│   │   └── oauth2-proxy.yaml  # OAuth2-Proxy Deployment and Service
│   └── networking/            # Public access configuration
│       └── apirule.yaml       # Kyma APIRule for HTTPS exposure
├── templates/
│   ├── secrets/               # Kubernetes Secret templates
│   │   ├── postgres-env.yaml  # PostgreSQL credentials
│   │   ├── gateway-env.yaml   # Gateway environment variables
│   │   └── admin-env.yaml     # Admin service environment variables
│   └── configmaps/            # Kubernetes ConfigMap templates
│       ├── nginx-conf.yaml    # NGINX configuration per auth provider
│       └── dex-config.yaml    # Dex configuration per auth provider
├── configs/
│   └── providers/             # Provider-specific configuration templates
│       ├── local/             # Local development (hardcoded users)
│       ├── github/            # GitHub OAuth configuration
│       ├── ldap/              # External LDAP configuration
│       └── okta/              # Okta SAML configuration
└── docs/
    └── README.md              # This file
```

## Quick Start

> 🚀 **Want to deploy quickly?** Run the automated deployment script: `node kyma/scripts/deploy-kyma.js`

### Prerequisites

- **Kyma cluster** with appropriate permissions
- **kubectl configured** to access your cluster (see [detailed setup guide](docs/PREREQUISITES.md))
- **Docker images** built and pushed to a registry  
- **Node.js** (for running setup script)

> 📋 **New to Kyma?** Check our comprehensive [Prerequisites Guide](docs/PREREQUISITES.md) for step-by-step instructions to install kubectl, krew, and oidc-login on macOS, Linux, and Windows.

#### Required Kyma Modules

Enable these modules in your Kyma cluster before deployment:

1. **istio** (Service Mesh) - Required for APIRule and network policies
2. **api-gateway** (APIRule) - Required for public HTTPS exposure
3. **telemetry** (Observability) - Recommended for monitoring and logs
4. **btp-operator** - Optional, for using SAP BTP managed services

**How to enable modules:**
- **Dashboard**: Kyma Dashboard → *Default Kyma* → *Edit modules*
- **CLI**: `kyma alpha enable module <module-name>`

#### Cluster Sizing Recommendations

**Production Starting Point:**
- 3 worker nodes minimum
- 2-4 vCPU / 8-16 GB RAM per node
- Scale based on actual load testing
- Configure HPA and PodDisruptionBudgets for auto-scaling

### 1. Build and Push Images

The setup script automatically runs `docker/setup-docker.js --ci` to prepare the nginx configuration. This creates a single nginx image that works for both Docker and Kyma deployments by using the `CONFIG_MODE` environment variable:
- Docker deployment: `CONFIG_MODE=template` (default)
- Kyma deployment: `CONFIG_MODE=configmap` (set in nginx.yaml)

The setup script will configure your container registry automatically. Here are examples for different registries:

**GitHub Container Registry (recommended):**
```bash
# Login to GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Build images (from project root)  
docker build -t ghcr.io/your-username/sail-proxy-gateway:1.0.0 -f docker/gateway.Dockerfile .
docker build -t ghcr.io/your-username/sail-proxy-admin:1.0.0 -f docker/admin.Dockerfile .

# Build nginx (setup-kyma.js runs docker setup automatically)
docker build -t ghcr.io/your-username/sail-proxy-nginx:1.0.0 -f docker/nginx/Dockerfile docker

# Push images
docker push ghcr.io/your-username/sail-proxy-gateway:1.0.0
docker push ghcr.io/your-username/sail-proxy-admin:1.0.0
docker push ghcr.io/your-username/sail-proxy-nginx:1.0.0
```

**Docker Hub:**
```bash
# Login to Docker Hub
docker login

# Build and push (replace your-org with your Docker Hub username/organization)
docker build -t docker.io/your-org/sail-proxy-gateway:1.0.0 -f docker/gateway.Dockerfile .
docker build -t docker.io/your-org/sail-proxy-admin:1.0.0 -f docker/admin.Dockerfile .

# Build nginx (setup-kyma.js runs docker setup automatically)
docker build -t docker.io/your-org/sail-proxy-nginx:1.0.0 -f docker/nginx/Dockerfile docker

docker push docker.io/your-org/sail-proxy-gateway:1.0.0
docker push docker.io/your-org/sail-proxy-admin:1.0.0
docker push docker.io/your-org/sail-proxy-nginx:1.0.0
```

**Note**: The setup script will generate the exact commands for your chosen registry.

#### Registry Authentication

**GitHub Container Registry:**
- Create a Personal Access Token with `write:packages` permission
- Public repositories: No image pull secrets needed
- Private repositories: Setup script will create image pull secret template

**Docker Hub:**
- Public repositories: No authentication required for pulling
- Private repositories: Setup script will create image pull secret template

**Private registries (ACR, etc.):**
- Always require authentication
- Setup script will create image pull secret template with instructions

**Image Tagging Best Practices:**
- Use semantic versioning + commit SHA: `1.4.0-abc123`
- Deploy by digest for deterministic deployments
- Never use `latest` tag in production
- Pin specific versions in Kustomize overlays

### 2. Run Setup Script

```bash
# From kyma directory
cd kyma
node scripts/setup-kyma.js

# Or from project root
node kyma/scripts/setup-kyma.js

# For automated/CI deployments
node scripts/setup-kyma.js --ci
```

The setup script will:
- Guide you through deployment configuration
- Collect authentication provider settings
- Configure public vs internal-only deployment
- Generate Kubernetes manifests and ConfigMaps
- Create IP allowlisting policies in istio-system namespace (if applicable)
- Run docker/setup-docker.js in CI mode to prepare nginx build

### 3. Deploy to Kyma

**Deployment Order (Dependencies Matter):**

```bash
# 1. Create namespace with Istio injection
kubectl apply -f manifests/core/namespace.yaml
kubectl label namespace sail-proxy istio-injection=enabled

# 2. Apply secrets and configurations
kubectl apply -f templates/secrets/
kubectl apply -f templates/configmaps/

# 3. Deploy data stores (wait for readiness)
kubectl apply -f manifests/core/postgres.yaml
kubectl apply -f manifests/core/valkey.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n sail-proxy --timeout=300s

# 4. Run database migrations (if needed)
# kubectl apply -f manifests/jobs/db-migration.yaml
# kubectl wait --for=condition=complete job/db-migration -n sail-proxy --timeout=300s

# 5. Deploy authentication services
kubectl apply -f manifests/auth/

# 6. Deploy application services
kubectl apply -f manifests/core/gateway.yaml
kubectl apply -f manifests/core/admin.yaml
kubectl apply -f manifests/core/nginx.yaml

# 7. Apply networking (only for public deployment)
kubectl apply -f manifests/networking/

# 8. Apply IP allowlist policies if configured
if [ -d "manifests/istio-system" ]; then
  kubectl apply -f manifests/istio-system/
fi

# Or use server-side apply for better conflict resolution:
kubectl apply -f manifests/ --server-side --wait
```

### 4. Environment-Specific Deployment (Recommended)

Use Kustomize overlays for different environments:

```bash
# Development deployment
kubectl apply -k kyma/overlays/dev

# Production deployment  
kubectl apply -k kyma/overlays/prod

# Or use base configuration
kubectl apply -k kyma/
```

### 5. Verify Deployment

```bash
# Check pod status
kubectl -n sail-proxy get pods

# Check service status
kubectl -n sail-proxy get svc

# View logs
kubectl -n sail-proxy logs deployment/gateway
kubectl -n sail-proxy logs deployment/admin

# Check network policies
kubectl -n sail-proxy get networkpolicy

# Verify security context
kubectl -n sail-proxy get pods -o jsonpath='{.items[*].spec.securityContext}'
```

## Deployment Options

### Public HTTPS Deployment

For internet-accessible deployment with IP allowlisting:

1. **APIRule Configuration**: Exposes services via Kyma APIRule with TLS termination
2. **IP Allowlisting**: Configure allowed IP ranges via Istio AuthorizationPolicy in istio-system namespace
3. **Authentication**: Full authentication flow via Dex + OAuth2-Proxy
4. **Access**: `https://your-domain.kyma.ondemand.com/admin/`

**Security Features**:
- TLS termination at Istio ingress
- IP-based access control at ingress level
- Authentication at application level
- Secrets stored in Kubernetes Secrets

### Internal-Only Deployment

For enterprise environments with SAP Cloud Connector:

1. **No APIRule**: Services remain internal to cluster
2. **Cloud Connector**: Service Channel tunnels traffic to cluster
3. **Access**: `http://localhost:22001/admin/` (via Cloud Connector)

**Service Channel Configuration**:
- **Target Service**: `nginx:8080`
- **Protocol**: HTTP
- **Local Port**: 22001 (or your choice)
- **Description**: SAP LLM Gateway

## Authentication Providers

### Local Development
- **Use case**: Development and testing only
- **Users**: Hardcoded test users (admin@example.com, user@example.com)
- **Password**: admin123 / user123
- **Security**: ⚠️ **Never use in production!**

### GitHub OAuth
- **Use case**: Teams using GitHub for authentication
- **Configuration**: GitHub OAuth App with organization/team restrictions
- **Callback URL**: `{BASE_URL}/oauth2/callback`
- **Required**: GitHub OAuth App Client ID/Secret, Organization name

### LDAP/Active Directory
- **Use case**: Enterprise environments with existing LDAP
- **Configuration**: External LDAP server connection
- **Features**: Group-based role mapping, secure LDAP binding
- **Required**: LDAP server details, bind credentials, search configuration

### Okta SAML
- **Use case**: Okta customers using SAML SSO
- **Configuration**: Okta SAML application
- **Features**: Automatic certificate fetching, group-based roles
- **Required**: Okta metadata URL, SSO URL, SAML certificate

## Security Considerations

### Secrets Management
- **Kubernetes Secrets**: All sensitive data stored as Secret objects
- **Environment Variables**: Non-sensitive config via ConfigMaps
- **Image Security**: No secrets baked into container images
- **File Permissions**: Secrets mounted read-only in containers

### Network Security
- **TLS**: End-to-end encryption for public deployments
- **IP Allowlisting**: Configurable IP-based access control
- **Service Mesh**: Istio provides additional network security
- **Internal Communication**: ClusterIP services for inter-service traffic

### Authentication Security
- **JWT Validation**: OAuth2-Proxy validates tokens from Dex
- **Session Management**: Secure session cookies with HttpOnly/Secure flags
- **Role-Based Access**: Group-based role mapping per provider
- **Token Security**: Shared validation tokens between services

## Troubleshooting

### Common Issues

**Pod not starting**:
```bash
kubectl -n sail-proxy describe pod <pod-name>
kubectl -n sail-proxy logs <pod-name>
```

**ImagePullBackOff errors**:
```bash
# Verify image pull secret exists
kubectl -n sail-proxy get secret <registry-secret>

# Check secret is linked to service account
kubectl -n sail-proxy get sa default -o yaml

# Test registry connectivity
kubectl -n sail-proxy run test-pull --image=<your-image> --rm -it --restart=Never -- echo "Pull successful"
```

**Service connectivity**:
```bash
# Test internal connectivity
kubectl -n sail-proxy exec deployment/gateway -- curl http://postgres:5432
kubectl -n sail-proxy exec deployment/gateway -- curl http://valkey:6379
```

**Authentication issues**:
```bash
# Check Dex logs
kubectl -n sail-proxy logs deployment/dex

# Check OAuth2-Proxy logs
kubectl -n sail-proxy logs deployment/oauth2-proxy

# Test Dex health
kubectl -n sail-proxy port-forward svc/dex 5556:5556
curl http://localhost:5556/dex/healthz

# Common auth loop fix: Ensure /oauth2/* and /dex/* are noAuth in APIRule
```

**APIRule issues**:
```bash
# Check APIRule status (should be "Ready")
kubectl -n sail-proxy get apirule -o wide

# Common issues:
# - Certificate not found: Check Issuer/ClusterIssuer exists
# - Gateway mismatch: Ensure Gateway matches APIRule spec
# - Host conflicts: Check for duplicate hosts across APIRules

# Check Istio Virtual Service creation
kubectl -n sail-proxy get virtualservice
```

**504 Gateway Timeout**:
```bash
# Check if long requests hit Istio/Envoy timeouts
# Nginx timeout is 15 minutes, ensure Istio matches:
kubectl -n istio-system get envoyfilter

# For requests > 15 min, may need custom EnvoyFilter
```

**In-cluster traffic blocked after APIRule v2**:
```bash
# APIRule v2 creates restrictive AuthorizationPolicy
# Add explicit ALLOW policy for internal traffic:
kubectl apply -f - <<EOF
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-internal-traffic
  namespace: sail-proxy
spec:
  selector:
    matchLabels:
      app: nginx
  action: ALLOW
  rules:
  - from:
    - source:
        namespaces: ["sail-proxy"]
EOF
```

**Public access issues**:
```bash
# Check APIRule status
kubectl -n sail-proxy get apirule

# Check Istio ingress
kubectl -n istio-system get svc istio-ingressgateway

# Check IP allowlisting
kubectl -n istio-system get authorizationpolicy

# Test from allowed IP
curl -v https://your-domain.kyma.ondemand.com/health
```

### Configuration Updates

**Update ConfigMaps**:
```bash
# Edit ConfigMap
kubectl -n sail-proxy edit configmap nginx-conf

# Restart deployments to pick up changes
kubectl -n sail-proxy rollout restart deployment/nginx
```

**Update Secrets**:
```bash
# Update Secret
kubectl -n sail-proxy create secret generic gateway-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -

# Restart deployment
kubectl -n sail-proxy rollout restart deployment/gateway
```

**Scale Services**:
```bash
# Scale gateway for higher load
kubectl -n sail-proxy scale deployment/gateway --replicas=5

# Scale NGINX for HA
kubectl -n sail-proxy scale deployment/nginx --replicas=3
```

## Production Checklist

### Pre-Deployment Steps

#### SAP BTP Kyma Modules (Enable First)
- [ ] **istio**: Enable Service Mesh (required)
- [ ] **api-gateway**: Enable for APIRule and custom domain support
- [ ] **telemetry**: Enable for observability (logs/metrics/traces)
- [ ] **btp-operator**: Enable for SAP BTP service bindings (optional)

#### Container Registry Setup
- [ ] Create container registry (GitHub Container Registry recommended)
- [ ] Build and push all images with semantic version tags
- [ ] Create image pull secrets for private registries
- [ ] Verify registry connectivity from Kyma cluster

### Images and Registry
- [ ] **Image versions**: Use specific version tags, not `latest` (✅ Valkey now uses 7.2.4)
- [ ] **Registry**: Use GitHub Container Registry or private registry
- [ ] **Image pull secrets**: Configure for private registries (✅ Automated via setup script)
- [ ] **Security scanning**: Scan images for vulnerabilities before deployment

### Security Hardening (SAP + NSA/CISA Guidelines)
- [ ] **Pod Security Standards**: Restricted profile applied (✅ Included in prod overlay)
- [ ] **Non-root containers**: All containers run as non-root user (✅ UID 65534)
- [ ] **Read-only root filesystem**: Enabled with writable tmp/cache volumes (✅ Applied)
- [ ] **Dropped capabilities**: All unnecessary Linux capabilities dropped (✅ Applied)
- [ ] **Network policies**: Default-deny with explicit allowlists (✅ Implemented)
- [ ] **Secrets management**: Kubernetes Secrets with proper RBAC (✅ Applied)
- [ ] **IP allowlisting**: Istio AuthorizationPolicy deployed to istio-system namespace (✅ Automated)

### Resources and Performance
- [ ] **CPU/Memory limits**: Environment-appropriate resource allocation (✅ Dev/Prod overlays)
- [ ] **High availability**: Multi-replica deployments for production (✅ 3 gateway, 2 admin, 3 nginx)
- [ ] **Storage**: Configure appropriate PostgreSQL storage size (✅ 100Gi for prod)
- [ ] **Persistent volumes**: Use appropriate storage classes for your cluster

### Networking and Exposure
- [ ] **Custom Gateway**: Create TLS-enabled Gateway for production domains (✅ Example provided)
- [ ] **APIRule configuration**: Production APIRule with custom domain (✅ Template provided)
- [ ] **IP allowlisting**: Istio AuthorizationPolicy with approved CIDRs (✅ Automated in istio-system)
- [ ] **DNS**: Configure CNAME/A records pointing to cluster ingress
- [ ] **TLS certificates**: Use cert-manager for automatic certificate management
- [ ] **Timeout configuration**: Nginx configured for 15-minute timeouts (900s)
- [ ] **Istio timeout alignment**: Ensure Envoy timeouts match Nginx for long AI requests

### Database and Persistence
- [ ] **Managed database**: Consider SAP HANA Cloud or PostgreSQL Hyperscaler Option
- [ ] **Backup strategy**: Implement automated PostgreSQL backups (if self-managed)
- [ ] **High availability**: Configure PostgreSQL clustering if required
- [ ] **Connection pooling**: Optimize database connections for scale

### Monitoring and Observability
- [ ] **Kyma Telemetry**: Enable Prometheus/Grafana dashboards
- [ ] **SAP Cloud Logging**: Wire logs to centralized SAP observability (optional)
- [ ] **Alert Notification**: Configure SAP Alert Notification for critical events
- [ ] **Application monitoring**: Set up health checks and performance monitoring

### CI/CD and Deployment
- [ ] **Kustomize overlays**: Use environment-specific configurations (✅ Dev/Staging/Prod)
- [ ] **CI/CD pipeline**: Implement GitHub Actions or SAP CICD (✅ Examples provided)
- [ ] **Semver tagging**: Use semantic versioning for releases
- [ ] **Zero-downtime deployments**: Rolling updates with readiness/liveness probes

### Operations and Maintenance  
- [ ] **RBAC**: Implement least-privilege access controls
- [ ] **Secret rotation**: Regular rotation of passwords, tokens, certificates
- [ ] **Update strategy**: Plan for Kubernetes and application updates
- [ ] **Disaster recovery**: Document and test recovery procedures
- [ ] **Capacity planning**: Monitor resource usage and plan for growth

## Deployment Commands Reference

### Quick Deployment (After Setup)

```bash
# Development environment
kubectl apply -k kyma/overlays/dev --server-side --wait

# Production environment  
kubectl apply -k kyma/overlays/prod --server-side --wait

# Check deployment status
kubectl -n sail-proxy get pods -w
kubectl -n sail-proxy get apirule
```

### Operational Commands

```bash
# View logs across all pods
kubectl -n sail-proxy logs -l app=gateway --tail=100 -f
kubectl -n sail-proxy logs -l app=admin --tail=100 -f

# Check resource usage
kubectl -n sail-proxy top pods
kubectl -n sail-proxy top nodes

# Export current configuration
kubectl -n sail-proxy get all,configmap,secret,apirule,networkpolicy -o yaml > backup.yaml

# Force restart all deployments
kubectl -n sail-proxy rollout restart deployment

# Check Istio sidecar injection
kubectl -n sail-proxy get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\n"}{end}'
```

### Emergency Procedures

```bash
# Rollback deployment
kubectl -n sail-proxy rollout undo deployment/gateway
kubectl -n sail-proxy rollout undo deployment/admin

# Scale down for maintenance
kubectl -n sail-proxy scale deployment --all --replicas=0

# Delete and recreate namespace (last resort)
kubectl delete namespace sail-proxy
kubectl apply -f manifests/core/namespace.yaml
```

## Support

For issues and questions:
- Check the main project documentation
- Review Kyma documentation for platform-specific issues
- Check logs using kubectl commands above
- Verify network connectivity and DNS resolution
- Reference the troubleshooting section for common issues

## SAP BTP Service Integration

### Using Managed Services (Optional)

Enable the **btp-operator** module to use SAP BTP managed services:

#### PostgreSQL Hyperscaler Option
```yaml
apiVersion: services.cloud.sap.com/v1
kind: ServiceInstance
metadata:
  name: postgres-instance
  namespace: sail-proxy
spec:
  serviceOfferingName: postgresql-db
  servicePlanName: development
---
apiVersion: services.cloud.sap.com/v1
kind: ServiceBinding  
metadata:
  name: postgres-binding
  namespace: sail-proxy
spec:
  serviceInstanceName: postgres-instance
```

Mount the binding secret in your deployments to access credentials.

#### SAP AI Core Integration
The gateway service automatically detects and parses SAP AI Core service keys when provided via environment variables or mounted secrets.

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Deploy to Kyma
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        
      - name: Configure Kubeconfig
        run: |
          echo "${{ secrets.KYMA_KUBECONFIG }}" | base64 -d > kubeconfig
          export KUBECONFIG=./kubeconfig
          
      - name: Build and Push Images
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker build -t ghcr.io/${{ github.repository }}/gateway:${{ github.sha }} -f docker/gateway.Dockerfile .
          docker push ghcr.io/${{ github.repository }}/gateway:${{ github.sha }}
          
      - name: Deploy with Kustomize
        run: |
          cd kyma/overlays/prod
          kustomize edit set image gateway=ghcr.io/${{ github.repository }}/gateway:${{ github.sha }}
          kubectl apply -k . --server-side --wait
          
      - name: Wait for Rollout
        run: |
          kubectl -n sail-proxy rollout status deployment/gateway --timeout=5m
```

### Zero-Downtime Deployment Strategy

1. **Use RollingUpdate** with proper surge/unavailable settings
2. **Configure PodDisruptionBudgets** to maintain availability
3. **Implement readiness/liveness probes** with appropriate thresholds
4. **Use preStop hooks** for graceful shutdown
5. **Consider canary deployments** with Istio traffic splitting

## Version Compatibility

- **Kyma**: 2.15+ recommended
- **Kubernetes**: 1.24+ required
- **Istio**: Included with Kyma
- **PostgreSQL**: 16+
- **Valkey/Redis**: 7.2.4+
- **Container Runtime**: containerd 1.6+