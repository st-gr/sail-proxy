---
title: SAIL-PROXY User Guide - Chapter 3
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-2-features.md) | [Content Table](README.md) | [Next Chapter >>](chapter-4-claude-code.md)

---

## Installation

Choose the installation method that best fits your needs:

### Local Standalone Installation (CLI)

The CLI tool is perfect for individual developers and local development environments.

#### Prerequisites
- **Node.js 20+** (required for native ESM support)
- **SAP BTP Service Key** for AI Core access

#### Installation Steps

1. **Install the CLI globally**:
```bash
npm install -g @st-gr/sail-proxy
```


2. **Run the setup**:
```bash
sail-proxy
```
_Note:_ After a fresh install sail-proxy will automatically execute the `sail-proxy configure` command.


3. **Configure your SAP AI Core connection**:
The CLI will prompt you to paste your SAP BTP service key. You can obtain this from:
- SAP BTP Cockpit → AI Core service instance → Service Keys


4. **start the service**
```bash
sail-proxy run
```


5. **Create your first API key**:
```bash
sail-proxy apikey create --name "my-development-key"
```


6. **Test the connection**:
```bash
curl -X GET http://localhost:3000/v1/models \
  -H "Authorization: Bearer your-generated-api-key"
```

#### CLI Management Commands

**Server Control**:
```bash
sail-proxy run          # Start the server
sail-proxy stop         # Stop the server
sail-proxy status       # Check server status
sail-proxy logs --follow # View logs in real-time
```

**API Key Management**:
```bash
sail-proxy apikey create --name "key-name"
sail-proxy apikey list
sail-proxy apikey revoke --id key-id
sail-proxy apikey set --key your-key  # Set active key
```

**Configuration**:
```bash
sail-proxy config show              # Show all configuration
sail-proxy config get PAYLOAD_LOGGING_ENABLED     # Get specific value
sail-proxy config set PAYLOAD_LOGGING_ENABLED true # Set value
sail-proxy config reset             # Reset to defaults
```

**Models**:
```bash
sail-proxy models list  # List available models
```

#### Optional: Ollama Service
For Ollama compatibility, you can also start the Ollama service:
```bash
sail-proxy ollama start  # Starts on port 11434
sail-proxy ollama status
sail-proxy ollama stop
```

### Docker Compose Installation

The Docker setup is ideal for production deployments, team environments, and when you need the Admin Cockpit.

#### Prerequisites
- **nodejs** 20+
- **git*
- **Docker & Docker Compose**
- **SAP BTP Service Key** for AI Core access
- **OAuth2 Provider** (GitHub, Okta, LDAP, etc.) for enterprise authentication

#### Quick Start

1. **Clone or download the repo that includes the Docker configuration**:
```bash
git clone https://github.com/st-gr/sail-proxy.git
cd sail-proxy
cd docker/
```

2. **Run the interactive setup**:
```bash
node setup-docker.js
```

The setup script will guide you through:
- SAP AI Core service key configuration
- OAuth2 authentication setup (GitHub, Okta, or LDAP)
- set alternate hostname

3. **Start the services**:
```bash
docker-compose up -d
```

4. **Access the services**:
- **Gateway**: http://localhost:8080/gateway/ (or your configured domain)
- **Admin Cockpit**: http://localhost:8080/admin/app/shell/ (requires login)

#### Docker Services

The Docker deployment includes:

**Core Services**:
- **Gateway** (port 3000): Main API gateway
- **Admin** (port 4004): Admin cockpit and management API
- **PostgreSQL** (port 5432): Database for Admin service
- **Valkey/Redis** (port 6379): Caching and pub/sub

**Authentication Stack**:
- **OAuth2-proxy**: Handles authentication and session management
- **Dex**: Identity provider connector for GitHub/Okta/LDAP
- **Nginx**: Reverse proxy with SSL termination

#### Configuration Files

After setup, you'll have:
```
docker/
├── docker-compose.yml          # Service definitions
├── .env                       # Environment variables
├── configs/
│   ├── shared
│       ├── njs
│           ├── jwt.js
│       ├── nginx.conf
│       ├── .env.postgres
│   ├── providers
│       ├── okta
│       ├── local
│       ├── ldap
│       ├── github
│           ├── SETUP.md      # How to use GitHub as IdP
│           ├── dex.config.yaml
│   ├── dex.yaml              # Dex identity configuration
│   ├── .env.okta             # for Okta as IdP
│   ├── .env.local            # for local test deployment
│   ├── .env.ldap             # for LDAP
│   ├── .env.github           # for GitHub as IdP
│   ├── oauth2-proxy.cfg       # OAuth2 proxy configuration
│   └── nginx.conf            # Nginx reverse proxy config
├── nginx/                      # Nginx reverse proxy config
└── postgres-init/            # Database initialization scripts
```

#### Environment Variables

You can keep the defaults. Below for completeness.
Key configuration options in `.env`:
```bash
# SAP AI Core Configuration
OAUTH_URL=https://your-ai-core-url/oauth/token
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret

# Security Keys (generated automatically, rotate)
VALIDATION_TOKEN_SECRET=your-256-bit-secret
METADATA_ENCRYPTION_KEY=your-256-bit-key
AWS_SECRET_ENCRYPTION_KEY=your-256-bit-key

# Database Configuration
POSTGRES_PASSWORD=generated-password
VALKEY_PASSWORD=generated-password

# OAuth2 Authentication
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_ORG=your-github-organization  # Optional: restrict to org members
```

#### Admin User Setup

After initial deployment:

1. **Log in through OAuth2** (GitHub/Okta/LDAP)
2. **User of admin group** is admin
3. **Create additional users** through the Admin Cockpit

#### Docker Management Commands

**Service Control**:
```bash
docker-compose up -d          # Start all services
docker-compose down           # Stop all services
docker-compose restart gateway # Restart specific service
docker-compose logs -f gateway # View logs
```

**Database Management**:
```bash
# Reset database (WARNING: destroys all data)
docker-compose down
docker volume rm docker_postgres_data
docker-compose up -d
```

**Image Updates**:
```bash
# Pull latest images
docker-compose pull

# Rebuild with latest changes
docker-compose build --no-cache
docker-compose up -d
```

### SAP BTP Kyma Runtime Installation

The Kyma deployment is ideal for enterprise SAP environments, providing enterprise-grade scalability, security, and integration with SAP BTP services.

#### Prerequisites

- **SAP BTP Kyma Runtime Access**: You need access to a SAP BTP Kyma cluster
- **kubectl**: Configured to access your Kyma cluster  
  > 📋 **Need help with kubectl setup?** Take a look at [Prerequisites Guide](../../kyma/docs/PREREQUISITES.md) for step-by-step instructions to install kubectl, krew, and oidc-login on macOS, Linux, and Windows.
- **Container Registry**: Access to a container registry (GHCR, Docker Hub, Harbor, etc.)
- **SAP AI Core Service Key**: For backend AI provider integration

#### Quick Start

1. **Navigate to the Kyma directory**:
```bash
git clone https://github.com/st-gr/sail-proxy.git
cd sail-proxy
cd kyma/
```

2. **Run the automated setup and deployment**:
```bash
node kyma/scripts/setup-kyma.js
```

The setup script will guide you through:
- Interactive manifest generation and configuration
- SAP AI Core service key setup (reuses existing configuration if found)
- Authentication provider setup (GitHub, Okta, or Local Users)
- Container registry configuration for docker images
- Automated Kubernetes deployment with dependency management
- Health verification and troubleshooting

3. **Access the services**:
- **Gateway**: `https://your-subdomain.your-cluster-id.kyma.ondemand.com/`
- **Admin Cockpit**: `https://your-subdomain.your-cluster-id.kyma.ondemand.com/admin/app/shell/`

#### Kyma Architecture

The Kyma deployment uses a **"Mesh at the Edge"** pattern with Istio service mesh:

**Edge Services** (with Istio sidecars for external access):
- **Nginx**: Reverse proxy with APIRule integration
- **OAuth2-proxy**: Authentication proxy
- **Dex**: OIDC identity provider

**Backend Services** (optimized without sidecars):
- **Gateway**: Main API gateway service
- **Admin**: Admin cockpit and management API
- **PostgreSQL**: Database for Admin service
- **Valkey**: Redis-compatible caching

#### Configuration Options

The setup process will prompt for:

- **Deployment Type**: Choose "Public HTTPS (APIRule)" for external access
- **Authentication Provider**: GitHub, Okta, or Local Users
- **Cluster Configuration**: Your cluster subdomain and desired hostname
- **Container Registry**: Registry URL, organization, and image tags
- **SAP AI Core Integration**: Service key configuration (auto-detected if available)

#### Kyma Management Commands

**Deployment Control**:
```bash
# Full deployment (recommended)
node kyma/scripts/deploy-kyma.js

# Manual manifest generation only
node kyma/scripts/setup-kyma.js

# Check deployment status
kubectl get pods -n sail-proxy
kubectl get apirule -n sail-proxy
```

**Service Logs**:
```bash
kubectl logs -f deployment/gateway -n sail-proxy
kubectl logs -f deployment/admin -n sail-proxy
kubectl logs -f deployment/nginx -n sail-proxy
```

**Database Management**:

SAIL-PROXY includes a comprehensive database migration tool (`kyma-db-manager.js`) for PostgreSQL backup, restore, and management operations in Kyma deployments.

```bash
# Get database information and statistics
node cli-tools/kyma-db-manager.js info --namespace sail-proxy

# Create a backup
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/backup-$(date +%Y%m%d).sql

# Restore from backup (with safety features)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup-20260113.sql \
  --data-only \
  --truncate-first

# Reset database - delete all data (preserves schema)
node cli-tools/kyma-db-manager.js reset \
  --namespace sail-proxy \
  --pause-deployments
```

**Database Migration Tool Features**:
- ✅ **Automatic credential retrieval** from Kubernetes secrets
- ✅ **Safety backup** before restore operations (optional)
- ✅ **Data-only restore** preserves schema during upgrades
- ✅ **Truncate-first mode** prevents duplicate key conflicts
- ✅ **Reset command** for clearing all data without restore
- ✅ **Deployment pause** option for zero-downtime operations
- ✅ **Dry-run mode** for testing operations
- ✅ **Cross-platform compression** using tar.gz (Windows 10+, Linux, macOS)
- ✅ **Automatic extraction** of compressed backups during restore

See [Database Migration Guide](#database-migration-for-kyma-deployments) below for detailed usage.

#### Kubernetes/Kyma-Specific Features

- **Enterprise Authentication**: Integrated with SAP BTP identity providers
- **Scalability**: Horizontal pod autoscaling based on load
- **Monitoring**: Built-in observability via Kyma dashboard and Grafana
- **Security**: Network policies and Istio mTLS for service-to-service communication
- **SAP Integration**: Native integration with SAP BTP services and connectivity

#### Important: Hostname Requirements for Kyma API Clients

**⚠️ Critical for API Integration**: Kyma deployments use Istio service mesh with strict hostname validation for security. API clients **must** use the correct hostname when making requests.

**✅ Correct Usage**:
```bash
# Use the actual Kyma domain - no custom Host headers needed
curl -X POST 'https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic/v1/messages' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{"model": "claude-3-5-sonnet", "messages": [{"role": "user", "content": "Hello"}]}'
```

**❌ Common Mistakes That Cause ECONNRESET Errors**:
```bash
# DO NOT use custom host headers like localhost
curl --header 'host: localhost' 'https://your-kyma-domain.com/...'  # ❌ Will fail

# DO NOT use localhost URLs for Kyma deployments  
curl 'http://localhost:3000/...'  # ❌ Wrong for Kyma

# DO NOT use connection: Close header (causes PowerShell issues)
curl --header 'connection: Close' 'https://your-kyma-domain.com/...'  # ❌ May fail
```

**Why This Matters**:
- Istio Gateway validates the `Host` header at the ingress level
- Mismatched hostnames cause TCP connection resets (ECONNRESET) before reaching the application
- This is a security feature to prevent host header injection attacks
- Only explicitly configured hostnames are accepted by the Kyma APIRule

### Database Migration for Kyma Deployments

The `kyma-db-manager.js` tool provides safe and efficient database operations for PostgreSQL instances running in Kyma environments. This tool is essential for backup/restore operations, schema upgrades, and database maintenance.

#### Prerequisites

- **kubectl**: Configured and connected to your Kyma cluster
- **Node.js**: Version 20+ installed
- **Cluster Access**: Permissions to access the `sail-proxy` namespace
- **PostgreSQL Pod**: Running postgres-0 pod in the namespace

#### Tool Location

The database migration tool is located at:
```bash
cli-tools/kyma-db-manager.js
```

#### Available Commands

**1. Info Command** - View database statistics and table information

```bash
node cli-tools/kyma-db-manager.js info --namespace sail-proxy
```

**Output includes**:
- Database connection details
- List of all tables (28 tables in standard deployment)
- Row counts for key tables (API Keys, Usage, Model Costs, etc.)
- Total database size

**Example output**:
```
=== Database Information ===
Namespace: sail-proxy
Database: sap_llm_gateway
User: admin_user
Pod: postgres-0

=== Tables ===
28 tables listed...

=== Row Counts (Key Tables) ===
ApiKeys             : 2 rows
ApiKeyUsage         : 14469 rows
ModelCosts          : 41 rows
AwsCredentials      : 1 rows
UserPreferences     : 1 rows

Total Database Size: 5.2 MB
```

**2. Backup Command** - Create database backups

```bash
# Full backup (schema + data)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/backup-$(date +%Y%m%d-%H%M%S).sql

# Data-only backup (for migrations)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/data-only.sql \
  --data-only

# Compressed backup
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/backup.sql \
  --compress

# Exclude specific tables
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/backup-no-usage.sql \
  --exclude-table ApiKeyUsage,AwsCredentialUsage
```

**Backup Options**:
- `--output` / `-o`: Output file path (default: `backup-YYYY-MM-DD.sql`)
- `--data-only`: Backup only data (no schema) - useful for migrations
- `--schema-only`: Backup only schema (no data) - useful for structure verification
- `--exclude-table <tables>`: Comma-separated list of tables to exclude
- `--compress`: Enable tar.gz compression (creates `.sql.tar.gz` file) - **cross-platform compatible** (Windows 10+, Linux, macOS)

**3. Restore Command** - Restore database from backup

```bash
# Full restore (with automatic safety backup)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup-20260113-120000.sql

# Data-only restore with truncate (recommended for schema upgrades)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup.sql \
  --data-only \
  --truncate-first

# Dry-run (test without making changes)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup.sql \
  --data-only \
  --dry-run

# Restore without automatic safety backup (faster, less safe)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup.sql \
  --no-auto-backup
```

**Restore Options**:
- `--input` / `-i`: Input backup file path (required)
- `--data-only`: Restore only data (preserves existing schema)
- `--truncate-first`: Truncate all tables before restore (prevents duplicate key conflicts) ⭐
- `--include-cds-model`: Include the `cds_model` table in a `--data-only` restore (NOT recommended — see the cds_model note below)
- `--skip-api-config`: Skip the API configurations table, preserving the currently deployed `api_config.json` state
- `--no-auto-backup`: Disable automatic safety backup (a safety backup is created by default)
- `--dry-run`: Show what would be restored without executing

> Note: any `DROP`/`CREATE` statements executed during a full restore come from the
> backup file itself (full backups are generated with `pg_dump --clean --if-exists`),
> not from restore-side flags.

**Automatic `cds_model` protection (important for upgrades)**: the `cds_model` table
holds CAP's schema metadata for the *currently deployed* code version — it is written by
`cds-deploy` when the admin pod starts. A `--data-only` restore automatically **excludes
`cds_model`** from both the truncate step and the restored data, so the freshly deployed
version's schema metadata is preserved and old metadata from the backup cannot overwrite
it. Override with `--include-cds-model` only when restoring into the *same* code version
the backup was taken from.

**⚠️ Use a `--data-only` backup as the restore input for upgrades**: restoring a *full*
backup with `restore --data-only` still replays the DDL (`DROP`/`CREATE`) contained in
that dump, replacing the freshly deployed schema with the old one. For the upgrade
workflow below, take the backup with `backup --data-only` (keep a separate full backup
as disaster insurance only).

**4. Reset Command** - Delete all data (truncate tables without restore)

```bash
# Basic reset (fast, no deployment pause)
node cli-tools/kyma-db-manager.js reset --namespace sail-proxy

# Production-safe reset (with deployment pause)
node cli-tools/kyma-db-manager.js reset --namespace sail-proxy --pause-deployments
```

**When to use reset**:
- Clear all data while preserving schema (empty tables)
- Development/testing: Reset to clean state
- Before manual data import
- Faster than restore with `--truncate-first` when you don't need to restore data

**Reset Options**:
- `--namespace` / `-n`: Kubernetes namespace (required)
- `--pause-deployments`: Pause gateway and admin deployments during reset (recommended for production)

**⚠️ Warning**: Reset is a destructive operation that deletes ALL data from ALL tables. The schema (table structure) is preserved, but all rows are permanently deleted. Always create a backup before running reset.

#### Common Use Cases

**Use Case 1: Regular Database Backup**

```bash
# Create timestamped backup
mkdir -p backups
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output "backups/backup-$(date +%Y%m%d-%H%M%S).sql"

# Verify backup was created
ls -lh backups/
```

**Use Case 2: Schema Upgrade Migration**

This is the recommended workflow when upgrading to a new version with schema changes:

```bash
# Step 0: Record a baseline for later verification (table list + row counts)
node cli-tools/kyma-db-manager.js info --namespace sail-proxy

# Step 1: Backup current DATA before upgrade (this is the restore artifact —
# a data-only dump carries no DDL, so it cannot overwrite the new schema)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --data-only \
  --output backups/pre-upgrade-data.sql

# Step 1b: Also take a FULL backup as disaster insurance (schema + data;
# only for rolling back to the OLD version — never restore it after upgrading)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/pre-upgrade-full.sql

# Step 2: Store backups safely
cp backups/pre-upgrade-*.sql /safe/location/

# Step 3: Deploy new version with schema changes
kubectl apply -f kyma/templates/manifests/

# Step 4: Wait for admin pod to complete schema migration
# (its startup runs `cds-deploy --profile pg`, creating the new schema and cds_model)
kubectl wait --for=condition=ready pod -l app=admin -n sail-proxy --timeout=300s

# Step 5: Restore data with truncate-first and pause deployments for safety
# (cds_model is automatically preserved — see note above)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/pre-upgrade-data.sql \
  --data-only \
  --truncate-first \
  --pause-deployments

# Step 6: Verify restoration — row counts should match the Step-0 baseline
node cli-tools/kyma-db-manager.js info --namespace sail-proxy
```

**Why use `--truncate-first`?**
- Removes old data while preserving the new schema
- Prevents primary key conflicts during restore
- Safe for additive schema changes (new columns, indexes)
- Faster than full `--clean` restore

**Why use `--pause-deployments`?**
- Ensures no database writes occur during restore
- Prevents data inconsistency and conflicts
- Automatically scales gateway/admin to 0 replicas
- Restores original replica counts after completion
- **Recommended for all production restore operations**

⚠️ **Important**: When using `--pause-deployments`:
- **Gateway API will be unavailable** during the operation (downtime expected)
- **Admin Cockpit will be unavailable** during the operation
- All active API requests will be terminated when pods are scaled to 0
- Plan for maintenance window during off-peak hours
- Typical downtime: 2-5 minutes depending on database size
- Deployments automatically resume after operation completes

**Use Case 3: Clone Database Between Environments**

```bash
# Backup from production
kubectl config use-context production-cluster
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output prod-backup.sql

# Restore to staging (with data-only to preserve staging schema)
kubectl config use-context staging-cluster
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input prod-backup.sql \
  --data-only \
  --truncate-first
```

**Use Case 4: Disaster Recovery**

```bash
# Full restore from backup
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup-20260113-120000.sql

# The restore will:
# 1. Prompt for automatic safety backup
# 2. Drop and recreate all database objects
# 3. Restore all data
# 4. Verify restoration
```

#### Understanding Restore Modes

**Full Restore** (no `--data-only` flag, input is a *full* backup):
- Drops all tables (via the `DROP TABLE IF EXISTS` statements that full backups
  contain — `pg_dump` runs with `--clean --if-exists` at backup time)
- Recreates tables from backup schema
- Inserts all data
- ⚠️ **Warning**: Overwrites any schema changes made after backup — including a
  newly deployed version's schema. Only use to roll back to the backup's version.

**Data-Only Restore** (`--data-only` flag, input is a *data-only* backup):
- Preserves existing schema
- Only replays data (`COPY` blocks); `cds_model` is automatically excluded
- ❌ **Fails** if data already exists (duplicate primary keys)
- ✅ Use with `--truncate-first` to avoid conflicts
- ⚠️ The `--data-only` flag does **not** strip DDL from a *full* backup file —
  pair it with a backup taken via `backup --data-only`

**Data-Only with Truncate** (`--data-only --truncate-first`):
- Truncates all tables (removes data, keeps schema; `cds_model` excluded)
- Then inserts backup data
- ✅ **Perfect** for schema upgrades with new columns
- ✅ No duplicate key conflicts

#### Safety Features

**1. Automatic Safety Backup**

Before any restore operation, the tool offers to create an automatic safety backup:

```
Create automatic safety backup before restore? (yes/no):
```

This backup is stored as `safety-backup-TIMESTAMP.sql` in the same directory as the input file.

**2. Confirmation Prompts**

Destructive operations require explicit confirmation:

```
⚠️  TRUNCATE MODE: All existing data will be removed before restore
Truncate all tables before restoring? This will delete all existing data. (yes/no):
```

**3. Dry-Run Mode**

Test restore operations without making changes:

```bash
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backup.sql \
  --data-only \
  --truncate-first \
  --dry-run
```

Output shows what would be executed:
```
[DRY RUN] Would execute the following operations:
  - Truncate all tables in database: sap_llm_gateway
  - Read SQL from: /path/to/backup.sql
  - Restore to database: sap_llm_gateway
  - Options: dataOnly=true, clean=false, noOwner=undefined, truncateFirst=true
[DRY RUN] No changes made
```

**4. Credential Security**

- Credentials are automatically retrieved from Kubernetes secrets
- Passwords are never logged or displayed
- Uses environment variables for PostgreSQL authentication
- No credentials stored in backup files

#### Troubleshooting

**Error: "Pod postgres-0 is not running"**

```bash
# Check pod status
kubectl get pods -n sail-proxy | grep postgres

# View pod logs
kubectl logs -n sail-proxy postgres-0

# Restart PostgreSQL if needed
kubectl rollout restart statefulset/postgres -n sail-proxy
```

**Error: "Failed to retrieve credentials"**

```bash
# Verify secret exists
kubectl get secret postgres-env -n sail-proxy

# Check secret contents
kubectl describe secret postgres-env -n sail-proxy

# Verify kubectl access
kubectl auth can-i get secrets -n sail-proxy
```

**Error: "duplicate key value violates unique constraint"**

This means you're trying to restore data that already exists. Solutions:

```bash
# Option 1: Use truncate-first to remove existing data
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backup.sql \
  --data-only \
  --truncate-first

# Option 2: Use full restore (drops and recreates tables)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backup.sql
  # No --data-only flag
```

**Large Database Backup Takes Too Long**

```bash
# Exclude high-volume tables
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backup-without-usage.sql \
  --exclude-table ApiKeyUsage,AwsCredentialUsage

# Or use compression
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backup.sql \
  --compress
```

#### Best Practices

1. **Regular Backups**: Schedule daily backups of your production database
   ```bash
   # Add to cron or CI/CD pipeline
   0 2 * * * node cli-tools/kyma-db-manager.js backup --namespace sail-proxy --output /backups/daily-$(date +\%Y\%m\%d).sql
   ```

2. **Pre-Upgrade Backups**: Always backup before applying schema changes

3. **Test Restores**: Periodically test your backups on staging environments

4. **Secure Storage**: Store backups in secure, encrypted locations

5. **Retention Policy**: Implement backup rotation (e.g., keep daily for 7 days, weekly for 4 weeks, monthly for 12 months)

6. **Use Dry-Run**: Test restore operations with `--dry-run` before production restores

7. **Monitor Backup Size**: Track backup file sizes to detect data growth issues

#### Manual Alternative

If the automated tool is unavailable, you can use kubectl directly:

```bash
# Get credentials
POSTGRES_USER=$(kubectl -n sail-proxy get secret postgres-env -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
POSTGRES_PASSWORD=$(kubectl -n sail-proxy get secret postgres-env -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

# Manual backup
kubectl -n sail-proxy exec -i postgres-0 -- \
  env PGPASSWORD=${POSTGRES_PASSWORD} \
  pg_dump -U ${POSTGRES_USER} -d sap_llm_gateway --clean --if-exists \
  > backup-$(date +%Y%m%d-%H%M%S).sql

# Manual restore
kubectl -n sail-proxy exec -i postgres-0 -- \
  env PGPASSWORD=${POSTGRES_PASSWORD} \
  psql -U ${POSTGRES_USER} -d sap_llm_gateway \
  < backup-20260113-120000.sql
```

### Installation Verification

#### Test API Connectivity

**For Docker Deployments**:

**Test model listing**:
```bash
curl -X GET http://localhost:3000/v1/models \
  -H "Authorization: Bearer your-api-key"
```

**Test chat completion**:
```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-nano",
    "messages": [{"role": "user", "content": "Hello from SAIL-PROXY!"}]
  }'
```

**For Kyma Deployments**:

**Test model listing**:
```bash
curl -X GET https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/v1/models \
  -H "x-api-key: your-api-key"
```

**Test chat completion**:
```bash
curl -X POST https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/openai/v1/chat/completions \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-nano",
    "messages": [{"role": "user", "content": "Hello from SAIL-PROXY!"}]
  }'
```

**Note**: Replace `your-subdomain.your-cluster-id.kyma.ondemand.com` with your actual Kyma domain from the deployment output.

#### Test Admin Cockpit (Docker and Kyma)

**Docker deployment**:
1. Navigate to `http://localhost:8080/admin/app/shell` (or your configured domain)
2. Log in through your OAuth2 provider
3. Access the Admin Cockpit dashboard
4. Create API keys and configure settings

**Kyma deployment**:
1. Navigate to `https://your-subdomain.your-cluster-id.kyma.ondemand.com/admin/app/shell/`
2. Log in through your configured authentication provider (GitHub/Okta/Local)
3. Access the Admin Cockpit dashboard
4. Create API keys and configure SAP AI Core settings

#### Common Issues

**CLI Installation**:
- **Node.js version**: Ensure Node.js 20+ is installed use nvm
- **Network access**: Verify SAP AI Core endpoints are accessible
- **Service key format**: Ensure the SAP AI Core service key JSON is valid

**Docker Installation**:
- **Port conflicts**: Ensure ports 8080, 3000, 4004, 5432, 6379 are available (you can change the port assignments in docker/docker-compose.yml)
- **OAuth2 setup**: Verify OAuth2 provider configuration
- **SSL certificates**: Check certificate files and domain configuration, if manually configured in Nginx

**Kyma Installation**:
- **kubectl access**: Verify you can access your Kyma cluster with `kubectl get nodes`
- **Container registry**: Ensure you have push access to your configured registry
- **APIRule status**: Check `kubectl get apirule -n sail-proxy` for external access issues
- **Pod status**: Verify all pods are running with `kubectl get pods -n sail-proxy`
- **Authentication flow**: Check OAuth2 provider organization access permissions
- **Istio mesh**: Ensure edge services show 2/2 containers (app + sidecar)

**Network Configuration**:
- **Firewall**: Ensure required ports are open
- **Proxy settings**: Configure corporate proxy if needed
- **DNS resolution**: Verify domain names resolve correctly
- **Kyma external access**: Verify your cluster's external URL is accessible

---

*Ready to integrate with your AI tools? Continue to [Claude Code integration](chapter-4-claude-code.md).*