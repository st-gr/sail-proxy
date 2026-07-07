# Networking Manifests

## Standard Deployment

For standard deployments, only use:
- `apirule.yaml` - Main APIRule that exposes the nginx service publicly

## Example Configurations

The `apirule-examples.yaml` file contains **OPTIONAL** examples for advanced scenarios:

1. **Custom Domain Example** (`sail-proxy-custom-domain-example`)
   - Shows how to use a custom domain like `admin.api.yourcompany.com`
   - Requires custom Gateway with TLS certificate
   - For enterprises with their own domains

2. **Alternative Subdomain Example** (`sail-proxy-alternative-example`)
   - Shows how to expose the service on multiple subdomains
   - Useful for A/B testing or different environments

**⚠️ Important**: These examples are NOT needed for standard deployments. They will cause errors if applied without proper configuration.

## IP Allowlisting

If you configured IP allowlisting during setup:
- An AuthorizationPolicy will be generated in `manifests/istio-system/` directory
- The policy will be applied to the istio-system namespace (not sail-proxy)
- IP restrictions are enforced at the Istio ingress gateway level
- The old template-based `authorization-policy.yaml` is no longer used

**Note**: The AuthorizationPolicy uses `source.ip` for IP matching and must be deployed to the istio-system namespace to work with Kyma APIRules.

## Istio deny-by-default and the SAP Connectivity Proxy (SCC) tunnel

Kyma exposes every app through one **shared** Istio ingress gateway (pods labelled
`istio: ingressgateway`). Istio authorization has a sharp edge: as soon as **any** `AuthorizationPolicy`
with `action: ALLOW` targets a workload, that workload flips to **deny-by-default** — every request that
matches no ALLOW rule is rejected with `403 RBAC: access denied`.

The IP allowlist above creates exactly such an ALLOW on the shared gateway. That also strands any **other**
host on the gateway that lacks its own ALLOW — in particular the SAP Connectivity Proxy ("SCC tunnel"),
whose `connectivity-proxy-tunnel` Gateway binds to the same ingress pods and serves:

- `cp.<clusterSubdomain>.kyma.ondemand.com` — the mutual-TLS tunnel endpoint
- `healthcheck.cp.<clusterSubdomain>.kyma.ondemand.com` — a health endpoint SAP polls externally

Without an ALLOW for those hosts the tunnel returns 403 and on-prem connectivity breaks.

### What keeps the tunnel reachable

The setup and deploy scripts generate two **host-scoped** ALLOW policies — `allowlist-cp-tunnel` and
`allowlist-cp-healthcheck` (`manifests/istio-system/connectivity-proxy-allow.yaml`):

- They grant access **only** to the dedicated `cp.*` / `healthcheck.cp.*` hosts, which route to the
  Connectivity Proxy, **not** to `sail-proxy`. Because Istio ALLOW rules are additive and matched on the
  request `Host`/`:authority`, they **cannot** widen access to the app — `sail-proxy` stays governed solely
  by its own IP-allowlisted policy.
- The tunnel host is intentionally open to all IPs (it is authenticated by mutual-TLS at the Connectivity
  Proxy layer, not by an Istio IP allowlist). The healthcheck host is intentionally open too, but scoped to
  `GET`/`HEAD` on `/healthcheck` and `/` — because SAP's external monitor polls it from IPs outside any
  allowlist.
- Every cp host lists **both** `host` and `host:443`, because the tunnel client sends the `:authority` with
  the port and Istio matches `hosts` against that exact string.
- The cp host derives from the **cluster subdomain** (`cp.<sub>...`), never the app domain.

### When they are applied (and the safety rule)

| # | Deployment | cp tunnel at risk | How it is covered |
|---|---|---|---|
| 1 | Public + IP allowlist + istio-system changes allowed | Yes (app creates deny-by-default) | **setup-time** static file from the cluster subdomain |
| 2 | Public + IP allowlist, istio changes declined | maybe (other apps) | **deploy-time** auto-detect |
| 3 | Public, no IP allowlist | maybe (other apps) | **deploy-time** auto-detect |
| 4 | Internal-only (Cloud Connector Service Channel) | Yes (tunnel is load-bearing) | **deploy-time** auto-detect (no subdomain known at setup) |

**Safety rule (C1):** the deploy-time step adds cp ALLOWs **only when the shared gateway is already
deny-by-default** (some non-cp ALLOW already targets it). Adding the *first* ALLOW to an otherwise
unrestricted gateway would itself strand every other host — so when there is no existing allowlist it does
nothing. It also reads the cp hosts from the **live** `connectivity-proxy-tunnel` Gateway and validates each
against a strict `cp.*` pattern (rejecting wildcards or the app host), so it can never emit a policy that
defeats the IP allowlist (fail-closed).