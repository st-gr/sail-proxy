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

**With an external PostgreSQL**: if the installation uses a PostgreSQL outside the cluster, such as SAP BTP's "PostgreSQL, hyperscaler option", the service makes its own backups, and you back up and restore the database with the service's tools. `kyma-db-manager.js` works on the in-cluster PostgreSQL only, so its steps do not apply, and `sail-proxy upgrade kyma` refuses such an installation; retention times and restores are described in SAP's documentation for the service. The keys and credentials below, and the S3 bucket, still need their own copy. [External PostgreSQL on Kyma](/deploy/external-postgres#backup-and-recovery-runbook) describes the options.

**Keys and credentials**: they live in the namespace's Secrets. `setup-kyma.js` carries them over from the live namespace on every run, so the live Secrets are their only source. Export them alongside each database backup:

```bash
(umask 077; kubectl -n sail-proxy get secret \
  admin-env gateway-env gateway-migration-env postgres-env oauth2-proxy-secrets \
  -o yaml > kyma-secrets-backup.yaml)
```

Add `gateway-s3-env` when file search uses S3. To rebuild a lost namespace, create the namespace and recreate these Secrets from the export (remove the `resourceVersion`, `uid` and `creationTimestamp` fields first) before you run `setup-kyma.js`, so it finds and keeps the keys; then deploy and restore the database.

## Upgrade

On Docker and Kyma, the `upgrade` command makes the backup itself. For the standalone CLI, back up first, then upgrade the admin service and the gateway together: they must run the same version and share one `VALIDATION_TOKEN_SECRET`.

### Standalone CLI

```bash
sail-proxy update
```

or `npm update -g @st-gr/sail-proxy`. Then restart the gateway: `sail-proxy stop`, `sail-proxy run`. Your configuration directory stays as it is. The first `sail-proxy run` after the update lists the settings the new version's default configuration holds and your `api_config.json` lacks; copy the ones you want from the default file it names. `sail-proxy config reset` would rewrite `api_config.json` from the new version's template, together with the rest of the setup.

### Docker Compose

```bash
npx @st-gr/sail-proxy@latest upgrade docker --dir <install directory>
```

The command backs up, upgrades and rolls back on any failure: see [Upgrade on Docker](/deploy/upgrade-docker). It needs an installation on 0.12.1 or later with registry images. For locally built images, run `git pull` and `docker compose -f docker/docker-compose.yml up -d --build` instead. No separate migration step is needed: the admin service updates its schema with `cds-deploy` at every start, and the `gateway-migrate` service updates the file search tables before the gateway starts. Check the result with `docker compose -f docker/docker-compose.yml logs admin gateway-migrate`.

### SAP BTP Kyma

```bash
npx @st-gr/sail-proxy@latest upgrade kyma --namespace my-namespace
```

The command backs up the database, applies the new release, runs the migrations and rolls back on any failure: see [Upgrade on Kyma](/deploy/upgrade-kyma). It keeps the encryption keys and the database credentials of the live namespace. It needs an installation on 0.12.1 or later.

`upgrade` refuses an installation that is too old for it (it names the release to upgrade to first), a change of the Postgres image or major version, and a release that declares a storage-layout change; it says so before it changes anything. In those cases follow the release notes of the new release, which give the manual procedure: back up the database with the database tool, run setup again from a checkout of the new release, deploy, and restore the database if the notes say so.

For an upgrade with a data restore around it, follow [Upgrade with a schema change](/deploy/database-migration#upgrade-with-a-schema-change).

## Steps for a specific release

Steps that one release needs beyond the command above are listed under **Upgrading** in that
release's section of the [changelog](/changelog). Read the sections of every release between the
installed one and the new one before you upgrade.
