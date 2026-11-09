---
title: Upgrade on Docker
description: Upgrade a Docker Compose installation to a new release with one command, with a backup first and an automatic rollback if anything fails.
---

# Upgrade on Docker

`sail-proxy upgrade docker` upgrades an installation made by `setup-docker.js` to the release of the package you run it from. It backs up the database and the configuration files, pulls the new images, applies them, runs the database migrations and checks that the installation is healthy. If any step fails after the services have been stopped, it goes back to the previous version, the configuration files and the database as they were.

## Before you start

- Node.js 20 or later and Docker with Compose.
- The installation runs 0.11.0 or later. Skipping releases is allowed.
- A registry installation. Installations whose images are built locally (a `docker-compose.override.yml` that builds) are refused: update those with git and `setup-docker.js`.
- The install directory (the clone `setup-docker.js` ran in) has no local changes to tracked files. Commit or revert them first.
- Free disk space in the backup folder: three times the database size plus 100 MB.

## Run it

From the install directory, or with `--dir`:

```bash
npx @st-gr/sail-proxy@latest upgrade docker --dir /srv/sail-proxy
```

Use the version you want instead of `latest` to pin it. The command asks for the backup passphrase and once before it stops the services.

| Option | Meaning |
|---|---|
| `-d, --dir <dir>` | The install directory (default: the current directory) |
| `--backup-dir <dir>` | Where the backup is written |
| `--no-encrypt` | Write the backup as plain text (after a warning) |
| `-y, --yes` | Do not ask before the outage |

The Docker installation then updates with this command. `git pull` in the install directory is no longer the way to update it.

## The passphrase

The backup holds API keys and secrets, so it is encrypted. The passphrase must be at least 12 characters. It is read from `SAIL_PROXY_BACKUP_PASSPHRASE` if set, otherwise from a hidden prompt, and is never stored: **without it the backup cannot be restored**.

On a shared machine, prefer the hidden prompt: an environment variable can be seen by other users.

`--no-encrypt` writes plain text after a warning and a confirmation (skipped with `--yes`).

## Where the backup goes

| System | Default folder |
|---|---|
| Linux and macOS | `~/.sail-proxy/backups` |
| Windows | `%APPDATA%\sail-proxy\backups` |

The file is named `<project>-<old version>-<date>.spbk`, for example `docker-0.11.0-20261107T101500Z.spbk`. It holds the database dump and the configuration files of the install directory. It is kept after a successful run.

## What happens

1. **Read and check.** The compose project, version and images; the new compose file is validated and the new images are pulled while the installation keeps running; no one-off container may be running; the disk space is checked.
2. **Outage.** nginx, the gateway and the admin service stop. PostgreSQL keeps running.
3. **Backup.** The database and the configuration files are written to the backup file.
4. **Apply.** The new compose file and images are applied.
5. **Migrate.** The database migrations run.
6. **Health check.** The services must report healthy.
7. **Record.** The installation notes its new version.

Ctrl-C or a closed terminal before step 2 cancels the run and changes nothing. From step 2 on it stops after the current step and rolls back; a second Ctrl-C does not interrupt the rollback. A rollback and `sail-proxy restore` name each phase as it starts, repeat every 15 seconds that it is still running, and report how long it took: a phase that takes minutes, such as restoring a large database, has not hung.

## What the upgrade refuses

It stops before the outage, with nothing changed, when:

- the directory is no Docker install directory, or the installation is older than 0.11.0;
- the images are built locally, or tracked files in the install directory have local changes;
- the package is not newer than the installed version;
- the release changes how file storage or Valkey data is laid out;
- the installation runs another PostgreSQL image than the release;
- the new compose file does not validate, or the images cannot be pulled (run `docker login` first for a private registry);
- a one-off container, such as a `rebuild-index` run, is running;
- the disk space is not enough.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Upgraded |
| 1 | Not upgraded: refused or failed before the outage; nothing was changed |
| 2 | Failed after the outage started and was rolled back |
| 3 | Failed and the rollback failed too; the message prints the `restore` command |

## What the backup does not contain

The backup holds the database and the configuration files. It does not hold the MinIO file bytes nor the Valkey data. That is safe: a release may only add to them, and the upgrade refuses a release that declares otherwise. Docker volumes are never deleted or pruned by the upgrade.

## Restore by hand

```bash
npx @st-gr/sail-proxy@latest restore docker --dir /srv/sail-proxy \
  --input ~/.sail-proxy/backups/docker-0.11.0-20261107T101500Z.spbk
```

This replaces the database and the configuration files with the backup, after asking (`--yes` skips the question). The passphrase is asked once, or read from `SAIL_PROXY_BACKUP_PASSPHRASE`. A wrong passphrase or a damaged file is refused with "wrong passphrase or damaged file", and nothing is changed.

## Troubleshooting

**The images cannot be pulled.** Log in to the registry with `docker login`, then run the upgrade again. Nothing was changed.

**The run stopped for lack of space.** Free space or use `--backup-dir`. The services are started again and no partial backup is left.

**Windows: the program crashed during a run.** The `docker` or `psql` processes it started may keep running for a moment; they are detached so that a second Ctrl-C cannot interrupt a rollback. Check `docker compose ps` before you start again.

See also [Backup, restore and upgrade](/deploy/backup-and-upgrade), [Docker Compose](/deploy/docker) and [Upgrade on Kyma](/deploy/upgrade-kyma).
