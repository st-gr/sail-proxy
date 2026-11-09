---
title: Troubleshooting
description: Symptoms, causes and fixes for the errors people hit most.
---

# Troubleshooting

Common issues, error messages and their fixes when using sail-proxy.

## Installation issues

### CLI installation

**Node.js version**: the CLI needs Node.js 20 or later.

```bash
nvm install 20
nvm use 20
npm install -g @st-gr/sail-proxy
```

**Permission errors during installation** (`EACCES`): install global packages into your home directory instead of using `sudo`.

```bash
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm install -g @st-gr/sail-proxy
```

**Network or proxy issues**: configure npm for your corporate proxy.

```bash
npm config set proxy http://your-proxy:port
npm config set https-proxy http://your-proxy:port
npm config set registry https://registry.npmjs.org/
```

### Docker installation

**Port conflicts** ("port is already allocated"): the compose file publishes ports 8080 and 443 (nginx), 3000 (gateway) and, on loopback only, 4004, 4180, 5432, 5556 and 6379. Find the process holding a port:

```bash
sudo lsof -i :8080 -i :3000 -i :4004 -i :5432 -i :6379
```

Stop that process, set `NGINX_PORT` to move nginx off 8080, or change the mappings in `docker/docker-compose.yml`.

**Docker permission issues** ("permission denied" on the daemon socket, Linux): add your user to the `docker` group.

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## Authentication and authorization

### API key refused

An unknown, deactivated or expired key is refused with `401`:

```json
{
  "error": {
    "message": "API key validation failed",
    "type": "authentication_error",
    "code": "invalid_api_key",
    "details": { "authType": "api_key", "supportedTypes": ["api_key", "aws_credential"] }
  }
}
```

- Keys created by sail-proxy start with `sk-`. Check that the client sends the whole key, in an `Authorization: Bearer` header or an `x-api-key` header.
- Test the key on its own:

  ```bash
  curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/v1/models
  ```

- Check the key's status and expiry under [API Keys](/guide/cockpit/api-keys) in the Admin Cockpit (Docker and Kyma), or create a new one (CLI: `sail-proxy apikey create replacement-key`).

### Rate limits and quotas

**Rate limit exceeded** (`429`), refused before the request reaches the model: a key's own limit or a user's requests-per-minute limit.

```json
{
  "error": {
    "type": "rate_limit_exceeded",
    "scope": "key",
    "dimension": "requests",
    "window": "minute",
    "limit": 60,
    "used": 61,
    "resets_at": "2025-01-28T14:23:00.000Z"
  }
}
```

`scope` is `key` (that credential's own minute, hour or day limit) or `user` (the requests-per-minute limit on the account, on top of any key limit). `resets_at` is when the window this limit tracks starts over; the response also carries a `Retry-After` header with the same information in seconds.

**Quota exceeded** (`429`): a user's spend or token limit for the day, week or month.

```json
{
  "error": {
    "type": "quota_exceeded",
    "scope": "user",
    "dimension": "spend",
    "window": "month",
    "limit": 50,
    "used": 50,
    "resets_at": "2025-02-01T00:00:00.000Z"
  }
}
```

The Admin Cockpit's [Grounding](/guide/cockpit/grounding) pages show the same refusal as "Your usage quota is used up …" when an action would start new paid work; work that already started finishes.

**Account deactivated** (`401`): an administrator has deactivated the account.

```json
{
  "error": {
    "type": "user_deactivated",
    "message": "This user account is deactivated"
  }
}
```

**Where to look**: administrators see every user's constraints and current usage in the Admin Cockpit under [Users & Quotas](/guide/cockpit/users-quotas); a user sees their own consumption on the home page.

### Model not in your entitlement

A request for a model outside the catalog an administrator assigned to you is refused with `403`:

```json
{
  "error": {
    "type": "model_not_entitled",
    "message": "Model gpt-5 is not in your entitlement catalog \"Team default\"",
    "model": "gpt-5",
    "catalog": "Team default"
  }
}
```

`GET /v1/models` lists only the models you are entitled to. Ask an administrator to add the model to your catalog.

### Tool refused by a tool policy

A request that declares or calls a tool a tool policy rejects is refused with `403` and the code `tool_not_entitled`. The message names the tools; an administrator manages the policies under **Tool Governance**.

### Sign-in problems (Docker and Kyma)

- **GitHub**: if the Dex GitHub connector restricts sign-in to an organization or team, check that you are a member.
- **Okta (SAML)**: check the SAML configuration and the user attributes Okta sends.
- **LDAP**: check the LDAP connection and the user DN format.

**Stale session**: clear the browser cookies for the domain, or restart oauth2-proxy:

```bash
docker compose -f docker/docker-compose.yml restart oauth2-proxy
```

## Connection and network issues

### SAP AI Core connectivity

The gateway signs in to SAP AI Core with the client credentials from your service key: `AUTH_URL`, `CLIENT_ID` and `CLIENT_SECRET`, with `SAP_AI_CORE_URL` as the API base URL.

```bash
# CLI: show the stored values
sail-proxy config get AUTH_URL
sail-proxy config get CLIENT_ID

# Test the token request yourself
curl -X POST "$AUTH_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"

# CLI: run the setup again with a new service key
sail-proxy config reset
```

On Docker the same variables live in `services/gateway/.env`; re-run `node docker/setup-docker.js` to replace the service key. An administrator can also set a service key in the cockpit under [Connections](/guide/cockpit/connections#sap-ai-core); while that connection is active, it overrides the environment key.

**Timeouts**: the gateway waits 120 seconds for a non-streaming and 240 seconds for a streaming model call by default. An administrator can change both in the gateway configuration (`api_config.platform.timeouts.default` and `.streaming`, in milliseconds).

```bash
# Test network connectivity to SAP AI Core
curl -v -m 30 "$AUTH_URL"

# Check whether a proxy or firewall blocks the call
curl --proxy http://your-proxy:port "$AUTH_URL"
```

### Service connectivity (Docker)

**Database**:

```bash
docker compose -f docker/docker-compose.yml ps postgres
docker compose -f docker/docker-compose.yml logs postgres
docker compose -f docker/docker-compose.yml exec postgres pg_isready
```

**Valkey**:

```bash
docker compose -f docker/docker-compose.yml ps valkey
docker compose -f docker/docker-compose.yml logs valkey
docker compose -f docker/docker-compose.yml exec valkey valkey-cli ping
```

## Model and API issues

### Model not found

List the models your key can use, and check the model renames an administrator configured (**Substitute Models** in the configuration):

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/v1/models
```

If a model should be available but is missing, it may not be deployed or enabled in SAP AI Core; ask your SAP AI Core administrator.

### Streaming

Test streaming on its own:

```bash
curl -N -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"test"}],"stream":true}' \
     http://localhost:3000/openai/v1/chat/completions
```

- Check that no proxy between client and gateway buffers streaming responses.
- OpenAI models (the GPT-4.1 and GPT-5 families) served through SAP's orchestration service send their answer in one burst at the end: the stream stays silent while the model writes, then all chunks arrive within a fraction of a second. SAP's orchestration service does this, not the gateway, whatever the chunk size. Claude models through orchestration stream while they write.
- Test the same request with streaming disabled.
- Check the gateway log for streaming errors (CLI: `sail-proxy logs gateway`).

## Kyma deployment issues

### ECONNRESET with Kyma deployments

**Symptoms**:

```
Error: socket hang up
Error: ECONNRESET
Connection was forcibly closed by the remote host
```

**Cause**: the Istio gateway in Kyma accepts only requests whose `Host` header matches the host of the `sail-proxy-streaming` VirtualService. Requests with another host name are reset before they reach the application.

**Common mistakes**:

```bash
# A localhost Host header fails
curl --header 'host: localhost' 'https://sail.example.com/gateway/...'

# A connection: Close header (PowerShell) fails
curl --header 'connection: Close' 'https://sail.example.com/gateway/...'

# A localhost URL is wrong for Kyma
curl 'http://localhost:3000/...'
```

**Fix**: use your Kyma domain without a custom `Host` header.

```bash
curl -X POST 'https://sail.example.com/gateway/anthropic/v1/messages' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: sk-demo-your-key' \
  -d '{"model": "claude-sonnet-4-5-20250929", "max_tokens": 256, "messages": [{"role": "user", "content": "test"}]}'

# For environment variables (Claude Code and others)
export ANTHROPIC_BASE_URL="https://sail.example.com/gateway/anthropic"
```

**Diagnosis**:

```bash
# 1. Find your domain and the route
kubectl get virtualservice sail-proxy-streaming -n sail-proxy
kubectl describe virtualservice sail-proxy-streaming -n sail-proxy

# 2. Test with that domain
curl 'https://sail.example.com/gateway/v1/models' -H 'x-api-key: sk-demo-your-key'

# 3. Check the VirtualService hosts
kubectl get virtualservice -n sail-proxy -o yaml | grep -A5 hosts:
```

## Performance issues

### Slow responses

```bash
# Follow the gateway log (CLI)
sail-proxy logs gateway --follow

# Resource usage
docker stats   # Docker deployment
```

- Use a faster model for simple tasks (for example `claude-haiku-4-5-20251001`).
- Check the network latency between the gateway and the SAP AI Core endpoints.

### High memory use (Docker)

```bash
docker stats --no-stream
```

Docker Compose can cap a service's memory with `mem_limit` in `docker/docker-compose.yml`.

## Error messages reference

| Status | Typical causes |
|---|---|
| **400** Bad Request | malformed JSON, missing or invalid parameters, a model the route does not serve (`model_not_supported`) |
| **401** Unauthorized | missing or invalid key (`invalid_api_key`), deactivated account (`user_deactivated`) |
| **403** Forbidden | model outside your entitlement (`model_not_entitled`), tool refused by a tool policy (`tool_not_entitled`) |
| **404** Not Found | wrong endpoint URL, unknown model or resource |
| **429** Too Many Requests | rate limit (`rate_limit_exceeded`) or quota (`quota_exceeded`) |
| **500** Internal Server Error | a gateway error, or an error from SAP AI Core |
| **502** Bad Gateway | nginx cannot reach the gateway or the admin service (Docker and Kyma) |
| **504** Gateway Timeout | the model call took longer than the timeout |

## Docker-specific issues

### Dex fails with "password authentication failed"

```
dex-1  | failed to initialize storage: failed to perform migrations:
dex-1  | creating migration table: pq: password authentication failed for user "admin_user"
```

**Cause**: existing Docker volumes hold database credentials that do not match the new configuration, typically after re-running the setup script with different PostgreSQL credentials.

**Fix** (this deletes all data in the database):

```bash
docker compose -f docker/docker-compose.yml down
docker volume rm docker_postgres_data docker_valkey_data
node docker/setup-docker.js
docker compose -f docker/docker-compose.yml up -d
```

The setup script detects this condition and offers to delete the volumes. To keep your data, re-run the setup with the same database user name and password.

### Rancher Desktop on WSL2: "EISDIR: illegal operation on a directory, read"

Rancher Desktop on WSL2 mounts single files as directories ([Rancher Desktop issue #5632](https://github.com/rancher-sandbox/rancher-desktop/issues/5632)). Run the `docker compose` commands from a Windows shell (PowerShell or CMD) instead of WSL2, or use Docker Desktop for Windows. The setup script detects this condition and shows a warning.

### 502 Bad Gateway

```bash
# Are all services running?
docker compose -f docker/docker-compose.yml ps

# Service logs
docker compose -f docker/docker-compose.yml logs nginx
docker compose -f docker/docker-compose.yml logs gateway
docker compose -f docker/docker-compose.yml logs admin
```

Services can start before their dependencies are ready: wait until `docker compose ps` shows them running (and `healthy` where a health check exists), then retry.

## Diagnostic commands

**CLI**:

```bash
sail-proxy status
sail-proxy config show
sail-proxy logs --tail 50
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/v1/models
```

**Docker**:

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail 50
docker compose -f docker/docker-compose.yml exec valkey valkey-cli ping
curl -H "Authorization: Bearer $API_KEY" http://localhost:8080/gateway/v1/models
```

## Getting help

**Collect diagnostic information**:

```bash
# CLI deployment
sail-proxy status > diagnostic_info.txt
sail-proxy config show >> diagnostic_info.txt
sail-proxy logs --tail 200 >> diagnostic_info.txt

# Docker deployment
docker compose -f docker/docker-compose.yml ps > diagnostic_info.txt
docker compose -f docker/docker-compose.yml logs --tail 200 >> diagnostic_info.txt
```

Remove secrets (API keys, passwords, service key values) before sharing diagnostic output; `sail-proxy config show` prints your configuration.

- Check the [FAQ](/guide/faq).
- Report bugs and feature requests as [GitHub issues](https://github.com/st-gr/sail-proxy/issues).
