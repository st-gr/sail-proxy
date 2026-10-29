---
title: Database migration
description: Backing up, restoring, resetting and inspecting the PostgreSQL database of a Kyma deployment with kyma-db-manager.js, including the upgrade workflow.
---

# Database migration

`cli-tools/kyma-db-manager.js` backs up, restores, resets and inspects the PostgreSQL database of a Kyma deployment. It runs on your machine and works through `kubectl exec` on the `postgres-0` pod, so the database never needs to be reachable from outside the cluster. Use it for regular backups, for upgrades that change the schema, and for copying data between namespaces or clusters.

For Docker and the standalone CLI, see [Backup, restore and upgrade](/deploy/backup-and-upgrade).

## Prerequisites

- `kubectl` configured for the Kyma cluster (see [Kyma prerequisites](/deploy/kyma-prerequisites)), with access to the namespace's pods and Secrets.
- Node.js 20 or later and a checkout of the repository with its dependencies installed (`pnpm install`).
- The `postgres-0` pod running in the namespace.

The tool reads the database user, password and name from the namespace's `postgres-env` Secret. It never prints the password and masks it in error messages.

## Commands

```
node cli-tools/kyma-db-manager.js <command> --namespace <namespace> [options]
```

Every command needs `--namespace` (`-n`). `backup`, `restore` and `reset` ask before they change anything; `-y` (`--yes`) answers every question with yes, for unattended runs.

### info

```bash
node cli-tools/kyma-db-manager.js info --namespace sail-proxy
```

Shows the database, user and pod, the list of tables, the row counts of the key tables (API keys, key usage, model costs, AWS credentials, user preferences) and the database size. It also reports the pgvector extension in two parts: *available* (the server ships it) and *installed* (this database has it). Available but not installed resolves itself at the gateway's next start; not available needs the `pgvector/pgvector` PostgreSQL image and cannot be fixed from the command line. It counts the file search files whose content lives in S3 and warns when there are any.

### backup

```bash
# Full backup (schema and data)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output backups/backup-$(date +%Y%m%d-%H%M%S).sql

# Data-only backup: the input for an upgrade restore
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --data-only \
  --output backups/data-only.sql

# Compressed backup (writes backups/backup.sql.tar.gz)
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --compress \
  --output backups/backup.sql

# Without the usage history
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --exclude-table sap_llm_gateway_admin_apikeyusage,sap_llm_gateway_admin_awscredentialusage \
  --output backups/backup-no-usage.sql
```

| Option | Meaning |
|---|---|
| `-o`, `--output <file>` | Output file (default `backup-YYYY-MM-DD.sql`) |
| `--data-only` | Data only, no schema |
| `--schema-only` | Schema only, no data |
| `--exclude-table <tables>` | Comma-separated PostgreSQL table names to leave out |
| `--exclude-blobs` | Leave out the stored file contents (see below) |
| `--compress` | Compress to `<file>.tar.gz` with `tar` (available on Windows 10 and later, Linux and macOS) |
| `--pause-deployments` | Scale the gateway and admin to zero during the backup |

A full backup is written with `pg_dump --clean --if-exists`, so it contains the statements that drop and recreate every object.

`backup` counts the file search files whose content lives in S3 and warns that the backup does not contain it: **files stored in S3 are not in a database backup**, and the bucket needs its own backup (see [File storage for file_search](/deploy/file-storage#backups)).

::: warning `--exclude-blobs` does not produce an equivalent backup
It leaves out the *data* of `file_blobs` (the stored file contents, which roughly double the backup size) and of `fs_upload_parts` (the parts of uploads still in progress through the Uploads API), while keeping the tables and their constraints, so the dump still restores cleanly. What comes back is the file metadata and the embeddings, so search keeps working, but the original bytes are gone: `GET /v1/files/{id}/content` fails for every file in the backup, and uploads that were in progress cannot be completed; start them again. Use it for routine snapshots, not as your only copy. It matters only with `capabilities.file_search.blob_storage.backend` `"db"`; with `"s3"` the bytes were never in PostgreSQL.
:::

### restore

```bash
# Full restore (offers a safety backup first)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/backup-20260113-120000.sql

# Data-only restore into a freshly deployed schema (the upgrade case)
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/data-only.sql \
  --data-only \
  --truncate-first

# Show what would happen, change nothing
node cli-tools/kyma-db-manager.js restore \
  --namespace sail-proxy \
  --input backups/data-only.sql \
  --data-only \
  --dry-run
```

| Option | Meaning |
|---|---|
| `-i`, `--input <file>` | Backup file to restore (required); a `.tar.gz` file is unpacked first |
| `--data-only` | Restore data into the existing schema |
| `--truncate-first` | Empty every table before the restore, keeping the schema; avoids duplicate key conflicts |
| `--include-cds-model` | Also restore the `cds_model` table in a `--data-only` restore (not recommended, see below) |
| `--skip-api-config` | Leave out the gateway configurations table, keeping the configuration the deployment has now |
| `--no-auto-backup` | Do not create the safety backup |
| `--pause-deployments` | Scale the gateway and admin to zero during the restore (recommended) |
| `--dry-run` | Print what would be done, change nothing |

Before it restores, `restore` runs `CREATE EXTENSION IF NOT EXISTS vector` on the target database: a `--data-only` dump does not create the extension, and without it any dump with file search tables fails to load. If the extension cannot be created (the role lacks the right, or the server has no pgvector), it warns and continues, so a database without vector columns still restores. It also warns when the backup lists files whose content is stored in S3.

**`cds_model` is protected in data-only restores.** The `cds_model` table holds the schema metadata of the code version that is deployed now; the admin pod writes it with `cds-deploy` at every start. A `--data-only` restore leaves `cds_model` out of both the truncate and the restored data, so old metadata from the backup cannot overwrite it. Use `--include-cds-model` only when restoring into the same code version the backup was taken from.

**Use a data-only backup as the input of a data-only restore.** `--data-only` on `restore` does not strip the `DROP` and `CREATE` statements from a full backup: restoring a full backup with `--data-only` still replaces the freshly deployed schema with the old one. Take the upgrade backup with `backup --data-only`, and keep a full backup only to roll back to the old version.

### reset

```bash
node cli-tools/kyma-db-manager.js reset --namespace sail-proxy --pause-deployments
```

Deletes all rows from all tables and keeps the schema. Use it to start from empty tables, for example before an import of your own or in a test namespace.

::: danger `reset` deletes every file_search corpus
It empties every table, including `file_blobs`, `vector_stores`, `vector_store_files` and `vector_store_chunks`: every uploaded document, every vector store and every embedding goes, and only a backup brings them back. Re-ingesting them regenerates the embeddings, which is a billed SAP AI Core call per chunk. Take a backup first.
:::

## Restore modes

| Mode | Input | What happens |
|---|---|---|
| Full restore (no `--data-only`) | A full backup | The backup's statements drop and recreate every table, then load all data. It overwrites any schema deployed after the backup, so use it only to go back to the backup's version. |
| Data-only (`--data-only`) | A data-only backup | Loads the data into the existing schema, without `cds_model`. Fails with duplicate keys when the tables are not empty. |
| Data-only with truncate (`--data-only --truncate-first`) | A data-only backup | Empties every table (except `cds_model`), then loads the data. The mode for upgrades. |

## Safety features

- **Safety backup**: before a restore, the tool asks `Create automatic safety backup before restore?` and writes it as `safety-backup-<timestamp>.sql` next to the input file. `--no-auto-backup` skips it.
- **Confirmation**: every destructive step asks first, for example `This will TRUNCATE all tables (delete all data) and restore from backup. Continue?`.
- **Pausing**: `--pause-deployments` scales the `gateway` and `admin` deployments to zero, so nothing writes to the database meanwhile, and scales them back to their previous replica counts afterwards. The gateway API and the Admin Cockpit are unavailable during that time and running requests are cut off; plan a maintenance window.
- **Index builds**: `backup`, `restore` and `reset` refuse to run while a file search `rebuild-index` Job runs in the namespace, because that Job writes to the database and is not paused with the deployments. Wait for it to finish (`kubectl logs -f job/file-search-rebuild-index -n sail-proxy`).
- **Dry run**: `restore --dry-run` lists the steps and changes nothing.

## Common tasks

### Regular backup

```bash
mkdir -p backups
node cli-tools/kyma-db-manager.js backup \
  --namespace sail-proxy \
  --output "backups/backup-$(date +%Y%m%d-%H%M%S).sql"
ls -lh backups/
```

A scheduled backup, for example with cron (`%` must be escaped there):

```bash
0 2 * * * cd /path/to/sail-proxy && node cli-tools/kyma-db-manager.js backup --namespace sail-proxy --yes --output backups/daily-$(date +\%Y\%m\%d).sql
```

### Upgrade with a schema change

The admin pod updates its schema with `cds-deploy` when it starts, and the gateway updates the file search tables at its start. For an upgrade that changes the schema, this workflow keeps a restore point and loads the data cleanly into the new schema:

```bash
# 0. Baseline: tables and row counts
node cli-tools/kyma-db-manager.js info --namespace sail-proxy

# 1. Data-only backup: the restore input (it has no DDL, so it cannot overwrite the new schema)
node cli-tools/kyma-db-manager.js backup --namespace sail-proxy \
  --data-only --output backups/pre-upgrade-data.sql

# 1b. Full backup: only for going back to the OLD version, never restore it after upgrading
node cli-tools/kyma-db-manager.js backup --namespace sail-proxy \
  --output backups/pre-upgrade-full.sql

# 2. Copy both backups to a safe place

# 3. Deploy the new version from the new checkout (renders and applies the manifests)
node kyma/scripts/setup-kyma.js
node kyma/scripts/deploy-kyma.js

# 4. Wait until the admin pod has migrated the schema
kubectl wait --for=condition=ready pod -l app=admin -n sail-proxy --timeout=300s

# 5. Restore the data into the new schema, with the services paused
node cli-tools/kyma-db-manager.js restore --namespace sail-proxy \
  --input backups/pre-upgrade-data.sql \
  --data-only --truncate-first --pause-deployments

# 6. Check: the row counts should match the baseline
node cli-tools/kyma-db-manager.js info --namespace sail-proxy
```

`--truncate-first` removes the rows the new version may have written at its first start while keeping the new schema, so the restore meets no duplicate keys. It suits additive schema changes such as new columns and indexes.

### Copy data to another namespace or cluster

```bash
# From production
kubectl config use-context production-cluster
node cli-tools/kyma-db-manager.js backup --namespace sail-proxy \
  --data-only --output prod-data.sql

# Into staging, keeping staging's schema
kubectl config use-context staging-cluster
node cli-tools/kyma-db-manager.js restore --namespace sail-proxy \
  --input prod-data.sql --data-only --truncate-first
```

The target needs the same encryption keys as the source to read the stored credentials (see [SAP BTP Kyma](/deploy/kyma#re-running-setup-keys-and-database-credentials)), and its own S3 prefix if file search uses S3.

### Disaster recovery

```bash
node cli-tools/kyma-db-manager.js restore --namespace sail-proxy \
  --input backups/backup-20260113-120000.sql
```

The full restore offers a safety backup, then drops and recreates every database object from the backup and loads all data.

## Troubleshooting

**"Pod postgres-0 is not running"**

```bash
kubectl get pods -n sail-proxy | grep postgres
kubectl logs -n sail-proxy postgres-0
kubectl rollout restart statefulset/postgres -n sail-proxy
```

**"Failed to retrieve credentials"**

```bash
kubectl get secret postgres-env -n sail-proxy
kubectl auth can-i get secrets -n sail-proxy
```

**"duplicate key value violates unique constraint"**: the data exists already. Restore with `--data-only --truncate-first`, or do a full restore (without `--data-only`) from a full backup.

**The backup takes too long**: leave out the usage history with `--exclude-table sap_llm_gateway_admin_apikeyusage,sap_llm_gateway_admin_awscredentialusage`, or use `--compress`.

## Recommendations

- Back up the production database daily, and always before an upgrade.
- Test restores regularly in a test namespace.
- Keep backups encrypted and access-restricted: they contain the key and credential records, the configuration and the usage data.
- Rotate them, for example daily copies for a week, weekly for a month, monthly for a year.
- Run `restore --dry-run` before a production restore.
- Watch the backup size to notice data growth.

## Without the tool

The same backup and restore with `kubectl` alone:

```bash
POSTGRES_USER=$(kubectl -n sail-proxy get secret postgres-env -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
POSTGRES_PASSWORD=$(kubectl -n sail-proxy get secret postgres-env -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

# Backup
kubectl -n sail-proxy exec -i postgres-0 -- \
  env PGPASSWORD="${POSTGRES_PASSWORD}" \
  pg_dump -U "${POSTGRES_USER}" -d sap_llm_gateway --clean --if-exists \
  > backup-$(date +%Y%m%d-%H%M%S).sql

# Restore
kubectl -n sail-proxy exec -i postgres-0 -- \
  env PGPASSWORD="${POSTGRES_PASSWORD}" \
  psql -U "${POSTGRES_USER}" -d sap_llm_gateway \
  < backup-20260113-120000.sql
```

This path has none of the tool's protections: no safety backup, no `cds_model` protection, no pausing and no pgvector handling.
