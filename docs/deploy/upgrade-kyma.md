---
title: Upgrade on Kyma
description: Upgrade a Kyma installation to a new release with one command, with a backup first and an automatic rollback if anything fails.
---

# Upgrade on Kyma

`sail-proxy upgrade kyma` upgrades an installation in a namespace to the release of the package you run it from. It backs up the database, applies the new release, runs the database migrations and checks that the installation is healthy. If any step fails after the gateway and the admin service have been stopped, it goes back to the previous version and the database as it was before.

## Before you start

- Node.js 20 or later.
- `kubectl` pointed at the cluster and logged in (for example with the `oidc-login` plugin). The upgrade checks that your login may do everything the upgrade and its rollback need, and stops before changing anything if it may not.
- The installation runs 0.11.0 or later. Skipping releases is allowed. An older installation must first be upgraded to 0.11.0 the way that release describes.
- Registry access: the installation's own registry login is used to find the new images.
- Free disk space in the backup folder: three times the database size plus 100 MB.
- The upgrade also changes the installation's own objects outside the namespace: the ClusterRole and ClusterRoleBinding of Dex and the installation's policies in `istio-system`. Your `kubectl` login needs rights for them.

## Run it

```bash
npx @st-gr/sail-proxy@latest upgrade kyma --namespace my-namespace
```

Use the version you want instead of `latest` to pin it. `sail-proxy upgrade kyma` works the same once `sail-proxy update` has installed the new package.

It reads the installation, asks what it needs, checks everything it can, then asks once before it starts the outage.

### What it asks

| Question | When |
|---|---|
| Backup passphrase (twice) | Always, unless you set `SAIL_PROXY_BACKUP_PASSPHRASE` or pass `--no-encrypt` |
| Values no source holds | The first upgrade of an installation that was set up by an older release. It asks once for the Okta metadata URL and certificate choice (Okta installs only) and for the version when the images are pinned by digest. Later upgrades ask nothing of this |
| Start the outage? | Always, unless you pass `--yes` |

Keys and passwords are never changed by an upgrade, and they are never printed.

## The passphrase

The backup holds API keys and secrets, so it is encrypted. The passphrase must be at least 12 characters. It is read from the environment variable `SAIL_PROXY_BACKUP_PASSPHRASE` if set, otherwise from a hidden prompt. It is never stored: **without it the backup cannot be restored**, so keep it with the backup.

On a shared machine, prefer the hidden prompt: an environment variable can be seen by other users and ends up in shell history when typed on the command line.

`--no-encrypt` writes the backup as plain text after a warning and a confirmation (skipped with `--yes`). Use it only where the backup folder is itself protected.

## Where the backup goes

| System | Default folder |
|---|---|
| Linux and macOS | `~/.sail-proxy/backups` |
| Windows | `%APPDATA%\sail-proxy\backups` |

The file is named `<namespace>-<old version>-<date>.spbk`, for example `my-namespace-0.11.0-20261107T101500Z.spbk`. `--backup-dir <dir>` writes it somewhere else. The upgrade keeps the file after a successful run.

## What happens

1. **Read and check.** Installed version, replicas and images; the new images are looked up; the new manifests are validated on the server; the disk space is checked.
2. **Outage.** The admin service and the gateway are stopped. The cockpit and the API are unavailable from here until the end.
3. **Backup.** The database and the previous Kubernetes objects are written to the backup file.
4. **Apply.** The new release is applied.
5. **Migrate.** The database migrations run.
6. **Health check.** The admin service and the gateway must report healthy.
7. **Record.** The installation notes its new version.

The outage lasts from step 2 to step 6, typically a few minutes, longer with a large database.

Pressing Ctrl-C (or closing the terminal) before step 2 cancels the run and changes nothing. From step 2 on it stops after the current step and rolls back; pressing it again does not interrupt the rollback. A rollback and `sail-proxy restore` name each phase as it starts, repeat every 15 seconds that it is still running, and report how long it took: a phase that takes minutes, such as restoring a large database, has not hung.

## What the upgrade refuses

It stops before the outage, with nothing changed, when:

- the namespace has no installation, or the installation is older than 0.11.0;
- the package is not newer than the installed version;
- the release changes how file storage or Valkey data is laid out (its release notes say so);
- the installation runs another PostgreSQL image than the release (a PostgreSQL change is not done by `upgrade`);
- a file_search `rebuild-index` Job is running;
- `kubectl` may not do something the upgrade or its rollback needs, or the server rejects the new manifests;
- the disk space is not enough.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Upgraded |
| 1 | Not upgraded: refused or failed before the outage; nothing was changed |
| 2 | Failed after the outage started and was rolled back to the previous version |
| 3 | Failed and the rollback failed too; the message prints the `restore` command |

## What the backup does not contain

The backup holds the PostgreSQL database and the previous Kubernetes objects. It does not hold the file bytes in S3 or MinIO, nor the Valkey data. That is safe: a release may only add to them, and the upgrade refuses a release that declares otherwise. Going back to the old version leaves them in place, and the old version reads what it needs.

## Restore by hand

If the rollback failed, or you want to go back later:

```bash
npx @st-gr/sail-proxy@latest restore kyma --namespace my-namespace \
  --input ~/.sail-proxy/backups/my-namespace-0.11.0-20261107T101500Z.spbk
```

This replaces the database with the backup, after asking (`--yes` skips the question). Add `--manifests` to put back the previous version's Kubernetes objects as well; do that when you also go back to the previous images. The passphrase is asked once, or read from `SAIL_PROXY_BACKUP_PASSPHRASE`. A wrong passphrase or a damaged file is refused with "wrong passphrase or damaged file", and nothing is changed.

## Troubleshooting

**"kubectl may not do everything the upgrade needs".** Ask the cluster administrator for the missing rights, or use an account that has them.

**The login expired during the run.** The upgrade says so and tries to roll back. Log in again, then run `restore kyma` as printed.

**The run stopped for lack of space.** Free space in the backup folder or choose another with `--backup-dir`. The old components are started again and no partial backup is left.

**Windows: the program crashed during a run.** The `kubectl` or `psql` processes it started may keep running for a moment; they are deliberately detached so that a second Ctrl-C cannot interrupt a rollback. Check `kubectl get pods -n my-namespace` before you start again.

See also [Backup, restore and upgrade](/deploy/backup-and-upgrade), [SAP BTP Kyma](/deploy/kyma) and [Upgrade on Docker](/deploy/upgrade-docker).
