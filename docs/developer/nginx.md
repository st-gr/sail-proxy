---
title: The nginx image
description: How the configurable sail-proxy nginx image renders its configuration at start, which environment variables it reads, and how it decides whether a request is signed in.
---

# The nginx Image

`sail-proxy-nginx` is the edge of a Docker Compose or Kyma deployment. It routes `/gateway/` to the gateway and `/admin/` to the admin service, answers `/oauth2/` and `/dex/` from oauth2-proxy and Dex, and asks oauth2-proxy for every protected admin request whether it carries a valid session cookie. The image is built once and configured at container start, so the same image serves every environment. How it is built and pushed is described in [Docker images and build](/developer/docker-images); this page describes what is inside.

## What the Image Contains

`docker/nginx/Dockerfile` starts from `nginx:alpine` and copies in:

| File in the repository | In the image |
|------------------------|--------------|
| `docker/nginx/templates/nginx.conf.tmpl` | `/etc/nginx/templates/nginx.conf.tmpl` |
| `docker/proxy_params` | `/etc/nginx/proxy_params` |
| `docker/nginx/entrypoint.sh` | `/usr/local/bin/nginx-entrypoint.sh` (the `ENTRYPOINT`) |

The image exposes ports 8080 and 443 and has a health check against `http://localhost:${NGINX_PORT:-8080}/health`. The build context is `docker/`, as in the `nginx` service of `docker/docker-compose.yml`.

## Configuration Modes

`CONFIG_MODE` selects how the entrypoint obtains the configuration:

| Mode | Default | What the entrypoint does |
|------|---------|--------------------------|
| `template` | yes | Renders `nginx.conf` from the template with `envsubst`. Docker Compose and the Kyma deployment both use this mode. |
| `volume` | | Renders nothing. Requires `/etc/nginx/nginx.conf` to be mounted, and exits with an error if it is missing. |
| `configmap` | | Creates a minimal `nginx.conf` that includes `/etc/nginx/conf.d/*.conf`, unless one is already mounted. The real configuration is expected from ConfigMaps mounted into `conf.d`. |

Any other value stops the container. The entrypoint then runs `nginx -t` and starts nginx in the foreground; a configuration that fails the test stops the container.

The `configmap` mode is a hook for externally supplied configuration. The shipped Kyma manifest (`kyma/templates/manifests/core/nginx.yaml`) runs `CONFIG_MODE=template` and mounts no volumes.

## Environment Variables

Only the variables below are read. In `template` mode every one of them can change the rendered configuration, except where noted.

### Server

| Variable | Default | Effect |
|----------|---------|--------|
| `NGINX_PORT` | `8080` | The port nginx listens on, and the port of the health check. |
| `SERVER_NAME` | `localhost` | The `server_name` of the server block. |
| `BASE_URL` | `http://localhost:8080` | Public URL of the deployment. Used only to derive the default of `LOGOUT_REDIRECT_URL`. |
| `REQUEST_TIMEOUT_SECONDS` | `900` | `proxy_send_timeout` and `proxy_read_timeout` (in seconds) for the long-running admin and gateway routes. |
| `CONFIG_MODE` | `template` | See above. |

### Sign-out

| Variable | Default | Effect |
|----------|---------|--------|
| `LOGOUT_REDIRECT_URL` | `${BASE_URL}/admin/app/shell/` | Substituted into the template, but no directive of the current template references it. |

### Service discovery

Each upstream is `host:port`. For every service the entrypoint reads the Kubernetes-style variable first (`<NAME>_SERVICE_HOST`, `<NAME>_SERVICE_PORT`), then the short name, then the default. Kubernetes injects the first form for every service in the namespace, so on Kyma the services `oauth2-proxy`, `dex`, `admin` and `gateway` are found without any setting.

| Service | Host variable | Default | Port variable | Default |
|---------|---------------|---------|---------------|---------|
| oauth2-proxy | `OAUTH2_PROXY_SERVICE_HOST`, then `OAUTH2_PROXY_HOST` | `oauth2-proxy` | `OAUTH2_PROXY_SERVICE_PORT`, then `OAUTH2_PROXY_PORT` | `4180` |
| Dex | `DEX_SERVICE_HOST`, then `DEX_HOST` | `dex` | `DEX_SERVICE_PORT`, then `DEX_PORT` | `5556` |
| Admin service | `ADMIN_SERVICE_HOST`, then `ADMIN_HOST` | `admin` | `ADMIN_SERVICE_PORT`, then `ADMIN_PORT` | `4004` |
| Gateway | `GATEWAY_SERVICE_HOST`, then `GATEWAY_HOST` | `gateway` | `GATEWAY_SERVICE_PORT`, then `GATEWAY_PORT` | `3000` |

### oauth2-proxy paths

| Variable | Default | Effect |
|----------|---------|--------|
| `OAUTH2_AUTH_PATH` | `/oauth2/auth` | Path on oauth2-proxy that nginx calls for the cookie check. |
| `OAUTH2_SIGN_OUT_PATH` | `/oauth2/sign_out` | Path nginx serves for sign-out and forwards to oauth2-proxy. `/auth/sign_out` redirects to it. |
| `OAUTH2_PROXY_PATH` | `/oauth2` | Feeds a `$is_kyma_mode` map in the template that no directive uses. |

A variable set to an empty string counts as unset and takes its default.

## Request Authentication

Every protected location runs an `auth_request` against one of two internal locations:

- **Admin routes** (`/admin/...`, `/odata/v4/admin/...`) ask `/_cookie_auth`, which forwards the session cookie to oauth2-proxy at `OAUTH2_AUTH_PATH`. oauth2-proxy answers 202 for a valid session, with the user's identity in `X-Auth-Request-User`, `-Email`, `-Groups` and `-Preferred-Username`; nginx passes exactly these to the admin service and overwrites anything the client sent under those names. Any other answer is a 401, which sends browser routes to sign-in. nginx never decides on its own: an `Authorization: Bearer` header does not sign anyone in to the cockpit.
- **Gateway routes** (`/gateway/...`) ask `/_gateway_auth_check`. A request with an API key (`Authorization: Bearer sk-…`, `x-api-key`, `x-stainless-key` or `x-goog-api-key`) or an AWS SigV4 signature goes through to the gateway, which validates the credential itself; a CORS preflight goes through as well. Anything else falls back to the oauth2-proxy session check.

Services inside the cluster (the gateway, or an integration such as an Open WebUI function that manages keys) call the admin service directly, not through nginx, with the gateway's service JWT (HS256 under the shared `VALIDATION_TOKEN_SECRET`); the admin service verifies that token itself.

## Usage

### Docker Compose

The `nginx` service of `docker/docker-compose.yml` sets the variables explicitly and loads `docker/.env.nginx`, which `docker/setup-docker.js` writes with `BASE_URL`, `LOGOUT_REDIRECT_URL` and `REQUEST_TIMEOUT_SECONDS`. The service names `oauth2-proxy`, `dex`, `admin` and `gateway` are the Compose service names. A minimal stand-alone service looks like this:

```yaml
nginx:
  image: ghcr.io/st-gr/sail-proxy-nginx:latest
  ports:
    - "8080:8080"
  environment:
    - BASE_URL=https://sail-proxy.example.com
```

### Kubernetes and Kyma

`kyma/templates/manifests/core/nginx.yaml` runs two replicas in template mode, with the three probes on `/health` and these variables: `NGINX_PORT=8080`, `REQUEST_TIMEOUT_SECONDS=900`, `CONFIG_MODE=template`, `BASE_URL`, `OAUTH2_AUTH_PATH`, `OAUTH2_PROXY_PATH` and `OAUTH2_SIGN_OUT_PATH`. The upstreams come from the variables Kubernetes injects for the services. The setup script of Kyma replaces `BASE_URL` with the cluster's public host ([SAP BTP Kyma](/deploy/kyma)).

For another cluster, put the values in a ConfigMap and load it with `envFrom`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  BASE_URL: "https://sail-proxy.example.com"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: ghcr.io/st-gr/sail-proxy-nginx:latest
        envFrom:
        - configMapRef:
            name: nginx-config
```

To supply your own configuration, set `CONFIG_MODE=volume` and mount `nginx.conf` at `/etc/nginx/nginx.conf` (with `subPath`). `docker/nginx/k8s-example.yaml` holds a complete example of both variants.

## Trying the Image

```bash
docker build -f docker/nginx/Dockerfile -t sail-proxy-nginx:dev docker
docker run --rm -p 8080:8080 -e BASE_URL=http://localhost:8080 sail-proxy-nginx:dev
```

Without oauth2-proxy, Dex and the backends in the same network the container cannot resolve the upstreams and `nginx -t` fails, so use it inside a Compose network, or map the upstream names with `--add-host` as `docker/test-nginx-configurable.sh` does: it builds the image and checks the default, a custom and the volume configuration. In a running deployment:

```bash
docker compose exec nginx nginx -t
docker compose exec nginx cat /etc/nginx/nginx.conf     # the rendered configuration
```

## Troubleshooting

- **A setting has no effect:** in `template` mode the configuration is rendered at start, so recreate the container after changing a variable. The log lines `Processing nginx.conf template...` and `nginx.conf generated successfully` confirm the rendering.
- **`host not found in upstream`:** an upstream name does not resolve. Check the `DEBUG:` lines at the top of the log, which print the resolved oauth2-proxy and Dex host and port.
- **A script calling the cockpit API gets redirected to sign-in:** the admin routes accept only an oauth2-proxy session. Scripts and services use the gateway with an API key, or call the admin service inside the cluster with the gateway's service JWT.
