---
title: File storage for file_search
description: Where the contents of files uploaded for file_search are stored, in the database or in an S3 bucket, and how to set up, secure, migrate and back up S3 storage.
---

# File storage for file_search

The content of files uploaded for the `file_search` tool is stored once per distinct content. By default it is stored in the file search database itself (`blob_storage.backend` `"db"`), which needs no further setup. With `"s3"`, new uploads go to an S3 bucket instead, on AWS or on an S3-compatible service, and the database keeps only a reference.

`file_search` needs its PostgreSQL database in either case. Docker and Kyma bring one; a [standalone CLI](/deploy/cli#file-search) has one only when you point `FILE_SEARCH_DATABASE_URL` at it.

## 1. Configure the bucket

Set the backend and the bucket in the gateway configuration: in the Admin Cockpit under [Gateway configuration](/guide/cockpit/configuration), **Capabilities → File Search → Blob Storage**, or in `api_config.json` under `capabilities.file_search`:

```json
"blob_storage": {
  "backend": "s3",
  "s3": { "bucket": "<your-bucket>", "region": "<region>", "prefix": "sail-proxy/blobs", "endpoint": "" }
}
```

- `prefix` is the folder the gateway writes into (default `sail-proxy/blobs`). It reads, writes and deletes only below it and never lists the bucket, so the bucket can hold other data. The prefix is required and consists of path segments of letters, digits, `.`, `_` and `-`.
- **Give every installation its own prefix (or bucket).** Files with identical content share one object, so two installations (for example production and a test instance) writing under the same prefix share objects, and one of them deletes content the other still uses.
- `region` is required, also for S3-compatible services.
- Leave `endpoint` empty for AWS. For an S3-compatible service, set it to `https://host[:port]` (or `http://` for a service without TLS), without a path.

## 2. Provide the credentials

The gateway reads the credentials from two environment variables; they are never part of the configuration:

```bash
FILE_SEARCH_S3_ACCESS_KEY_ID=<access-key-id>
FILE_SEARCH_S3_SECRET_ACCESS_KEY=<secret-access-key>
```

**Docker**: add both to `services/gateway/.env` (Docker Compose passes that file to the gateway) and restart the gateway:

```bash
docker compose -f docker/docker-compose.yml restart gateway
```

**Kyma**: create the optional Secret `gateway-s3-env`. The gateway reads it when present and starts without it, and a later `setup-kyma.js` run keeps its values. The template is `kyma/templates/secrets/gateway-s3-env.yaml.template`.

```bash
kubectl -n sail-proxy create secret generic gateway-s3-env \
  --from-literal=FILE_SEARCH_S3_ACCESS_KEY_ID=<access-key-id> \
  --from-literal=FILE_SEARCH_S3_SECRET_ACCESS_KEY=<secret-access-key>
kubectl -n sail-proxy rollout restart deployment/gateway
```

The gateway must reach the S3 endpoint from the cluster. Check this in a test namespace before switching production; the test namespace has its own database, so give it a prefix (or bucket) of its own, never production's.

**Standalone CLI**: add both to the `.env` of the configuration directory and restart the gateway.

The credentials stay necessary as long as any file is stored in S3, also after switching the backend back to `"db"`, and for a migration to or from S3. Without them, the first upload or download that needs S3 fails with `503 blob_storage_unavailable`; the gateway starts regardless.

### Permissions

Use keys that can do only what the gateway needs, never an account's root keys. Recommended IAM policy, with your bucket and prefix (the `ListBucket` statement is optional):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket>/<prefix>/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": ["<prefix>/*"] } } }
  ]
}
```

Every request the gateway sends names a file below the prefix: it never lists the bucket and sends no request on the bucket itself. With permissions limited to the prefix, S3 may answer "access denied" rather than "not found" for a file that does not exist; the gateway does not depend on that answer. A file it cannot read is reported as unavailable, and stored content counts as deleted only when S3 confirmed its deletion.

### Test the connection

The **Test S3 Connection** button in the Grounding administration, and the start of a migration to S3, check the connection by writing and reading back one small fixed probe object below the prefix. The probe object stays there (a file with identical content would share it).

To try S3 storage locally with Docker, the compose file has an optional MinIO service. Set its credentials in your shell first (the password at least 8 characters), then start it:

```bash
MINIO_ROOT_USER=<access-key> MINIO_ROOT_PASSWORD=<secret-key> \
  docker compose -f docker/docker-compose.yml --profile minio up -d minio
```

Inside the Compose network its endpoint is `http://minio:9000`; from the host, `http://127.0.0.1:59100`. Create the bucket in MinIO before you test.

## 3. Move existing files (optional)

Switching the backend changes only where new uploads go; every file stays readable where it is stored. To move existing files, start a migration in the Grounding administration's [Blob Storage](/guide/cockpit/grounding#blob-storage) panel.

## Backups

A database backup does not contain the content of files stored in S3; protect the bucket with its own backup or versioning. `kyma-db-manager.js` counts the files stored in S3 when it backs up and warns about them (see [Database migration](/deploy/database-migration)).

Restoring an older database backup brings back references only: content deleted from the bucket since then cannot be downloaded, and content written since stays in the bucket unused. A few unused objects can also remain after a prefix change (the objects under the previous prefix) or after a gateway crash during an upload or a migration; they always lie under the configured prefix.
