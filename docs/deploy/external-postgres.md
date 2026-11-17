---
title: External PostgreSQL on Kyma
description: Run sail-proxy on Kyma against a managed PostgreSQL such as SAP BTP "PostgreSQL, hyperscaler option" instead of the PostgreSQL the setup deploys, with the setup steps and a tested backup and recovery runbook.
---

# External PostgreSQL on Kyma

By default the Kyma setup deploys its own PostgreSQL into the namespace. This page covers the alternative: a PostgreSQL outside the cluster, described by a service binding Secret. It was built and tested with SAP BTP **PostgreSQL, hyperscaler option** (service `postgresql-db`).

Every statement below is marked by how it is known:

- **Tested**: run on 2026-11-10 against a `standard` instance on Google Cloud (`us-central1`, PostgreSQL 16.15) from a Kyma cluster, with sail-proxy 0.12.1 images.
- **Documented**: stated in SAP's documentation, not run by us.
- **Open**: neither tested nor clearly documented.

Other hyperscalers were not tested. The Docker deployment and the standalone CLI are not affected by anything here.

## What differs from the in-cluster database

| | In-cluster (default) | External |
|---|---|---|
| PostgreSQL pod and volume | Deployed by the setup | None |
| Connection | Unencrypted, inside the namespace | TLS required by the service; the server certificate is checked against the binding's CA |
| Backups | `kyma-db-manager.js`, and `sail-proxy upgrade kyma` makes one | The service's own backups, or `pg_dump` (see the runbook) |
| `sail-proxy upgrade kyma` | Supported | Refuses the installation; upgrade manually (see below) |
| Network | Not reachable from outside the cluster | A public endpoint restricted to the IP addresses you allow |

Certificate checking needs a release that contains it. An older image still connects with encryption but without checking the certificate.

## Set up

### 1. Entitlements

**Tested.** The subaccount needs two plans of "PostgreSQL, Hyperscaler Option": `standard` (or `premium`) for compute and `storage` for disk space. Without `storage` the instance fails after about 20 minutes with "You do not have sufficient entitlements for storage".

### 2. Instance and binding

**Tested.** Create both in the namespace sail-proxy will run in. The cluster's outbound IP address is in the ConfigMap `kyma-info` in `kyma-system`, key `cloud.natGatewayIps`.

```yaml
apiVersion: services.cloud.sap.com/v1
kind: ServiceInstance
metadata: { name: sail-proxy-db, namespace: my-namespace }
spec:
  serviceOfferingName: postgresql-db
  servicePlanName: standard
  parameters:
    memory: 2
    storage: 20
    engine_version: "16"
    multi_az: false
    allow_access: "<cluster outbound IP>"
---
apiVersion: services.cloud.sap.com/v1
kind: ServiceBinding
metadata: { name: sail-proxy-db, namespace: my-namespace }
spec:
  serviceInstanceName: sail-proxy-db
  secretName: sail-proxy-db-binding
```

Provisioning took about five minutes. Wait until the instance reports `Ready=True` before creating the binding.

The Secret holds what the setup needs: `hostname`, `port`, `dbname`, `username`, `password` and `sslrootcert`. Any other PostgreSQL works the same way if you create a Secret with those six keys yourself; it must require TLS and have the `vector` extension.

### 3. Setup and deploy

Run `node kyma/scripts/setup-kyma.js --namespace my-namespace`. A new installation is asked **Database**; choose **External PostgreSQL** and enter the name of the binding Secret. Unattended, `--external-database sail-proxy-db-binding` gives the same answer. The setup asks for no database user or password.

Then deploy as usual. The deploy:

- deploys no PostgreSQL;
- enables the `vector` extension, which file search needs. **Tested:** the service user is no superuser and cannot run `CREATE EXTENSION vector`; the deploy asks SAP's service API for it with the certificate in the binding. For a Secret that is no SAP binding the extension must already exist.

**Tested:** the certificate in the binding that authenticates against SAP's service API is valid for 15 days. If the deploy reports that it could not enable the extension on an older binding, create a new ServiceBinding and run the setup and the deploy again (see [A renewed or re-created binding](#a-renewed-or-re-created-binding)). The database certificates are valid for years.

An installed namespace keeps its database: the setup refuses to move an installation from the in-cluster PostgreSQL to an external one, because its data would stay behind.

## Backup and recovery runbook

### What the service offers

| Control | Status |
|---|---|
| Automatic backups, on by default | **Documented** |
| Retention: instance parameter `backup_retention_period`, changeable on a running instance | **Tested**: on Google Cloud with plan `standard` the maximum is 7 days; 14 is refused with "must be <= 7". SAP's parameter page also states 0 to 35 days for Google Cloud, which did not hold |
| Listing backups, or a backup on demand | **Documented**: no API to list automatic backups; on-demand backups exist on AWS only |
| Backup or restore in the BTP cockpit | **Documented**: none; restores are requested by creating an instance |
| Point-in-time recovery | **Tested**, see below |
| Restoring a deleted instance from its last backup | **Open** on Kyma. Note the instance ID (`instance_guid` in the binding Secret) before you delete an instance |

Change the retention with:

```bash
kubectl -n my-namespace patch serviceinstance sail-proxy-db --type merge \
  -p '{"spec":{"parameters":{"backup_retention_period":7}}}'
```

### Point-in-time recovery

**Tested.** A recovery always creates a new instance. SAP documents it for the Cloud Foundry command line only; from Kyma it works with a ServiceInstance.

1. Note the source instance ID: `kubectl -n my-namespace get secret sail-proxy-db-binding -o jsonpath='{.data.instance_guid}' | base64 -d`.
2. Create the restored instance. The time is UTC and must be at least about 15 minutes in the past and inside the retention period. You need quota for a second instance.

   ```yaml
   apiVersion: services.cloud.sap.com/v1
   kind: ServiceInstance
   metadata: { name: sail-proxy-db-restored, namespace: my-namespace }
   spec:
     serviceOfferingName: postgresql-db
     servicePlanName: standard
     parameters:
       source_instance_id: "<instance ID from step 1>"
       restore_time: "2026-11-10T09:16:50Z"
   ```

   It was ready after about ten minutes. Size, PostgreSQL version and the allowed IP addresses were inherited.
3. Create a ServiceBinding for it, with a Secret name of its own.
4. Reconnect sail-proxy (next section).

What we saw in the restored instance: the data as it was at the given time (a record created one minute later was absent), all tables and extensions including `vector`, and the gateway's database role. The new binding has a different host, user, password and CA; port and database name are the same. The old user's password does not work there. Tables belong to a shared role, so the new user can migrate them.

### Reconnect sail-proxy to another database

**Tested**, to a restored instance and back.

```bash
node kyma/scripts/setup-kyma.js --namespace my-namespace --external-database sail-proxy-db-restored-binding
cd kyma && node scripts/deploy-kyma.js --namespace my-namespace
```

The setup asks you to confirm the reconnect; the default is no. The deploy then names the database values it changes and restarts the admin service and the gateway. Nothing is copied: the data must already be in the new database. Every other protected value, such as the signing and encryption keys, still may not change.

After that, delete the instance you no longer need, and its binding.

### A renewed or re-created binding

The Secret an installation already uses can come to hold other credentials, for example when the binding is deleted and created again under the same name. Run the setup and the deploy again:

```bash
node kyma/scripts/setup-kyma.js --namespace my-namespace
cd kyma && node scripts/deploy-kyma.js --namespace my-namespace
```

The setup notices that the Secret holds other credentials, or another database, than the installation runs with, and asks you to confirm taking them over; the default is no. The deploy then names the database values it changes and restarts the admin service and the gateway. An unattended run (`--ci`) stops instead of asking.

**Open:** this was not run against a real instance. In particular it is not known whether a user created by a new binding owns the tables an earlier binding's user created; check that the admin service and the gateway start and that file search works after the deploy.

### Portable backup with `pg_dump`

**Tested** into a second database of the same instance. Run the commands from a pod in the namespace (the database accepts only the allowed IP addresses), with a PostgreSQL 16 client, the connection values from the binding Secret and `PGSSLMODE=require`.

Back up:

```bash
pg_dump -d "$DBNAME" -Fc --no-owner --no-privileges -f sail-proxy.pgc
```

Restore into an empty database:

1. Enable `vector` for the target database first, through SAP's service API. A restore without this step fails: in our test it ended with 14 errors and without the table that holds the vectors, because the service user may not create the extension.

   ```bash
   curl --cert clientcert.pem --key clientkey.pem -X PUT \
     -H 'Content-Type: application/json' -d '{"database":"<target database>"}' \
     "<api_server>/v1/postgresql-db/instances/<instance_guid>/extensions/vector"
   ```

   `clientcert`, `clientkey`, `urls` (with `api_server`) and `instance_guid` are in the binding Secret.
2. Restore without the two monitoring extensions that only a superuser may create, and without extension comments:

   ```bash
   pg_restore -l sail-proxy.pgc \
     | grep -v -E "EXTENSION - (pg_stat_statements|pgaudit) |COMMENT - EXTENSION " > restore.list
   pg_restore -d "<target database>" --no-owner --no-privileges -L restore.list sail-proxy.pgc
   ```

   This ran without errors. Rows, indexes and constraints matched the source, and 200 test vectors with their index came back identical.
3. Reconnect sail-proxy to the target as above. For a second database on the same instance, the Secret to name is a copy of the binding Secret with `dbname` changed. `--no-privileges` drops the grants of the gateway's database role; the gateway's migration grants them again when it starts.

**Tested:** an installation reconnected to a database restored this way started normally. The gateway's migration ran, its database role had its grants again, and listing, creating and reading file search objects worked.

**Open:** the test installation held no embedded documents.

### Before an upgrade

`sail-proxy upgrade kyma` backs up and rolls back the in-cluster PostgreSQL only and refuses an external-database installation. Upgrade by hand:

1. Note the current time in UTC. That is your restore point; check that the retention period covers the time you need to decide about a rollback.
2. Optionally take a `pg_dump` as above, for a copy that does not depend on the service.
3. Run the new release's setup and deploy.
4. To roll back: bring the data back, either by restoring the instance to the time from step 1 or by restoring the dump from step 2 into a new database, then reconnect the installation to it with the previous release's setup and deploy.

**Tested** as one procedure with a dump: backup, a change written afterwards to stand for the failed upgrade, restore into a new database, reconnect, deploy. The installation came back with the data from before the change. The point-in-time variant was tested as recovery and reconnect.

**Open:** the test stayed on one release. A rollback across two releases with different database schemas was not run.

## Limits

- Tested on Google Cloud with plan `standard` only.
- `backup_retention_period: 0` was not tested; SAP does not document what it does.
- No test covered a failover (`multi_az`), a major version upgrade or a restore of a deleted instance.
- The database tool `cli-tools/kyma-db-manager.js` works on the in-cluster PostgreSQL only.
