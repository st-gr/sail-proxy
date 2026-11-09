---
title: OpenShell sandboxes
description: Run Claude Code in NVIDIA OpenShell agent sandboxes on Kubernetes, with the gateway as the sandboxes' only model endpoint.
---

# OpenShell sandboxes

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runs coding agents such as Claude Code in isolated sandboxes on Kubernetes. A sandbox has no network of its own: its traffic goes through its supervisor, which admits only the endpoints its policy names and only from the programs the policy lists. The agent never holds a real API key. It sees a placeholder, and the supervisor puts the real key into requests to the admitted endpoint.

With the gateway as that endpoint, every sandboxed agent runs on the models of your SAP AI Core tenant, and each request is authenticated, metered and governed like any other gateway call: usage per key, quotas, entitlements, tool policies and, when enabled, pseudonymization apply to sandboxed agents too.

On SAP BTP Kyma, the [openshell-driver-kyma](https://github.com/st-gr/openshell-driver-kyma) Helm chart installs OpenShell and connects it to an Anthropic-compatible endpoint. Its documentation covers the installation; this page covers pointing it at the gateway.

## Prerequisites

- The gateway deployed in the same cluster (see [SAP BTP Kyma](/deploy/kyma)), or reachable from it.
- A gateway API key for the sandboxes, stored in a Kubernetes Secret in OpenShell's namespace.
- The `openshell` CLI, signed in to the OpenShell gateway.

## Configuration

Point the chart's inference provider at the gateway's `/anthropic` path, by its in-cluster address (internal cluster DNS avoids the ingress and its IP allowlist), and name the Secret that holds the gateway API key:

```yaml
inferenceProvider:
  enabled: true
  type: anthropic
  baseUrl: http://gateway.<namespace>.svc.cluster.local:8080/anthropic
  modelId: claude-opus-4-7
  credentialSecret:
    name: sail-proxy-sandbox-key   # a Secret you create, holding a gateway API key
    key: api-key
```

`<namespace>` is the namespace the gateway runs in. The chart registers a provider from these values (by default named `<release>-anthropic`) and gives every sandbox `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`. Its `binaries` list names the programs that may reach the endpoint; the default lists Claude Code and Node.js.

Create a sandbox with that provider (here the release `ods`, so `ods-anthropic`; `openshell provider list` shows yours) and Claude Code's image:

```bash
openshell sandbox create --name my-agent --provider ods-anthropic \
  --from ghcr.io/st-gr/sandbox-claude:latest --detach
openshell sandbox connect my-agent
```

Inside the sandbox, `claude` starts Claude Code on the gateway. Keep the placeholder in `ANTHROPIC_API_KEY` as it is: the supervisor replaces only that placeholder with the real key. Detach with Ctrl+P Ctrl+Q; `exit` ends the sandbox.

## Check it

Inside the sandbox, without printing the key:

```bash
echo "$ANTHROPIC_BASE_URL"            # the gateway's in-cluster /anthropic address
echo "${#ANTHROPIC_API_KEY}"          # the placeholder's length, not a key
curl -sS -m 5 https://api.anthropic.com   # refused: the sandbox has no route of its own
claude -p "Reply with the single word: pong"
```

The answer appears in the Admin Cockpit's usage under the key in the Secret. A model the gateway does not serve fails with the gateway's error, for example `Model claude-opus-5-5 not found`, which shows the request went to the gateway and not to Anthropic.

## Notes

- **One key for all sandboxes**: every sandbox created with the provider uses the key in the Secret, so its usage, quotas and entitlements apply to all of them together. For separate accounting, create one provider per team or user with its own key.
- **Telemetry**: set the chart's `driver.disableClaudeTelemetry` to keep Claude Code's telemetry and update checks from trying to leave the sandbox.
