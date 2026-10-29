---
title: Standalone CLI
description: Installing, configuring and running the standalone sail-proxy gateway from npm, with every command of the sail-proxy CLI.
---

# Standalone CLI

The npm package `@st-gr/sail-proxy` runs the gateway on your own machine, for one person. It has no Admin Cockpit and no database: API keys, AWS credentials and settings are files in a configuration directory.

Video: [Deploy with the CLI](/guide/videos#deploy-with-the-cli), with chapters.

## Prerequisites

- **Node.js 20 or later**.
- The **service key** of your SAP AI Core instance as JSON (SAP BTP cockpit → your subaccount → the AI Core service instance → Service Keys).
- An **orchestration deployment** in SAP AI Core ([SAP's guide](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-deployment-for-orchestration)). You can create it in SAP AI Launchpad, with the `DeploymentApi` of the SAP AI SDK, or with `cli-tools/sail-model-deploy.js` from the repository.
- Optional, for file search uploads: `pdftotext` from poppler (PDF) and `pandoc` (.docx, .odt, .epub, .rst, .html, .tex) on your `PATH`. PowerPoint and Excel files need no tool.

## Install and set up

```bash
npm install -g @st-gr/sail-proxy
sail-proxy
```

The first `sail-proxy` finds no configuration and starts the interactive setup: paste the service key, then confirm the resource group, the port (3000 by default) and whether to start the Ollama service with the gateway. Once a configuration exists, a bare `sail-proxy` starts the gateway instead. `sail-proxy config reset` runs the setup again.

Start the gateway, create a key and send a first request:

```bash
sail-proxy run                    # start the gateway in the background
sail-proxy apikey create laptop   # prints a new API key
```

<TerminalFrame video="02-cli" name="run" title="sail-proxy run">Start the gateway in the background, check its status and health.</TerminalFrame>

<TerminalFrame video="02-cli" name="apikey" title="sail-proxy apikey create">A new key is printed once; the list shows it masked.</TerminalFrame>

```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-demo-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The [Quick start](/guide/quick-start#verify-the-installation) has more checks.

## Commands

`sail-proxy --help` lists the commands, and every command takes `--help` too.

### Gateway

| Command | What it does |
|---|---|
| `sail-proxy run` | Start the gateway in the background (and the Ollama service, when `OLLAMA_AUTOSTART` is `true`) |
| `sail-proxy stop` | Stop the gateway (and an Ollama service it started) |
| `sail-proxy status` | Show whether the gateway runs, its health and its routes |
| `sail-proxy update` | Check npm for a newer version and install it |

### Configuration

| Command | What it does |
|---|---|
| `sail-proxy config` | Print the current settings and the available `config` commands |
| `sail-proxy config show` | Print the current settings and where `api_config.json` is |
| `sail-proxy config get <key>` | Print one setting, for example `sail-proxy config get PORT` |
| `sail-proxy config set <key> <value>` | Change one setting, for example `sail-proxy config set PORT 3100` |
| `sail-proxy config reset` | Run the setup again |

### API keys and AWS credentials

| Command | What it does |
|---|---|
| `sail-proxy apikey create [name]` | Create an API key and print it |
| `sail-proxy apikey list` | List the API keys, masked |
| `sail-proxy apikey revoke <key>` | Revoke an API key |
| `sail-proxy apikey set <id> <key>` | Give the key with this id a value of your own |
| `sail-proxy awscred create <userId>` | Create an AWS access key pair for the Bedrock-compatible routes |
| `sail-proxy awscred list` | List the AWS access keys |
| `sail-proxy awscred revoke <accessKeyId>` | Revoke an AWS access key |

Keys and credentials are saved in `apikeys.json` and `aws-credentials.json` in the configuration directory and loaded again whenever the gateway starts.

### Connections

Connections publish models from your own OpenAI, Azure OpenAI, Anthropic or AWS Bedrock account through the gateway. A model is served under the id `<upstreamModel>--<name>`, for example `gpt-4o-mini--my-openai`.

| Command | What it does |
|---|---|
| `sail-proxy connection add <name> --type <type>` | Add a connection; the type is `openai`, `azure-openai`, `anthropic` or `bedrock`. Provider settings such as `--base-url`, `--endpoint` or `--region` are options; see `sail-proxy connection add --help` |
| `sail-proxy connection list` | List the connections, whether each is active, how its secret is kept and its model ids |
| `sail-proxy connection remove <name>` | Remove a connection and its models (prints the model ids withdrawn) |
| `sail-proxy connection model add <name> <upstreamModel>` | Publish a model of the provider |
| `sail-proxy connection model remove <name> <upstreamModel>` | Withdraw a model |
| `sail-proxy connection test <name>` | Test the connection through the running gateway |
| `sail-proxy connection models <name>` | List the models the provider offers on the connection |

For example:

```bash
export MY_OPENAI_KEY=...
sail-proxy connection add my-openai --type openai --secret-env MY_OPENAI_KEY
sail-proxy connection model add my-openai gpt-4o-mini
sail-proxy connection test my-openai
```

The secret is never part of the command line. With `--secret-env NAME` the gateway reads it from that environment variable, taken from the shell that starts the gateway or from `.env` in the configuration directory. Without the option the command asks for the secret with a hidden prompt, or reads it from standard input, and keeps it in `connections.json`. After you set or change the environment variable a `--secret-env` connection uses, restart the gateway (`sail-proxy stop`, then `sail-proxy run`); a running gateway does not see the new value otherwise.

Running the interactive setup again (`sail-proxy config reset`) writes `.env` anew from the service key, so a variable you added there for `--secret-env` is gone afterwards: add it again, then restart the gateway.

Two more options of `connection add`: `--session-token-env NAME` (Bedrock with access-key auth) reads a session token from an environment variable, and `--inactive` adds the connection switched off.

Changes apply at once while the gateway runs and otherwise when it starts. If you edit `connections.json` by hand, a running gateway reads it again within 60 seconds.

OpenAI-family models are served on `/openai/v1/chat/completions`, `/openai/v1/responses` and `/openai/v1/embeddings`; Claude models (Anthropic and Bedrock connections) on `/anthropic/v1/messages`.

The standalone gateway has no price list and records no usage for connections, so every connection model is usable, and every API key of the gateway sees every connection model. SAP AI Core is not a connection here: the standalone gateway uses its own SAP service key. The [Connections app](/guide/cockpit/connections) of the Admin Cockpit covers the same providers on a Docker or Kyma installation.

### Models

| Command | What it does |
|---|---|
| `sail-proxy models list` | List the models the gateway offers |
| `sail-proxy models list --json` | The same list as JSON |

### Ollama service

The CLI includes an Ollama-compatible service on port 11434 for clients that expect an Ollama API. It uses an API key of its own, which the CLI creates and keeps up to date.

| Command | What it does |
|---|---|
| `sail-proxy ollama start` | Start the Ollama service |
| `sail-proxy ollama stop` | Stop it |
| `sail-proxy ollama status` | Show its status and version |

### Logs

`sail-proxy logs [service]` shows the last 100 lines of the `gateway` or `ollama` log, or of both (`all`, the default).

| Option | What it does |
|---|---|
| `-f`, `--follow` | Keep printing new lines |
| `-t`, `--tail <lines>` | Number of lines to show (default 100) |
| `-s`, `--since <time>` | Only lines since a time, for example `1h`, `30m`, `2d` |
| `--clear` | Delete the log files |

### File search

A standalone gateway has file search only when you give it a PostgreSQL database with pgvector: set `FILE_SEARCH_DATABASE_URL` in the `.env` of the configuration directory. All API keys of a standalone gateway share one file search owner, so they see the same files and vector stores. The standalone CLI does not read scanned PDF pages (OCR), does not transcribe pages with a vision model, and does not read legacy Word `.doc` files, whatever the machine has installed.

`sail-proxy file-search rebuild-index` builds the vector index that approximate search needs, while ingestion and searches go on, and then puts it in place; on a large database it takes minutes to hours, and Ctrl-C cancels it and keeps the current index. Run it with `--dry-run` first to see the current index, the new one, its estimated size and build time. Its options are `--ef-construction`, `--m`, `--parallel` and `--maintenance-work-mem` (see `sail-proxy file-search rebuild-index --help`). It connects with `FILE_SEARCH_MIGRATION_DATABASE_URL` when that is set (needed when the role in `FILE_SEARCH_DATABASE_URL` does not own the file search tables), else with `FILE_SEARCH_DATABASE_URL`, and needs pgvector 0.7 or later on the database server.

## Launch a coding harness

The CLI configures Codex CLI, Claude Code, opencode, Gemini CLI and pi for the gateway and starts them:

```bash
sail-proxy endpoint set local          # use the gateway on this machine (the default)
sail-proxy codex                       # or: claude, opencode, gemini, pi
sail-proxy codex --dry-run             # show what would change and run; change nothing
```

`sail-proxy endpoint set <url>` points the launchers at a remote gateway instead; `--key-env <VAR>` names an environment variable that holds its API key (preferred), `--key <value>` stores the key in the configuration directory. `sail-proxy endpoint show` prints the active endpoint. With the local endpoint, a launcher starts the gateway when it is not running. Arguments after the harness name go to the harness unchanged, except the launcher's own `--dry-run` and, for Codex, `--no-web-search`, which leaves out the gateway's web search emulation.

What each launcher writes, and how to set the tools up by hand, is on the client pages: [Codex CLI](/guide/clients/codex), [Claude Code](/guide/clients/claude-code), [opencode](/guide/clients/opencode), [Gemini CLI](/guide/clients/gemini) and [pi](/guide/clients/pi).

## Configuration directory

| Platform | Directory |
|---|---|
| Linux and macOS | `~/.sail-proxy/` |
| Windows | `%APPDATA%\sail-proxy\` |

Set `SAIL_PROXY_CONFIG_DIR` to use another directory. It holds:

| File | Content |
|---|---|
| `.env` | The settings, including the SAP AI Core credentials from the service key |
| `api_config.json` | The gateway configuration: model substitutions, streaming emulation, plugin hooks, logging, timeouts, file search |
| `apikeys.json` | The API keys |
| `aws-credentials.json` | The AWS credentials |
| `connections.json` | The connections to external providers; holds the secrets you entered at the prompt, so it is readable by you only |
| `endpoint.json` | The launchers' endpoint from `sail-proxy endpoint set`; holds the remote gateway's API key when it was set with `--key` |
| `ollama.env` | The settings of the Ollama service |
| `logs/` | The log files |

Restart the gateway (`sail-proxy stop`, then `sail-proxy run`) after editing `api_config.json`.

### Settings in `.env`

The setup writes these values; change them with `sail-proxy config set`.

| Setting | Meaning |
|---|---|
| `SAP_AI_CORE_URL` | SAP AI Core API endpoint, from the service key |
| `AUTH_URL` | OAuth token endpoint, from the service key (`/oauth/token` is appended) |
| `CLIENT_ID`, `CLIENT_SECRET` | OAuth client credentials, from the service key |
| `SAP_AI_REGION` | SAP AI Core region, derived from the service key (for example `prod.us-east-1`) |
| `SAP_AI_RESOURCE_GROUP` | Resource group (default `default`) |
| `PORT` | Gateway port (default 3000) |
| `GATEWAY_STANDALONE` | `true`: the gateway runs without an admin service |
| `OLLAMA_AUTOSTART` | `true`: `sail-proxy run` also starts the Ollama service |
| `VALIDATION_TOKEN_SECRET`, `METADATA_ENCRYPTION_KEY` | Security keys, generated by the setup |
| `RATE_LIMIT_RPM` | Optional: requests per minute per API key (commented out by default) |

The gateway signs in to SAP AI Core with the client credentials and renews its token before it expires.

## Update

```bash
sail-proxy update
```

or with npm directly: `npm outdated -g @st-gr/sail-proxy` shows whether a newer version exists, `npm update -g @st-gr/sail-proxy` installs it. See [Backup, restore and upgrade](/deploy/backup-and-upgrade) for what to keep.

## Troubleshooting

**The gateway does not start**
- `sail-proxy status` shows whether it runs and on which port; another program may hold the port. Move the gateway with `sail-proxy config set PORT 3001`.
- `sail-proxy logs gateway --tail 20` shows the last log lines.
- `sail-proxy config show` shows the settings.

**Authentication errors**
- `sail-proxy config reset` sets the service key up again.
- `sail-proxy apikey list` shows whether the key exists.
- Check that the machine reaches SAP AI Core.

**No models**
- The model list loads after the start; wait a moment.
- `sail-proxy status` and `sail-proxy logs gateway --follow` show what the gateway does.
- Restart: `sail-proxy stop && sail-proxy run`.

**Ollama timeouts**
- `sail-proxy logs ollama --tail 20` shows the Ollama service's log.
- For more detail, set `DEBUG=true` in the `.env` of the configuration directory and restart.

More symptoms and fixes are in [Troubleshooting](/guide/troubleshooting).
