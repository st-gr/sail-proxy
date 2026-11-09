---
title: API authentication
description: How clients authenticate to the gateway with API keys or AWS SigV4 signatures, how the gateway authenticates to SAP AI Core, and how the standalone administration endpoints work.
---

# API authentication

The gateway checks every client request itself: with a gateway API key or with an AWS SigV4 signature. Signing in to the Admin Cockpit is a separate matter, covered in [Authentication providers](/deploy/authentication).

## API keys

Gateway API keys start with `sk-`. The gateway reads the key from the first of these that is present:

| Where | Form |
|---|---|
| `x-api-key` header | `x-api-key: sk-…` |
| `x-stainless-key` header | `x-stainless-key: sk-…` |
| `x-goog-api-key` header | `x-goog-api-key: sk-…` (Gemini clients) |
| `api_key` query parameter | `?api_key=sk-…` |
| `key` query parameter | `?key=sk-…` (Gemini clients) |
| `Authorization` header | `Authorization: Bearer sk-…` |

A bearer token is taken as an API key only when it starts with `sk-`. A request without a valid key is answered with `401`.

On Docker and Kyma, people create their keys in the Admin Cockpit ([API keys](/guide/cockpit/api-keys)). On the standalone CLI, keys are managed through the [administration endpoints](#administration-endpoints) below.

## AWS SigV4

Requests signed with AWS Signature Version 4 are accepted wherever an API key is, which is what lets AWS SDKs, the AWS CLI and Claude Code's Bedrock mode use the AWS Bedrock routes (`/aws-bedrock/...`) unchanged. The credentials are AWS-style key pairs issued by the gateway, not AWS account credentials, and the requests go to SAP AI Core, not to AWS. People create them in the Admin Cockpit ([AWS credentials](/guide/cockpit/aws-credentials)) or, on the standalone CLI, through `/aws/api-keys`.

- **Signatures are verified.** Clients must sign with the credential's secret access key. A wrong signature is answered with `403`.
- **The request date must be current.** A request whose `x-amz-date` is missing or more than 15 minutes from the gateway's clock is refused, which also stops replayed requests.
- **JSON routes only.** The signature covers the request body, and the gateway can check it only on JSON requests. Multipart routes, such as file upload and image edits, answer `403` to AWS credentials; use an API key there.
- **The `/gateway` prefix.** Behind nginx (Docker and Kyma), clients may sign for the path including the `/gateway` prefix. No other forwarded path prefix is accepted.
- **API key first.** When a request carries both an API key and a SigV4 `Authorization` header, the API key is used.

A failed sign-in with a known API key or AWS access key id is linked to that credential and its owner is notified ([Security notifications](/guide/cockpit/security-notifications)). This covers a wrong signature, a disabled or expired key, and a request whose date is missing or too old.

## Administration endpoints

The gateway's own administration routes are listed under [API endpoints](/reference/api-endpoints#administration).

| Routes | Standalone CLI | Docker and Kyma |
|---|---|---|
| `/api/admin/api-keys`, `/aws/api-keys` | Served, no credential checked | `403`; manage keys in the Admin Cockpit |
| `/api/admin/api-config` | Served, no credential checked | Requires the admin service's key |
| `/api/admin/connections` | Served, no credential checked | Requires the admin service's key |
| `/api/admin/deployments`, `/api/admin/grounding` | Not mounted | Requires the admin service's key |

The gateway runs standalone when `GATEWAY_STANDALONE` is `true`, or when any of `UNIFIED_TOKEN_SYSTEM_ENABLED=true`, `VALKEY_URL` and `ADMIN_SERVICE_URL` is missing ([Environment variables](/reference/environment-variables#unified-authentication-system)). Because the standalone administration endpoints check no credential, anyone who can reach the gateway's port can create keys and change its configuration; keep a standalone gateway on a host and port only you can reach.

### API keys (standalone)

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/admin/api-keys` | `{"createdBy": "…", "email": "…"}`, both optional | `201` with `id` and `apiKey`; `GET /api/admin/api-keys/{id}` returns the full key again |
| `GET` | `/api/admin/api-keys` | | All keys |
| `GET` | `/api/admin/api-keys/{id}` | | One key |
| `PATCH` | `/api/admin/api-keys/{id}` | `{"key": "sk-…", "isActive": true}`, at least one field | Updated key |
| `PATCH` | `/api/admin/api-keys/{key}/revoke` | | Revokes the key given by its value |
| `POST` | `/api/admin/api-keys/revoke-by-email` | `{"email": "…"}` | Revokes every key of that email |

Setting the key value with `PATCH` is useful for a client whose key you cannot change: give the gateway key the value the client sends. The value must start with `sk-`.

```bash
curl -X PATCH http://localhost:3000/api/admin/api-keys/<id> \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-demo-client-fixed-key", "isActive": true}'
```

### AWS credentials (standalone)

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/aws/api-keys` | `{"userId": "…"}`, optional | `201` with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` |
| `GET` | `/aws/api-keys` | | All access key ids |
| `DELETE` | `/aws/api-keys/{accessKeyId}` | | Revokes the credentials |
| `PATCH` | `/aws/api-keys/set-keys` | `{"credentialId": "…", "accessKeyId": "…", "secretAccessKey": "…"}` | Sets the key pair of existing credentials, for a restore |

```bash
curl -X POST http://localhost:3000/aws/api-keys \
  -H "Content-Type: application/json" \
  -d '{"userId": "bedrock-user"}'
```

The secret access key is shown only in this response; store it then.

## SAP AI Core authentication

The gateway authenticates to SAP AI Core with the OAuth 2.0 client credentials of your SAP BTP service key: `AUTH_URL`, `CLIENT_ID` and `CLIENT_SECRET` ([Environment variables](/reference/environment-variables#sap-ai-core-integration)). It caches the access token and fetches a new one when the cached token expires within 60 seconds. Clients never see this token.
