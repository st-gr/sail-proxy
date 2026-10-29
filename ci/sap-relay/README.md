# SAP AI Core relay for private CI

A small nginx reverse proxy that runs in a Kyma cluster and forwards private CI's SAP AI Core traffic, so the
CI gateway reaches SAP from the cluster instead of from the CI runner.

## Why

Calls from GitHub-hosted runners to SAP AI Core can stall: the connection and TLS handshake complete, then no
response arrives. The same calls from inside a Kyma cluster answer normally, and the runner reaches the cluster's
ingress without stalls. Routing CI's SAP calls through a relay in the cluster removes the failing leg. Production,
local CI and developer setups are not affected; they call SAP directly.

## How it works

- `https://<relay host>/<path key>/api/...` is forwarded to the SAP AI API host, `.../auth/...` to the SAP auth
  host, `.../healthz` is answered by nginx itself. Anything else is a 404. Both upstream hosts come from the SAP
  service key at render time; the relay cannot be pointed anywhere else.
- The path key is 32 random bytes and is the relay's authentication. Callers still need a valid SAP token; the
  relay stores no SAP credentials. Request URIs carry the key, so nginx writes no access log and its error log
  keeps only `crit` and worse: start-up failures and rare system or TLS failures, which can still quote the
  request line. Upstream failures (connection refused, timeouts, TLS verification) are `error` level and are
  not logged; the caller sees them as 502/504.
- CI receives the full prefix `https://<relay host>/<path key>` as the GitHub secret `SAP_RELAY_BASE`.
- Everything lives in the `sap-relay` namespace (Istio sidecar injection off, Pod Security `restricted`, pinned
  image digest, read-only root file system, no service account token), plus one AuthorizationPolicy
  `allowlist-sap-relay` in `istio-system` that admits the relay host only; every other host keeps its allowlist.
  A NetworkPolicy admits ingress only from the Istio ingress gateway and allows egress only to DNS and to public
  HTTPS (no private or link-local ranges).

This directory holds templates with placeholders only. The rendered files (relay host, path key, cluster DNS
address) are written to `ci/sap-relay/.rendered/`, which is gitignored; `render` refuses to write anywhere git
does not ignore.

## Operator commands

Prerequisites: `kubectl` pointed at the cluster, the SAP service key in `SAP_AI_CORE_SERVICE_KEY` (or a file),
the cluster's ingress domain.

```bash
node ci/sap-relay/relay.js render --domain <cluster ingress domain>   # or SAP_RELAY_DOMAIN; --key-file <f>; --resolver <ip>
node ci/sap-relay/relay.js apply    # kubectl apply the rendered manifests (deployment at 0 replicas)
node ci/sap-relay/relay.js up       # scale to 1, wait for the rollout, then check health
node ci/sap-relay/relay.js status   # prints "relay: up 200" or "relay: down <code or reason>"
node ci/sap-relay/relay.js down     # scale to 0 and wait for the pod to go
node ci/sap-relay/relay.js delete   # remove the namespace and the istio-system policy
```

`render` looks up the cluster DNS service address with kubectl unless `--resolver` is given. None of the commands
prints the path key, the relay base, the relay host or the SAP hosts; read `.rendered/relay-base.txt` directly
when the GitHub secret needs it.

## It runs only during private CI

The deployment stays at 0 replicas. It is scaled `up` right before a private CI run and `down` right after it,
so the public host answers nothing outside those windows. Removing the `SAP_RELAY_BASE` secret switches CI back
to calling SAP directly.
On every run, a workflow step replaces the relay base and the path key with `<sap-relay>` in every file the
`test-results` and `service-logs` artifacts upload, since the gateway logs full SAP URLs.

## Rotating the path key

1. `rm ci/sap-relay/.rendered/relay-base.txt`
2. `node ci/sap-relay/relay.js render --domain <cluster ingress domain>` (a new key is generated)
3. `node ci/sap-relay/relay.js apply` (while the relay is down; the next `up` starts with the new key)
4. Update the GitHub secret `SAP_RELAY_BASE` from the new `.rendered/relay-base.txt`.
