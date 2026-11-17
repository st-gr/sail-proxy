---
video: 03-docker-compose
title: Deploy with Docker Compose
subtitle: Gateway, cockpit, nginx, Dex and PostgreSQL on one host
kicker: sail-proxy · deploy
target_seconds: 330
voice: marin
next: Deploy on SAP BTP Kyma
casts: setup, up, call
sections:
  - 1 | 00:05 | What you get | Seven services, one compose file, one sign-in for the whole team
  - 2 | 00:35 | Set up and start | The setup script asks its questions, pulls the images, compose starts the stack
  - 3 | 02:33 | Sign in | nginx, oauth2-proxy and Dex put a sign-in page in front of the cockpit
  - 4 | 03:03 | Create a key and call it | A key from the cockpit, a chat completion through nginx
  - 5 | 04:09 | Watch the usage and next steps | Every call lands in the usage charts
---

## Spoken script
[00:08] The Docker Compose deployment is the one for a team on one host. You get the gateway, the Admin Cockpit, nginx in front, single sign-on through oauth2-proxy and Dex, PostgreSQL and Valkey. Every user signs in to the cockpit and manages their own API keys; the SAP AI Core service key never leaves the server.

[00:31] The page shows them in one picture.

[00:38] First the service key. In the SAP BTP cockpit, open the service key of your SAP AI Core instance, switch to JSON and copy it. Keep it in a file only you can read; the setup script takes it from an environment variable.

[01:01] On the server you need a Docker runtime with Compose and Node 24 or later.

[01:08] In the repository folder, put the service key into the environment and start the setup script.

[01:22] It asks a few questions, each with a default. For a first try on one machine: a generated database password, the local test accounts, localhost, and the published images from the registry. At the end it shows every answer for review before it writes anything.

[01:40] Then it pulls the images; the pull is sped up here.

[01:45] You can replace the service key later in the cockpit: under Connections, add an SAP AI Core connection, test it and activate it, without running the setup again.

[02:04] Then one compose command starts the stack. The images are already pulled, so the services come up in seconds.

[02:18] Compose ps lists the seven services, and the health endpoint behind nginx answers as soon as the gateway is ready.

[02:36] Open the cockpit on port 8080. nginx sends you to the sign-in page. With the local provider this is a Dex page with an e-mail and a password; in production you connect SAP Cloud Identity Services, Okta, GitHub or LDAP instead.

[02:52] After the sign-in the cockpit opens. The side navigation on the left has the sections every user sees, and below them Settings, with more for administrators.

[03:06] Under API Keys, Create opens the page for a new key. Give it a name and the user's email; an administrator picks any user, everyone else gets their own. Create saves it. The full key stays on its page for the owner and administrators; Copy API Key puts it on the clipboard.

[03:31] The key goes into the Authorization header of an ordinary OpenAI-style request. Through nginx the gateway lives under slash gateway. The model is one of the models your SAP AI Core instance serves.

[04:02] The answer comes back in the OpenAI format, so any OpenAI client works unchanged.

[04:14] Back in the cockpit, Usage Analytics shows the call we just made, for the current month unless you pick a longer period. Further down are the requests per provider, each model's response time against its cost, and a table per provider with tokens, response time and errors.

[04:37] From here, connect your coding tools or move the stack to SAP BTP Kyma. The cockpit deep dive shows usage, quotas and tool policies in detail.

## On-screen cues
- 00:08 the Docker Compose page of the documentation: the deployment panel and the table of paths
- 00:38 the SAP BTP cockpit: the service key as JSON, Copy JSON
- 01:01 terminal: node and compose versions, cd, export, the interactive setup with its questions, the review, the pull (sped up)
- 02:04 terminal: compose up, compose ps, the health check
- 02:36 the Dex sign-in page on port 8080, the cockpit home
- 03:06 API Keys, Create, the new key page
- 03:31 terminal: the curl call and its answer
- 04:14 Usage Analytics with the new row, scrolled down through the charts
- 04:37 the deployment overview page of the documentation

## Recap and next
You ran the setup script, started the stack with one command, signed in through Dex, created a key and made a call that the cockpit accounted for. The same services run on SAP BTP Kyma; that deployment is the next video.

## Pronunciation
sail-proxy: sail proxy
nginx: engine x
Dex: decks
Kyma (also inside setup-kyma and deploy-kyma): KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP Kyma" is "SAP KEE-mah", never spelled out letter by letter
Kyma = Keema
