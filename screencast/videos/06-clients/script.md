---
video: 06-clients
title: Clients
subtitle: Claude Code, Codex, GitHub Copilot, Gemini CLI, pi, opencode, Claude Code in an OpenShell sandbox, Claude Desktop, Open WebUI with image generation and n8n, all on one gateway
kicker: sail-proxy · clients
target_seconds: 750
tighten_keep: 0.65
voice: marin
next: Overview
casts: claude, codex, gemini, pi, opencode, openshell
sections:
  - 1 | 00:05 | Claude Code | The Anthropic base URL and the key, or the launcher
  - 2 | 02:11 | Codex CLI | A provider with the OpenAI responses API
  - 3 | 02:41 | GitHub Copilot | The patch script points the extension at the gateway
  - 4 | 03:15 | Gemini CLI | The Google base URL and the key
  - 5 | 04:06 | pi | A provider with every chat model of the library
  - 6 | 04:51 | opencode | A provider on the gateway's Responses API
  - 7 | 05:37 | OpenShell sandboxes | Claude Code in an NVIDIA OpenShell sandbox, with the gateway as its only endpoint
  - 8 | 08:00 | Claude Desktop | Anthropic's desktop app in its gateway mode: chat and Code on SAP AI Core, no Claude.ai account
  - 9 | 09:27 | Open WebUI | A self-hosted chat on the gateway's OpenAI endpoint, and images from a deployed Gemini model
  - 10 | 10:44 | n8n | An AI Agent with a tool on the gateway's OpenAI credential
  - 11 | 11:46 | The usage page | Every call, by provider, model, key and user
---

## Spoken script
[00:08] Every client in this video talks to the same gateway, here the Docker Compose stack behind nginx, with one user's key. The sail-proxy CLI launches each coding agent with the gateway already set; the documentation shows the manual configuration too.

[00:24] Each agent gets the same task in its own interface: add a greet function to a small project, call it with SAP and run it. Claude Code shows the change as a diff and asks before it edits and before it runs the file.

[01:10] Then a question only the web can answer. SAP AI Core has no web search of its own, so the gateway's web search plugin runs it on Perplexity Sonar Pro on SAP AI Core. The search leaves under your SAP AI Core tenant, never from the user's machine, and carries nothing that identifies the user.

[01:43] Claude answers from the results and lists its sources.

[02:13] Codex gets a provider entry with the gateway's OpenAI base URL and the responses wire API. It edits the file, runs it and reports the output.

[02:43] GitHub Copilot is a VS Code extension. A patch script in the repository points its OpenRouter provider at the gateway; running it again reverts the patch. The Ollama provider works without a patch, through the Ollama-compatible service next to the gateway.

[03:17] Gemini CLI reads the Google base URL and an API key from the environment; the launcher sets them and selects the API key mode. It asks before the edit and before the shell command.

[04:08] pi reads the gateway's model list and writes one provider with every chat model of the library; here GPT-5 mini does the work.

[04:53] opencode gets a provider on the gateway's Responses API with GPT-5.6 Sol, the same route Codex uses.

[05:39] Claude Code also runs inside an NVIDIA OpenShell sandbox on Kubernetes, here on SAP BTP Kyma. The sandbox gets the gateway's in-cluster address as its Anthropic base URL and only a placeholder for the key: its supervisor puts the real key into requests to the gateway, and to nothing else.

[05:59] A direct call to Anthropic is refused, because the sandbox has no route of its own. Claude Code does the same task, and every call goes through the gateway, metered and governed like the rest.

[06:37] The sandbox's policy decides which programs may reach the gateway; here only Claude Code and Node.js may. Every sandbox shares the provider's key, so their usage shows up in the cockpit under that key.

[08:03] Claude Desktop has a gateway mode for companies: the gateway's Anthropic base URL and a key, and no Claude.ai account.

[08:12] The model picker lists the Claude models of your SAP AI Core deployments under their own names. A question in the chat goes through the gateway like any other call.

[08:36] The Code tab runs Claude Code on a folder. It reads index.js, adds the greet function and runs it with Node, every step through the gateway.

[09:06] It prints Hello, SAP. The app's own short requests, such as the titles of its conversations, go through the gateway too, under the same key.

[09:29] Open WebUI is a self-hosted chat interface for a whole team. Its OpenAI connection points at the gateway's OpenAI base URL with a key, and the model list comes from the gateway, so every chat model of your instance is there to pick.

[09:48] Here it runs next to the stack, and a question to GPT-5 mini goes through the gateway like any other call.

[10:16] Open WebUI makes images too. Its image engine uses the same OpenAI base URL with a deployed Gemini image model, Nano Banana. SAP AI Core's orchestration service answers with text only; images need a deployment of their own, and the gateway calls it directly, so the picture comes back on the same key.

[10:46] The workflow automation tool n8n reaches the gateway through its OpenAI, Anthropic, Gemini or AWS credential, each with the gateway's address as its base URL.

[11:11] This AI Agent has the Calculator as its tool. Asked for 1234 times 5678, it calls the tool and answers, and every model call goes through the gateway on the same key.

[11:50] Each call lands in Usage Analytics under the key that made it; a key per tool shows which tool costs what.

[12:06] The Cost tab has the cost per model, per key and per user.

[12:21] The Models tab splits the same calls by model, so you see which models were asked for and what they cost.

## On-screen cues
- 00:08 the Claude Code page of the documentation
- 00:24 Claude Code's own interface: the task, the diff, the approvals, the run and its answer, then a web search with its sources
- 02:13 the Codex page, then Codex's interface with the same task
- 02:43 the GitHub Copilot page
- 03:17 the Gemini CLI page, then Gemini CLI's interface with the same task
- 04:08 the pi page, then pi's interface with the same task
- 04:53 the opencode page, then opencode's interface with the same task
- 05:39 the OpenShell page, then Claude Code inside the sandbox: the base URL, the refused call to Anthropic, the same task
- 08:03 the Claude Desktop page of the documentation, then Claude Desktop: the model picker, a chat answer, the Code tab adding greet and running it
- 09:29 the Open WebUI page of the documentation, then Open WebUI with a question and its answer
- 10:16 Open WebUI's Image switch, a prompt and the generated picture
- 10:46 the n8n page of the documentation, then n8n's OpenAI credential with the gateway's base URL
- 11:11 the n8n workflow: chat trigger, AI Agent, OpenAI Chat Model and Calculator, the chat with the answer
- 11:50 Usage Analytics scrolled through, the Cost tab, the Models tab

## Recap and next
Nine tools, one gateway, agents in OpenShell sandboxes too, a key per tool if you like, images from a deployed model, and every call in the usage page. The overview video shows the whole picture in five minutes.

## Pronunciation
sail-proxy: sail proxy
Codex: KOH-decks
n8n = en eight en
opencode: open code
OpenShell: open shell
Kyma: KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP BTP Kyma" is "SAP BTP KEE-mah", never spelled out letter by letter
Kyma = Keema
