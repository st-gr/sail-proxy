---
title: SAP BTP Kyma
description: Deploying sail-proxy to an SAP BTP Kyma cluster with setup-kyma.js and deploy-kyma.js, public or internal-only, and operating the deployment.
---

# SAP BTP Kyma

The Kyma deployment runs the services of the [Docker deployment](/deploy/docker) on an SAP BTP Kyma cluster: the gateway, the admin service with the Admin Cockpit, nginx, oauth2-proxy, Dex, PostgreSQL and Valkey, in one namespace (`sail-proxy` by default). Two scripts do the work: `kyma/scripts/setup-kyma.js` asks for the configuration and renders the Kubernetes manifests, Secrets and ConfigMaps, and `kyma/scripts/deploy-kyma.js` applies them in the right order.

Video: [Deploy on SAP BTP Kyma](/guide/videos#deploy-on-sap-btp-kyma), with chapters.

## Architecture

| Service | Kind | Istio sidecar | Purpose |
|---|---|---|---|
| `nginx` | Deployment, 2 replicas | yes | Entry point behind the Istio ingress: sign-in, `/admin/` and `/gateway/` |
| `oauth2-proxy` | Deployment, 2 replicas | yes | Sign-in sessions |
| `dex` | Deployment | no | Identity provider hub |
| `gateway` | Deployment | no | The API gateway; an init container sets up the file search tables first |
| `admin` | Deployment | no | Admin service and Admin Cockpit; updates its database schema at every start |
| `postgres` | StatefulSet, 20 Gi volume | no | PostgreSQL 16 with pgvector |
| `valkey` | Deployment | no | Cache and event bus |

The deployment follows a "mesh at the edge" pattern: only the services the Istio ingress talks to, nginx and oauth2-proxy, run with an Istio sidecar; the namespace uses permissive mTLS so they can reach the services without one. The setup renders no NetworkPolicies: inside the namespace the services reach each other without restriction, and the Istio ingress routes to nginx only.

There are two ways in:

- **Public HTTPS**: Istio ingress gateway (TLS) → VirtualService on the Kyma gateway → nginx → services, with an optional IP allowlist at the ingress.
- **Internal-only**: no VirtualService; SAP Cloud Connector service channel → nginx → services.

## Prerequisites

- An SAP BTP subaccount with a Kyma runtime, and permissions to create namespaces and, for the IP allowlist, policies in `istio-system`.
- `kubectl` with the `oidc-login` plugin and the cluster's kubeconfig: see [Kyma prerequisites](/deploy/kyma-prerequisites). `setup-kyma.js` reads the live namespace with `kubectl` and stops when it cannot reach the cluster.
- **Node.js 20 or later** and **git**.
- The **service key** of your SAP AI Core instance as JSON, and an orchestration deployment in SAP AI Core.
- Access to a container registry with the sail-proxy images: the published images at `ghcr.io/st-gr`, or your own (see [Images](#images)).

### Kyma modules

The deployment needs the **istio** module (sidecars, AuthorizationPolicies, the EnvoyFilter and VirtualService for streaming) and, for public access, the **api-gateway** module with APIRule version `gateway.kyma-project.io/v2`. Enable them in the Kyma dashboard before the first deployment.

## Deploy

From the root of a checkout:

```bash
git clone https://github.com/st-gr/sail-proxy.git
cd sail-proxy
node kyma/scripts/setup-kyma.js
```

If the `inquirer` package is missing, run it as `npx -y -p inquirer@8.2.6 node kyma/scripts/setup-kyma.js`. The setup asks for:

- **Namespace**: `sail-proxy` by default (see [A second deployment](#a-second-deployment-in-another-namespace)).
- **Image version**: the published versions, when the registry lists them, or any valid tag.
- **SAP AI Core**: if your checkout's `services/gateway/.env` holds valid SAP AI Core credentials, they are offered ("Use existing SAP AI Core configuration?"); otherwise paste the service key or enter the values. `SAP_AI_CORE_SERVICE_KEY` in the environment is used instead of a prompt.
- **Database**: user and password of a new namespace; an existing namespace keeps its credentials.
- **Deployment type**: *Public HTTPS* with an optional IP allowlist, or *Internal-only* through the Cloud Connector.
- **Authentication provider**: local test accounts, GitHub, LDAP/Active Directory (external servers) or Okta SAML (see [Authentication providers](/deploy/authentication)).
- **Container registry**: GitHub Container Registry, Docker Hub, Azure Container Registry or another registry, the organization, and whether pulling needs credentials.
- **Public access** only: the APIRule host name, the cluster subdomain (`c-…` from the console URL `https://console.c-….kyma.ondemand.com`), the IP allowlist (comma-separated CIDRs; empty for none), whether the setup may manage policies in `istio-system`, and whether the cluster uses the SAP Cloud Connector tunnel.

### Going back, reviewing and running again

The interactive setup lets you correct yourself and changes nothing until you confirm.

- **Going back**: press the Up arrow on a text or password question to return to the previous question. List questions have a **← Back** choice. Questions that open an editor offer **Open editor** and **← Back**, plus **Keep current** when the question already has a value. Your earlier answers are remembered and offered as defaults.
- **Review screen**: after the last question the setup lists all answers. Choose any of them to change it, or **Write configuration**. Nothing is written, deleted, pulled or applied before you choose **Write configuration**. Secrets are never shown there; they appear as `set`, `new` or `generated`.
- **Running again**: The setup reads the generated Kyma files of the namespace and, for an existing namespace, the cluster; those values win. Values from an earlier Docker setup only fill gaps they leave. An existing namespace keeps its database credentials and generated secrets unless you choose to generate new ones. Press Enter to keep a current value. `--force` ignores the current values and starts from the defaults, as a first run would.
- **Secrets**: a secret that is already set is never shown. Secrets you type, such as a client secret, a bind password or the SAP AI Core client secret, are marked `(set — Enter keeps it)`: press Enter to keep the value or type a new one. For an existing namespace, an empty database password keeps the existing one. Secrets the setup generated (such as encryption keys and sign-in session secrets) are kept; to replace one, choose **Regenerate a key…** under **Generated keys**. The setup names what stops working before you confirm (for example, stored credentials that become unreadable, or users who are signed out). The registry user and token of a private registry are offered again too, for the same registry only. The setup prints no secret values.
- **Billing currency**: the setup asks for the currency in which you are billed for SAP AI Core. The default is USD and needs no further input. For another currency you can enter the price of a productive and of a non-productive capacity unit. Without prices, SAP cost shows as not priced until you enter the rates in the SAP Rates app of the Admin Cockpit. Changing the prices in a later setup run adds new rates valid from that day; rates you edit in the SAP Rates app are kept until you change the prices in setup again.

At the end, the setup offers to deploy. To deploy later, or again:

```bash
node kyma/scripts/deploy-kyma.js
```

<TerminalFrame video="04-kyma" name="rollout" title="kubectl get pods">After the deploy: the pods of the namespace, the VirtualService for the host and the health endpoint on the public host.</TerminalFrame>

A public deployment is then reachable at `https://<host>.<cluster-subdomain>.kyma.ondemand.com`; the examples on this site write `https://sail.example.com` for it. The Admin Cockpit is at `/admin/app/shell/`, the gateway under `/gateway/`:

```bash
curl https://sail.example.com/gateway/v1/models -H "x-api-key: sk-demo-your-key"
```

The [Quick start](/guide/quick-start#verify-the-installation) has more checks. Clients must use exactly this host name: the Istio ingress resets connections with another `Host` header (see [ECONNRESET with Kyma deployments](/guide/troubleshooting#econnreset-with-kyma-deployments)).

### Setup options

```
node kyma/scripts/setup-kyma.js [options]

  --help, -h        Show the help text
  --version, -v     Show the version
  --force, -f       Overwrite existing manifests
  --ci              Use defaults without prompts: local test accounts, internal-only deployment
  --namespace <ns>  Namespace to deploy into (default sail-proxy; asked interactively unless --ci)
```

`deploy-kyma.js` takes `--namespace <ns>` too; without it, it uses the namespace the setup handed over, else `sail-proxy`.

### What the setup writes

For the default namespace, the rendered manifests go to `kyma/manifests/` and the Secrets and ConfigMaps to `kyma/templates/secrets/` and `kyma/templates/configmaps/`; for any other namespace, to `kyma/deployments/<ns>/`. All of these are ignored by git: they contain the deployment's secrets. The templates they are rendered from are in `kyma/templates/manifests/`.

| Rendered | Content |
|---|---|
| Secrets | `postgres-env`, `gateway-env`, `gateway-migration-env`, `admin-env`, `oauth2-proxy-secrets`, and `registry-secret` for a private registry |
| ConfigMaps | `nginx-conf`, `dex-config`, `dex-saml-cert` (Okta only), `gateway-config`, `admin-config`, `admin-api-config` (the admin's gateway configuration, from `services/admin/api_config.json`) |
| Manifests | `core/` (namespace, PostgreSQL, Valkey, gateway, admin, nginx), `auth/` (Dex with its RBAC, oauth2-proxy), `networking/` for a public deployment (streaming VirtualService and EnvoyFilter, PeerAuthentication, DestinationRules, health check protection; the APIRule templates are rendered and removed again, the VirtualService takes all traffic), `istio-system/` (IP allowlist policies) |

To prepare the nginx configuration, the setup runs `docker/setup-docker.js --config` with the answers given above (so it asks nothing again; the output shows the configuration as `<configuration>`), then restores every local file that run wrote (`services/*/.env`, `docker/.env*`, `docker/dex.config.yaml`, the Compose files, `docker/okta-saml-ca.pem`) and keeps the local Docker volumes, so a local Docker or development setup is unaffected. The Kyma configuration is built from the `.env.sample` files and your answers; nothing else from your local `.env` files reaches it, apart from the SAP AI Core values offered above (`SAP_AI_CORE_URL`, `AUTH_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `SAP_AI_REGION`, `SAP_AI_RESOURCE_GROUP`).

### What the deploy does

`deploy-kyma.js` applies, in this order: the namespace with Istio injection enabled; the image pull secret, if needed; the PeerAuthentication and DestinationRules; the `istio-system` policies (it removes its own old allowlist policies first); the Secrets and ConfigMaps; then PostgreSQL and Valkey, Dex, oauth2-proxy, the admin service, the gateway and nginx, each waited for before the next; and finally the networking manifests. It then shows the pods and checks the `sail-proxy-streaming` VirtualService. Only when that VirtualService is missing does it look for an APIRule named `sail-proxy` (from an older render), show its status, and restart the edge services when the APIRule reports that their Istio sidecars are missing.

## Re-running setup: keys and database credentials

Five keys protect data a running deployment has stored: `VALIDATION_TOKEN_SECRET`, `METADATA_ENCRYPTION_KEY`, `AWS_SECRET_ENCRYPTION_KEY` (stored AWS credentials), `SIEM_CREDENTIAL_KEY` (stored SIEM sink credentials) and `CONNECTION_CREDENTIAL_KEY` (stored connection credentials). New keys would make that data unreadable. So right after the namespace is chosen, the setup reads them from the live namespace (`kubectl get` only; nothing on the cluster changes and the values are never printed) and reuses them:

| Namespace | Keys |
|---|---|
| Does not exist yet (the API server answers NotFound for exactly this namespace) | Generated. The setup first shows the kube context and cluster server it checked and asks for confirmation (default: no). |
| Exists | Taken from the live `admin-env` and `gateway-env` Secrets (`SIEM_CREDENTIAL_KEY` from `admin-env`, or from the `admin-config` ConfigMap of a deployment set up before it moved into the Secret). A key not found there is generated. |
| `kubectl` cannot tell (wrong or missing context, missing `oidc-login` plugin, no access) or cannot read the Secrets | The setup stops. Point `kubectl` at the cluster and run it again. |

`--ci` asks nothing. It generates new keys only when the cluster is positively unreachable (`kubectl` not installed, or the connection to the API server fails or is refused), carries the keys over when the namespace is reachable, and stops in every other case. The setup also stops when the live `admin-env` and `gateway-env` disagree on a shared key, or `admin-env` and `admin-config` on `SIEM_CREDENTIAL_KEY`. If the namespace exists but its `admin-env` or `gateway-env` Secret is gone, the keys it held would be generated anew: the setup asks first (default: no), and `--ci` stops.

The PostgreSQL credentials are carried over the same way, because the PostgreSQL volume keeps the user and password it was created with. They are read from `postgres-env`, `admin-env` and `gateway-migration-env`, with the file search runtime role from `gateway-env`, and rendered unchanged into every Secret that uses them. The database prompts then default to the existing user, and an empty password keeps the existing one. Typing a different user or password stops the setup, since the volume cannot accept it, and so do live Secrets that disagree on the credentials. `--ci` uses the existing credentials.

**The deploy checks again.** `deploy-kyma.js` compares the render with the live namespace before it applies anything, because an old render, one made against another context, or a hand edit would otherwise go through. It reads the live namespace with `kubectl get` only and compares the four keys, `POSTGRES_USER` and `POSTGRES_PASSWORD`, the admin's database URL and password, and the migration and file search runtime database URLs. The deploy is refused if a live value exists and differs, or exists and is missing from the render (`kubectl apply` would remove it); the message names the keys, never the values. A key the live namespace does not have yet may be introduced, and a namespace the API server reports as not found is deployed as new. Any other `kubectl` failure refuses the deploy, also with `--ci`.

**Rotating a key or the database password is not supported.** The setup always carries the live values over, and the deploy refuses to change them. Stored data is encrypted with the old keys, and no tool re-encrypts it; the PostgreSQL volume keeps the password it was created with.

## A second deployment in another namespace

The setup asks for the namespace first ("Kubernetes namespace to deploy into"), or takes it from `--namespace`, so a second deployment, for example a test instance, can run on the same cluster as production:

```bash
node kyma/scripts/setup-kyma.js --namespace sail-proxy-test
node kyma/scripts/deploy-kyma.js --namespace sail-proxy-test
```

For a namespace other than `sail-proxy` (the default keeps its paths and names):

- **Rendered files** go to `kyma/deployments/<ns>/manifests/` and `kyma/deployments/<ns>/templates/{secrets,configmaps}/`. `deploy-kyma.js --namespace <ns>` applies that folder only, and refuses to run if its `manifests/core/namespace.yaml` names a different namespace.
- **Objects outside the namespace** get a `<ns>-` prefix, so they cannot overwrite production's:

  | Object | `sail-proxy` | Other namespace |
  |---|---|---|
  | ClusterRole and ClusterRoleBinding (Dex storage) | `sail-proxy-dex` | `<ns>-dex` |
  | `istio-system` AuthorizationPolicy, IP allowlist | `allowlist-<host>` | `<ns>-allowlist-<host>` (its effect is shared, see below) |
  | `istio-system` AuthorizationPolicy, Cloud Connector tunnel | `allowlist-cp-tunnel`, `allowlist-cp-healthcheck` | `<ns>-allowlist-cp-tunnel`, `<ns>-allowlist-cp-healthcheck` |
  | `istio-system` AuthorizationPolicy, health check deny | `health-check-external-deny` | `<ns>-health-check-external-deny` |
  | `istio-system` EnvoyFilter | `streaming-timeouts` | `<ns>-streaming-timeouts` |

  The `istio-system` objects of another namespace also carry the label `sail-proxy/namespace: <ns>`. The deploy's allowlist cleanup deletes only its own namespace's policies.
- **The IP allowlist is not isolated by any name.** Its AuthorizationPolicy is an ALLOW on the shared Istio ingress gateway, and any ALLOW there makes the gateway deny by default every host that no ALLOW matches. If the gateway already has ALLOW policies (for example production's allowlist), the second namespace **needs** an allowlist of its own, or its host is refused for everyone. If it has none, adding one makes every other host on the cluster, production included, deny by default. The setup reads the `istio-system` policies (read-only) and shows which case applies.
- **The APIRule host** defaults to the namespace name and may not be `sail-proxy`: two VirtualServices for one host on the shared `kyma-gateway` would split production's traffic.
- **File search in S3**: the second deployment has its own file search database, so its S3 prefix (or bucket) must differ from production's (see [File storage for file_search](/deploy/file-storage)).
- **External identity providers** (GitHub OAuth App, Okta SAML application) must allow the second host's callback, `https://<host>.<cluster-subdomain>.kyma.ondemand.com/dex/callback`. Dex and its oauth2-proxy client run per namespace and need no change.

Both deployments share, untouched, the `kyma-system/kyma-gateway` Gateway and Dex's `dex.coreos.com` CustomResourceDefinitions (cluster-scoped; each namespace stores its own objects in them).

Removing a second deployment:

```bash
kubectl delete namespace sail-proxy-test
kubectl delete clusterrole,clusterrolebinding sail-proxy-test-dex
kubectl delete authorizationpolicy -n istio-system -l sail-proxy/namespace=sail-proxy-test
kubectl delete authorizationpolicy -n istio-system sail-proxy-test-health-check-external-deny
kubectl delete envoyfilter -n istio-system sail-proxy-test-streaming-timeouts
```

## Deployment types

### Public HTTPS

A VirtualService, `sail-proxy-streaming`, on the Kyma gateway (`kyma-system/kyma-gateway`) routes `https://<host>.<cluster-subdomain>.kyma.ondemand.com` to nginx, with TLS terminated at the Istio ingress; for the streaming routes it sets a long timeout and no retries. Sign-in runs through Dex and oauth2-proxy. With an IP allowlist, an Istio AuthorizationPolicy in `istio-system` admits only the listed addresses at the ingress.

The IP allowlist and the policies that keep the Cloud Connector tunnel reachable are described in [IP allowlist and Istio policies](#ip-allowlist-and-istio-policies).

### Internal-only

No VirtualService: the services stay inside the cluster, and the SAP Cloud Connector reaches nginx through a service channel. Configure the service channel with:

- **Target**: `nginx:8080`
- **Local port**: `22001` (or one of your choice)

The cockpit is then at `http://localhost:22001/admin/` on the Cloud Connector host. `--ci` sets up this type.

## Images

The pods use `<registry>/<organization>/sail-proxy-gateway`, `sail-proxy-admin` and `sail-proxy-nginx` with the version you chose; the other services use public images (`pgvector/pgvector:pg16-trixie`, `valkey/valkey:8`, Dex v2.37.0, oauth2-proxy v7.6.0). The nginx image is the one Docker uses; on Kyma it renders the same configuration template.

- **Public registries** (GitHub Container Registry, Docker Hub) need no pull secret for public images. For a private registry, the setup asks for the registry user and token and saves them as the `registry-secret` image pull secret with the other generated Secrets, which the deploy applies; the printed deploy command never contains the token; without them it prints the `kubectl create secret docker-registry` command to run yourself.
- **Your own images**: build and push them with the repository's scripts (`pnpm docker:build`, `pnpm docker:push`, or `pnpm docker:buildx` for multi-architecture images), with `DOCKER_REGISTRY`, `DOCKER_ORGANIZATION` and `DOCKER_TAG` set to your registry, organization and version, then give the same values to the setup.
- Pin a version tag, not `latest`.

## Verify

```bash
kubectl -n sail-proxy get pods
kubectl -n sail-proxy get virtualservice
```

nginx and oauth2-proxy show `2/2` containers (app and sidecar); dex, gateway, admin, postgres and valkey show `1/1`. The VirtualService `sail-proxy-streaming` lists your host under `HOSTS`.

## Operate

```bash
# Logs
kubectl -n sail-proxy logs -f deployment/gateway
kubectl -n sail-proxy logs -l app=admin --tail=100 -f

# Resource use
kubectl -n sail-proxy top pods

# Restart after a configuration change
kubectl -n sail-proxy rollout restart deployment/gateway

# More nginx replicas
kubectl -n sail-proxy scale deployment/nginx --replicas=3

# Roll back a deployment to its previous revision
kubectl -n sail-proxy rollout undo deployment/gateway
```

Change Secrets and ConfigMaps by running `setup-kyma.js` and `deploy-kyma.js` again rather than editing them in the cluster: a later deploy renders them from your answers again and would undo a hand edit. The optional `gateway-s3-env` Secret is the exception: you create it by hand, and the setup keeps it (see [File storage for file_search](/deploy/file-storage)).

Backups and upgrades are described in [Database migration](/deploy/database-migration) and [Backup, restore and upgrade](/deploy/backup-and-upgrade).

## Security

- **Secrets**: credentials and keys are Kubernetes Secrets; ConfigMaps hold non-sensitive configuration only; the images contain no secrets.
- **Network**: the setup renders no NetworkPolicies, so the namespace's services are not isolated from each other; TLS ends at the Istio ingress; the optional IP allowlist acts at the ingress.
- **Health endpoints**: nginx answers `/admin/api/health` only to requests from private networks, so outside the cluster it returns 403. `/gateway/health` is public for monitoring and reports only that the gateway is running.
- **Sign-in**: oauth2-proxy keeps the session in an HttpOnly, Secure cookie; roles come from the identity provider's groups (see [Authentication providers](/deploy/authentication#roles)).
- **Local test accounts**: never use the local provider (and so not `--ci`) for a public deployment.

## IP allowlist and Istio policies

The IP allowlist is an Istio `AuthorizationPolicy` in the `istio-system` namespace, enforced at the shared Istio ingress gateway (pods labelled `istio: ingressgateway`) before a request reaches nginx. It exists only for a public deployment. The setup asks for it at "IP allowlist" as comma-separated IPv4 CIDRs, for example `203.0.113.0/24,203.0.113.12/32`; an empty answer means no restriction. It then asks "Allow deployment to manage IP restrictions in istio-system namespace?". If you answer no, the setup warns that the restrictions will not be enforced and drops the allowlist: anyone can reach the deployment.

With an allowlist, the setup renders the policy into `kyma/manifests/istio-system/` (`kyma/deployments/<ns>/manifests/istio-system/` for another namespace) and the deploy applies it. The policy is named `allowlist-<host>`, where `<host>` is the first label of the APIRule host. It allows requests for the deployment's host, with any of the methods GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS, whose `source.ip` is in your list. Each deploy first deletes the earlier allowlist policies of its own namespace and applies the new ones, so to change the list, run `setup-kyma.js` and `deploy-kyma.js` again. List the policies with:

```bash
kubectl -n istio-system get authorizationpolicy
```

A client outside the list receives `403 RBAC: access denied`.

### Deny by default

Kyma exposes every application through one shared ingress gateway. In Istio, as soon as any `AuthorizationPolicy` with `action: ALLOW` selects a workload, that workload denies every request that no ALLOW rule matches. The allowlist is such a policy, so it also blocks every other host on the gateway that has no ALLOW of its own. The same happens when another application on the cluster already has one. For a second deployment in another namespace, see [A second deployment](#a-second-deployment-in-another-namespace).

### The Cloud Connector tunnel

The SAP Connectivity Proxy, which carries the Cloud Connector tunnel, is the notable host on the gateway. Its `connectivity-proxy-tunnel` Gateway in `kyma-system` serves two hosts:

- `cp.<cluster-subdomain>.kyma.ondemand.com`, the tunnel endpoint
- `healthcheck.cp.<cluster-subdomain>.kyma.ondemand.com`, a health endpoint

Without an ALLOW for them the tunnel answers 403 and on-premise connectivity breaks. The setup and the deploy therefore create two ALLOW policies, `allowlist-cp-tunnel` and `allowlist-cp-healthcheck`:

- They match the `cp.*` and `healthcheck.cp.*` hosts only, which route to the Connectivity Proxy and not to sail-proxy. ALLOW policies match on the request host, so they cannot open the sail-proxy host: it stays governed by its own allowlist.
- The tunnel host is open to every client; the Connectivity Proxy authenticates it, not an IP list. The health host is open as well, but only for `GET` and `HEAD` on `/healthcheck` and `/`.
- Each policy lists every host twice, as `host` and as `host:443`, because the tunnel client sends the port with the host and Istio compares the exact string.
- The hosts derive from the cluster subdomain, never from the app's host.

The setup asks "Does this cluster use the SAP Cloud Connector / Connectivity Proxy tunnel?" (default yes). With no, neither the setup nor the deploy creates these policies.

| Deployment | Created by | Hosts taken from |
|---|---|---|
| Public with an IP allowlist | the setup, together with the allowlist | the cluster subdomain you entered |
| Public without allowlist, or internal-only | the deploy, only when needed (below) | the live `connectivity-proxy-tunnel` Gateway |

The deploy adds the policies only when the gateway is already deny-by-default, that is, when some other ALLOW policy selects it. Adding the first ALLOW to an unrestricted gateway would block every other host, so on an unrestricted gateway it does nothing. It also does nothing when the cluster has no `connectivity-proxy-tunnel` Gateway. It accepts only hosts that match `cp.<name>.kyma.ondemand.com` or `healthcheck.cp.<name>.kyma.ondemand.com`: a wildcard or the app's own host is never turned into an ALLOW.

## Production checklist

- [ ] The istio and api-gateway modules are enabled.
- [ ] The images are pinned to a version tag; a private registry has its pull secret.
- [ ] A real identity provider (GitHub, LDAP or Okta) is configured, not the local test accounts.
- [ ] Public deployments have an IP allowlist, or the deployment is internal-only.
- [ ] The PostgreSQL volume (20 Gi by default) is large enough, with room for file search content.
- [ ] Database backups run regularly, and the Secrets are exported (see [Backup, restore and upgrade](/deploy/backup-and-upgrade)).
- [ ] With S3 file storage, the bucket has its own backup or versioning.
- [ ] A restore has been tested in a test namespace.

## Troubleshooting

**A pod does not start**

```bash
kubectl -n sail-proxy describe pod <pod-name>
kubectl -n sail-proxy logs <pod-name>
```

**ImagePullBackOff**: the image, the tag or the pull secret is wrong.

```bash
kubectl -n sail-proxy get secret registry-secret
kubectl -n sail-proxy describe pod <pod-name> | grep -A3 "Failed"
```

**The host does not answer**

```bash
kubectl -n sail-proxy get virtualservice sail-proxy-streaming
kubectl get virtualservice,apirule -A | grep <host>
```

Check that no other VirtualService or APIRule on the cluster uses the same host.

**Sign-in fails**

```bash
kubectl -n sail-proxy logs deployment/dex
kubectl -n sail-proxy logs deployment/oauth2-proxy
```

**403 `RBAC: access denied` or no connection from outside**: your address is not in the IP allowlist, or another ALLOW policy made the ingress deny by default (see [IP allowlist and Istio policies](#ip-allowlist-and-istio-policies)).

```bash
kubectl -n istio-system get authorizationpolicy
```

**504 Gateway Timeout on long requests**: nginx allows 900 seconds per request. The streaming EnvoyFilter switches Envoy's stream idle timeout off and the streaming VirtualService sets long route timeouts; check that both exist:

```bash
kubectl -n istio-system get envoyfilter
kubectl -n sail-proxy get virtualservice sail-proxy-streaming
```

**ECONNRESET**: see [ECONNRESET with Kyma deployments](/guide/troubleshooting#econnreset-with-kyma-deployments).

## Version requirements

- An api-gateway module that serves APIRule `gateway.kyma-project.io/v2`, and the istio module.
- PostgreSQL 16 with pgvector (the `pgvector/pgvector:pg16-trixie` image of the manifests) and Valkey 8.
