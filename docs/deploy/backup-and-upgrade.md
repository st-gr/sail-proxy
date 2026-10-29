---
title: Backup, restore and upgrade
description: What to back up for the standalone CLI, Docker and Kyma, how to restore it, and the steps for upgrading each deployment, with the notes for the current release.
---

# Backup, restore and upgrade

The Admin Cockpit has no backup or restore function. Each deployment is backed up with the tools of its platform. Three things need a copy:

- **The database**, if the deployment has one.
- **The configuration and the keys**: `VALIDATION_TOKEN_SECRET`, `METADATA_ENCRYPTION_KEY`, `AWS_SECRET_ENCRYPTION_KEY`, `SIEM_CREDENTIAL_KEY` and `CONNECTION_CREDENTIAL_KEY` encrypt or sign data in the database. A database restored without the keys it was written with cannot decrypt the stored AWS secret access keys, SIEM credentials and connection credentials.
- **The S3 bucket**, if file search stores file contents in S3: a database backup holds only references to them (see [File storage for file_search](/deploy/file-storage#backups)).

Backups contain credentials. Keep them encrypted and readable only by those who operate the deployment.

## Standalone CLI

The CLI has no database. Its keys and settings are files in the configuration directory, `~/.sail-proxy/` (on Windows `%APPDATA%\sail-proxy\`, or `SAIL_PROXY_CONFIG_DIR` when set): `.env`, `api_config.json`, `apikeys.json`, `aws-credentials.json`, `endpoint.json` (it can hold a remote gateway's API key stored with `--key`) and `ollama.env`. Stop the gateway and copy the directory:

```bash
sail-proxy stop
(umask 077; tar -czf sail-proxy-config.tar.gz -C ~ .sail-proxy)
```

To restore, unpack the copy into the home directory and run `sail-proxy run`. If you gave the CLI a file search database (`FILE_SEARCH_DATABASE_URL`), back that database up with `pg_dump` as well.

## Docker Compose

Run the commands from the `docker/` directory of the checkout.

**Database**: one PostgreSQL database holds the admin service's data, Dex's sessions and file search. The dump runs inside the `postgres` container as the user and database the compose file configures there, so no password is typed:

```bash
cd docker
(umask 077; docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' > backup.sql)
```

**Configuration**: the files the setup wrote are not in the repository, so a rebuilt host needs them back:

```bash
(umask 077; tar -czf config-backup.tar.gz \
  .env .env.docker .env.auth .env.postgres .env.filesearch-runtime .env.nginx dex.config.yaml okta-saml-ca.pem \
  ../services/gateway/.env ../services/admin/.env)
```

**Restore** into the same installation, with the services that use the database stopped:

```bash
docker compose stop gateway admin
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backup.sql
docker compose start gateway admin
```

On a new host, unpack the configuration backup into the checkout first, start the services once so the database exists, then restore the dump.

## SAP BTP Kyma

**Database**: `cli-tools/kyma-db-manager.js` backs up and restores the namespace's PostgreSQL database; [Database migration](/deploy/database-migration) describes it.

```bash
node cli-tools/kyma-db-manager.js backup --namespace sail-proxy \
  --output backups/backup-$(date +%Y%m%d-%H%M%S).sql
```

**Keys and credentials**: they live in the namespace's Secrets. `setup-kyma.js` carries them over from the live namespace on every run, so the live Secrets are their only source. Export them alongside each database backup:

```bash
(umask 077; kubectl -n sail-proxy get secret \
  admin-env gateway-env gateway-migration-env postgres-env oauth2-proxy-secrets \
  -o yaml > kyma-secrets-backup.yaml)
```

Add `gateway-s3-env` when file search uses S3. To rebuild a lost namespace, create the namespace and recreate these Secrets from the export (remove the `resourceVersion`, `uid` and `creationTimestamp` fields first) before you run `setup-kyma.js`, so it finds and keeps the keys; then deploy and restore the database.

## Upgrade

Back up first, then upgrade the admin service and the gateway together: they must run the same version and share one `VALIDATION_TOKEN_SECRET`.

### Standalone CLI

```bash
sail-proxy update
```

or `npm update -g @st-gr/sail-proxy`. Then restart the gateway: `sail-proxy stop`, `sail-proxy run`. Your configuration directory stays as it is. `sail-proxy config reset` would rewrite `api_config.json` from the new version's template, together with the rest of the setup.

### Docker Compose

```bash
git pull
# set DOCKER_TAG in docker/.env to the new version (the setup writes the version of the checkout)
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

With locally built images, run `docker compose -f docker/docker-compose.yml up -d --build` instead of `pull` and `up`. No separate migration step is needed: the admin service updates its schema with `cds-deploy` at every start, and the `gateway-migrate` service updates the file search tables before the gateway starts. Check the result with `docker compose -f docker/docker-compose.yml logs admin gateway-migrate`.

### SAP BTP Kyma

From a checkout of the new version:

```bash
node kyma/scripts/setup-kyma.js
node kyma/scripts/deploy-kyma.js
```

Choose the new image version when the setup asks. The setup carries the encryption keys and the database credentials over from the live namespace, and `deploy-kyma.js` refuses to apply a render whose keys differ from the live ones (see [SAP BTP Kyma](/deploy/kyma#re-running-setup-keys-and-database-credentials)). The admin pod updates its schema when it starts, and the gateway's init container updates the file search tables. Always deploy with `deploy-kyma.js` from the new checkout: it renders the admin's `admin-api-config` ConfigMap again from the new version's configuration, while an old rendered copy applied by hand keeps the old one.

For an upgrade with a backup and a data restore around it, follow [Upgrade with a schema change](/deploy/database-migration#upgrade-with-a-schema-change).

## Upgrading from 0.10.0 to the next release

These steps and changes come from the changelog's **Unreleased** section.

**AWS credentials**
- The gateway now verifies AWS SigV4 signatures. AWS clients must sign with the credential's real secret access key; a request with a wrong signature is now refused.
- AWS SigV4 works on JSON routes only. Multipart routes, such as file upload and image edits, answer `403` to AWS credentials.
- Behind the Docker nginx, AWS clients may sign for the `/gateway` path.
- Outside development, the admin logs a security warning at startup when `AWS_SECRET_ENCRYPTION_KEY` is missing or still the built-in development or sample value: the stored AWS secret access keys are then encrypted with a publicly known key. Set a generated key (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) in the admin's environment, restart the admin, and enter the stored AWS secret access keys again: keys stored under the old value cannot be read with the new one.

**Keys and services**
- Upgrade the admin and the gateway together. They must share one `VALIDATION_TOKEN_SECRET` that is neither the built-in default nor the `.env.sample` placeholder; outside development the admin refuses tokens signed with those. On Docker, `setup-docker.js` replaces such a value in an existing `.env` with a generated one, in both the admin and the gateway file.
- Docker: the ports of the admin service, Valkey, PostgreSQL, Dex and oauth2-proxy are bound to `127.0.0.1` only. Clients that reached them from another host must go through nginx.
- The admin Docker image runs on PostgreSQL only; an admin container overridden to use SQLite no longer starts.
- `LOG_LEVEL` now takes effect. Logging components that a stored configuration pins to a level (`platform.logging.components`) keep that level; to let `LOG_LEVEL` govern them, create and activate a configuration without those entries.
- Kyma: `--namespace` allows a second deployment on the same cluster, and the keys carry over between setups. Key rotation is not supported.

**File search**
- The gateway adds tables and columns to the file search database at its first start. An installation whose gateway database role does not own the file search tables reports file search as unavailable until the migration step has run as the owner: `gateway-migrate` on Docker, the init container on Kyma, `cli-tools/file-search-migrate.js` (or `FILE_SEARCH_MIGRATION_DATABASE_URL`) elsewhere. On a large database, the first start briefly locks the chunk table; a search at that moment can fail once.
- Existing vector stores keep their chunks and their static chunking; the upgrade re-chunks nothing and starts no model calls. A configuration written before this release keeps static chunking without contexts. To use the new default (structure chunking with contexts), set `capabilities.file_search.chunking` to `{"strategy": "structure", "max_chunk_size_tokens": 800, "chunk_overlap_tokens": 0, "contextual": true}` and activate the configuration. On the standalone CLI, `sail-proxy config reset` rewrites `api_config.json` from the new template and so switches it on too.
- `capabilities.file_search.chunking` takes tighter ranges: `max_chunk_size_tokens` 100 to 4096, `chunk_overlap_tokens` 0 to 2048 and at most half of `max_chunk_size_tokens`. A stored configuration outside them opens in the JSON editor and must be corrected before it can be saved.
- The existing vector index stays until you run `rebuild-index` (`cli-tools/file-search-migrate.js rebuild-index`, on the CLI `sail-proxy file-search rebuild-index`; `--dry-run` first). Run it before you switch on approximate search. On Kyma, do not back up, restore or reset the database while it runs; `kyma-db-manager.js` refuses to.
- Files already ingested keep their chunks; scanned pages are not read again by the upgrade. A store's owner reads its files again with **Re-read Files**.
- `GET /files` without `limit` now returns up to 10,000 files per page instead of 20.

The changelog lists every change of the release.
