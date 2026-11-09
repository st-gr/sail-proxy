---
video: 02-cli
title: Deploy with the CLI
subtitle: Install from npm, configure with the service key, run, create a key, call it from Claude Code
kicker: sail-proxy · deploy
target_seconds: 240
voice: marin
next: Deploy with Docker Compose
casts: install, configure, run, apikey, claude, status
sections:
  - 1 | 00:05 | Install | One npm install, one command
  - 2 | 00:41 | Configure | Paste the service key, confirm the resource group and the port
  - 3 | 01:19 | Run and check | The gateway in the background, its health and routes
  - 4 | 01:41 | Create a key | A key for your tools, saved locally
  - 5 | 02:01 | Call it from Claude Code | The launcher sets the base URL and the key
  - 6 | 02:40 | Status and next | That the gateway runs, what it logged, and where the other deployments are
---

## Spoken script
[00:08] The standalone CLI runs the gateway on your own machine, for one person. No cockpit, no database: keys and settings are files in a configuration directory.

[00:21] Install it globally from npm. The package brings the gateway and the sail-proxy command. The same command is also a launcher: it starts coding harnesses such as Claude Code and Codex, against this gateway or against a Docker Compose or SAP Kyma deployment.

[00:44] The first sail-proxy call finds no configuration and starts the setup. Paste the service key of your SAP AI Core instance, confirm the resource group and the port, and say whether the Ollama service should start with the gateway.

[01:03] The setup writes the dot env and the gateway configuration into the configuration directory; the service key never shows on screen.

[01:22] sail-proxy run starts the gateway in the background. status tells you whether it runs, where it listens and whether it is healthy, and the health endpoint answers directly.

[01:44] The command apikey create prints a new key and saves it in the configuration directory. Give it a name you will recognise; list shows only its first characters.

[02:04] The launchers configure a coding tool for the gateway and start it. sail-proxy claude sets the Anthropic base URL and the key for the session, so Claude Code talks to the models of your SAP AI Core instance.

[02:23] Here Claude Code answers one prompt in headless mode; the gateway turned the Anthropic request into a SAP AI Core request and back.

[02:43] status shows that the gateway is still healthy after the call, logs gateway shows what it did, and stop ends it. The same gateway runs for a team on Docker Compose, and for the company on SAP BTP Kyma.

## On-screen cues
- 00:08 terminal: node and npm versions
- 00:21 npm install -g
- 00:44 the setup prompts
- 01:22 run, status, curl health
- 01:44 apikey create
- 02:04 sail-proxy claude -p
- 02:43 status, logs, stop; the deployment overview page

## Recap and next
Install, set up with the service key, run, create a key, call it from Claude Code: the whole standalone path in five commands. The Docker Compose video shows the team version with the cockpit.

## Pronunciation
sail-proxy: sail proxy
Kyma (also inside setup-kyma and deploy-kyma): KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP Kyma" is "SAP KEE-mah", never spelled out letter by letter
npm: N P M
apikey: A P I key, the letters A P I and then the word key
apikey = A P I key
Ollama: oh-LAH-ma
