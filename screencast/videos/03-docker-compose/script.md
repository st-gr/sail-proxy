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
  - 2 | 00:46 | Set up and start | The setup script writes the configuration, compose starts the stack
  - 3 | 02:25 | Sign in | nginx, oauth2-proxy and Dex put a sign-in page in front of the cockpit
  - 4 | 03:09 | Create a key and call it | A key from the cockpit, a chat completion through nginx
  - 5 | 04:17 | Watch the usage and next steps | Every call lands in the usage charts
---

## Spoken script
[00:08] The Docker Compose deployment is the one for a team on one host. You get the gateway, the Admin Cockpit, nginx in front, single sign-on through oauth2-proxy and Dex, PostgreSQL and Valkey. Every user signs in to the cockpit and manages their own API keys; the SAP AI Core service key never leaves the server.

[00:32] The page you are looking at is the Docker Compose chapter of the documentation. It lists what the setup asks and what each service does.

[00:49] First the service key. In the SAP BTP cockpit, open the service key of your SAP AI Core instance, switch to JSON and copy it. Keep it in a file only you can read; the setup script takes it from an environment variable.

[01:08] On the server you need a Docker runtime with Compose and Node 20.

[01:18] In the repository folder, put the service key into the environment and run the setup script.

[01:30] The c-i flag is only here to keep the video short: the script takes its defaults and asks nothing, so local test accounts, localhost and locally built images. For a real deployment leave the flag out; the script then asks for the database credentials, the sign-in provider, your domain and where the images come from.

[01:55] Then one compose command starts the stack. The images are already built here, so the services come up in seconds.

[02:09] Compose ps lists the seven services, and the health endpoint behind nginx answers as soon as the gateway is ready.

[02:29] Open the cockpit on port 8080. nginx sends you to the sign-in page. With the local provider this is a Dex page with an e-mail and a password; in production you connect GitHub, LDAP or Okta instead.

[02:56] After the sign-in the cockpit opens. The side navigation on the left has the sections every user sees, and below them Settings, with more for administrators.

[03:14] Under API Keys, Create opens the page for a new key. Give it a name and the user's email; an administrator picks any user, everyone else gets their own. Create saves it. The full key stays on its page for the owner and administrators; Copy API Key puts it on the clipboard.

[03:39] The key goes into the Authorization header of an ordinary OpenAI-style request. Through nginx the gateway lives under slash gateway. The model is one of the models your SAP AI Core instance serves.

[03:54] The answer comes back in the OpenAI format, so any OpenAI client works unchanged; Anthropic and Bedrock clients have endpoints of their own.

[04:22] Back in the cockpit, Usage Analytics shows the call we just made, for the current month unless you pick a longer period. Further down are the requests per provider, each model's response time against its cost, and a table per provider with tokens, response time and errors.

[04:45] From here, connect your coding tools, set quotas and tool policies, or move the same stack to SAP BTP Kyma. The documentation site has a chapter for each.

## On-screen cues
- 00:08 the Docker Compose page of the documentation, architecture diagram in view
- 00:48 the SAP BTP cockpit: the service key as JSON, Copy JSON
- 01:08 terminal: node and compose versions, cd, export, the setup script and its output
- 01:54 terminal: compose up, compose ps, the health check
- 02:28 the Dex sign-in page on port 8080, the cockpit home
- 03:12 API Keys, Create, the new key page
- 03:37 terminal: the curl call and its answer
- 04:19 Usage Analytics with the new row, scrolled down through the charts
- 04:42 the deployment overview page of the documentation

## Recap and next
You ran the setup script, started the stack with one command, signed in through Dex, created a key and made a call that the cockpit accounted for. The same services run on SAP BTP Kyma; that deployment is the next video.

## Pronunciation
sail-proxy: sail proxy
nginx: engine x
Dex: decks
Kyma (also inside setup-kyma and deploy-kyma): KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP Kyma" is "SAP KEE-mah", never spelled out letter by letter
Kyma = Keema
