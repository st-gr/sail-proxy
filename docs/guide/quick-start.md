---
title: Quick start
description: A first call through sail-proxy in ten minutes, with the npm CLI or with Docker.
---

# Quick start

Every path needs the service key of your SAP AI Core instance (Extended plan), downloaded from your SAP BTP subaccount as a JSON file, and an orchestration deployment in SAP AI Core.

## CLI (single user)

The npm package runs a standalone gateway on your machine. It needs Node.js 20 or later and has no Admin Cockpit.

```bash
npm install -g @st-gr/sail-proxy
sail-proxy                        # first run: interactive setup with your service key
sail-proxy run                    # start the gateway in the background
sail-proxy apikey create laptop   # prints a new API key
```

`sail-proxy config reset` runs the setup again; `sail-proxy config show` prints the current settings. The gateway listens on port 3000 unless you set another `PORT` (`sail-proxy config set PORT 3100`).

Send a first request with the key `apikey create` printed:

```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-demo-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

`sail-proxy status` shows whether the gateway is running, `sail-proxy logs gateway` shows its log and `sail-proxy stop` stops it.

## Docker (team)

Docker Compose runs the gateway together with the Admin Cockpit, nginx, single sign-on (oauth2-proxy and Dex), PostgreSQL and Valkey. It needs a Docker runtime and Node.js 20 or later.

```bash
git clone https://github.com/st-gr/sail-proxy.git
cd sail-proxy
node docker/setup-docker.js
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

`setup-docker.js` asks for your service key and the login provider: a local login with preset accounts (for evaluation), GitHub, LDAP/Active Directory or Okta. It writes the `.env` files of the services and the identity provider configuration.

Open `http://localhost:8080`, which leads to the Admin Cockpit at `http://localhost:8080/admin/app/shell/`. Sign in, create an API key under **API Keys**, and send a first request, either straight to the gateway on port 3000 or through nginx under `/gateway`:

```bash
curl -X POST http://localhost:8080/gateway/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-demo-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## SAP BTP Kyma

The Kyma deployment runs the same services as Docker on a Kyma cluster. Its setup script is `kyma/scripts/setup-kyma.js`; the [SAP BTP Kyma](/deploy/kyma) page walks through it.

## Verify the installation

### Test the API

The gateway answers `GET /health` without a key:

```bash
curl http://localhost:3000/health
```

List the models your key can use, then send a chat completion (the CLI and Docker examples above):

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-demo-your-key"
```

On a Kyma deployment the gateway sits under `/gateway` on your domain, and the key can also go in an `x-api-key` header:

```bash
curl https://sail.example.com/gateway/v1/models \
  -H "x-api-key: sk-demo-your-key"
```

### Test the Admin Cockpit

On Docker, open `http://localhost:8080/admin/app/shell/` (or your configured domain); on Kyma, `https://sail.example.com/admin/app/shell/`. Sign in through your identity provider, then create an API key and check that it appears in the list.

### Common issues

**CLI**
- **Node.js version**: Node.js 20 or later is required.
- **Network access**: the machine must reach the SAP AI Core endpoints named in your service key.
- **Service key**: the setup reads the SAP AI Core service key JSON; download it again if it is rejected.

**Docker**
- **Port conflicts**: the compose file publishes ports 8080 and 443 (nginx), 3000 (gateway) and, on loopback only, 4004 (admin), 4180 (oauth2-proxy), 5432 (PostgreSQL), 5556 (Dex) and 6379 (Valkey). Set `NGINX_PORT` to move nginx off 8080, or change the mappings in `docker/docker-compose.yml`.
- **Sign-in**: check the identity provider configuration that `setup-docker.js` wrote.
- **TLS certificates**: if you configured TLS in nginx yourself, check the certificate files and the domain.

**Kyma**
- **Cluster access**: `kubectl get nodes` must work against your Kyma cluster.
- **Pods**: `kubectl get pods -n sail-proxy` should show every pod running (`sail-proxy` is the default namespace).
- **External access**: `kubectl get virtualservice -n sail-proxy` lists the external route and its host; the cluster's IP allowlist must include your address.

## Next steps

- Connect a client, for example [Claude Code](/guide/clients/claude-code).
- Manage keys, models and users in the [Admin Cockpit](/guide/cockpit/overview).
- Compare the [deployment options](/deploy/overview).
