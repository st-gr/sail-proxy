---
video: 04-kyma
title: Deploy on SAP BTP Kyma
subtitle: Prerequisites, the setup script, the rollout and the public cockpit on your cluster
kicker: sail-proxy · deploy
target_seconds: 340
voice: marin
next: Cockpit deep dive
casts: prereqs, setup, deploy, rollout, cleanup
sections:
  - 1 | 00:05 | What you get | The Docker services on a Kyma cluster in one namespace, mesh at the edge
  - 2 | 00:47 | Prerequisites | kubectl with oidc-login, the Istio and API Gateway modules, a registry
  - 3 | 01:09 | The setup script | Every question answered once, the manifests rendered into a folder
  - 4 | 01:37 | Deploy and watch the rollout | deploy-kyma applies in order and waits for each service
  - 5 | 02:55 | The public cockpit | Your host on the cluster's domain, the same sign-in and cockpit
  - 6 | 04:09 | Clean up and next | One namespace, a handful of prefixed objects, gone in a minute
---

## Spoken script
[00:10] The Kyma deployment runs the same services as Docker Compose on an SAP BTP Kyma cluster, in one namespace: nginx and oauth2-proxy with an Istio sidecar at the edge, and behind them, without one, Dex, the gateway, the admin with the cockpit, PostgreSQL and Valkey.

[00:51] You need kubectl with the oidc-login plugin and the cluster's kubeconfig, the Istio and api-gateway modules enabled in the Kyma dashboard, and a registry that holds the images. The published images on GitHub are the default.

[01:14] The setup script asks for everything once, the namespace too if you leave the flag out. Here we pass a test namespace, so the output folder, a host of its own and every cluster-wide object are named after it, next to production. It generates new keys and asks for the sign-in provider, the registry, the IP allowlist and the database.

[01:42] deploy-kyma applies the manifests in order: the namespace, the pull secret, the mesh settings, the Istio policies, the secrets and config maps, then PostgreSQL, Valkey, Dex, oauth2-proxy, the admin, the gateway and nginx, waiting for each before the next.

[02:27] When the rollout is done, every pod is running, and a VirtualService on the cluster's gateway routes the host to nginx. The health endpoint under slash gateway answers over HTTPS, through the Istio ingress.

[03:00] The cockpit is at slash admin on that host. The sign-in page and the cockpit are the ones you saw on Docker; only the address changed. In production you connect your own identity provider instead, such as Okta or a GitHub OAuth App.

[03:22] A fresh namespace has no keys and no usage yet; the cockpit video shows what a team's usage looks like after a week.

[03:39] With a GitHub OAuth App, the sign-in page offers GitHub next to the local accounts.

[03:46] GitHub asks once to authorize the app; it reads the organization's teams and the e-mail address.

[03:56] Members of the admin team land in the cockpit as administrators. The setup only needs the OAuth App's client id and secret, with the host's slash dex slash callback as its callback.

[04:15] Removing a test deployment is one namespace and a handful of prefixed cluster-wide objects: the Dex cluster role, the Istio policies with the namespace label, the health-check policy and the streaming filter. Production's own objects stay untouched.

[04:39] Deleting the namespace takes the pods, the secrets and the database's volume claim with it. The last command checks the result: the namespace is not found.

[04:58] That is the full round trip: setup, deploy, sign in, tear down. The documentation's Kyma chapter goes further. It has the production checklist with the identity provider, the IP allowlist, storage and backups, the internal-only variant through the SAP Cloud Connector, and the upgrade path between releases.

## On-screen cues
- 00:10 the Kyma page of the documentation, the architecture table
- 00:51 terminal: kubectl, oidc-login, the modules
- 01:14 terminal: setup-kyma with --namespace, the prompts
- 01:42 terminal: deploy-kyma, the apply lines; 02:27 the pods, the VirtualService, the health answer
- 03:00 the browser on the public host: Dex, then the cockpit home and API Keys
- 03:39 the sign-in page with GitHub, GitHub's Authorize page, the cockpit signed in through GitHub (recorded on the demo stack, see the README)
- 04:15 terminal: the teardown commands
- 04:58 the Kyma page, production checklist

## Recap and next
You checked the prerequisites, answered the setup once, deployed with one script, opened the public cockpit on your cluster and removed the test namespace again. Next, the cockpit deep dive: keys, usage, quotas, governance and grounding.

## Pronunciation
sail-proxy: sail proxy
Kyma (also inside setup-kyma and deploy-kyma): KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP Kyma" is "SAP KEE-mah", never spelled out letter by letter
kubectl: KYOO-buh-SEE-tee-el, smoothly run together as one word, never spelled out letter by letter
nginx: engine x
Dex: decks
Istio: ISS-tee-oh
oidc (also inside oidc-login): O I D C, the four letters said one by one, then "login"
oidc = O I D C
