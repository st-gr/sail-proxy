# Northwind Analytics: AI Gateway Handbook

*Owner: Platform Enablement team. Audience: every engineer and analyst who calls a language model from Northwind code, notebooks or tools.*

## Why we route everything through one gateway

Northwind Analytics builds forecasting and reporting products for mid-sized retailers. Over the last two years almost every team started to use language models: the reporting squad drafts narrative summaries of sales dashboards, the data quality squad classifies messy supplier records, and the support squad answers questions about our own documentation. In the early days every team signed up with a model vendor on its own, kept keys in personal notebooks and had no idea what a month of experiments cost.

The AI gateway ends that. It is the single entry point for all model traffic at Northwind. It speaks the request formats our tools already know, holds the provider credentials itself, and gives every person their own key. That means three things for you:

1. You never handle a provider secret. Your key only works against the gateway, and it can be revoked in seconds without touching anyone else.
2. Every call is counted. The cockpit shows requests, tokens and an estimated cost per key, per model and per day.
3. The rules are the same for everybody. Rate limits, quotas and tool policies are set centrally rather than in each team's code.

## Getting a key

Ask your team lead to request a key in the gateway cockpit, or create one yourself if you have the key-holder role. Name the key after the place it lives, for example "Ingrid laptop" or "Nightly forecast job", never after a person alone. A key that lives in a CI system gets its own name and its own owner e-mail, so we know whom to call when it misbehaves.

Keys are shown exactly once. Copy the value into your password manager or your secret store right away. If you lose it, do not ask the platform team to look it up: we cannot. Create a new key and disable the old one.

## Which model to use

The gateway offers a curated list of models. The list changes as providers retire versions, so do not hard-code a model in ten places; read it from your configuration.

- **Default chat model.** A small, fast and cheap model is the right choice for classification, extraction and short summaries. Start here and move up only when the results are measurably worse.
- **Reasoning model.** Use a larger model for multi-step analysis, long reports and code review. It costs roughly ten times as much per token, so keep prompts tight.
- **Embedding model.** Use the standard small embedding model for search and clustering. Do not mix vectors from two embedding models in one index.

If you are unsure, ask in the platform channel. A five-minute conversation is cheaper than a week of the wrong model in production.

## Rate limits and quotas

Every key has a per-minute, per-hour and per-day request limit. The defaults are generous for interactive work and deliberately tight for batch jobs. When you hit a limit the gateway answers with status 429 and a `Retry-After` header; honour it and back off. Do not open five keys to get around a limit: quota profiles count per person, not per key.

Teams that need more for a planned batch run (for example the quarterly back-fill of supplier categories) open a request with the expected volume and dates. We raise the quota for that window and lower it again afterwards.

## Tools and grounding

Some models can call tools: functions you define, hosted web search or file search over a vector store. Tool use is governed by tool policies. Most teams run in *monitor* mode, which records every tool call without blocking it. The security team reviews the monitor reports monthly and moves a policy to *enforce* when a pattern is clearly unwanted, such as a tool that deletes files.

For grounded answers, upload your documents to a vector store through the gateway's files API and let the model search them. The cockpit's Grounding app shows each store, its files and the state of the indexing job. Keep stores small and focused: one store per product area works better than one store for the whole company.

## What not to send

The gateway pseudonymizes common personal data before it leaves Northwind, but that is a safety net, not a licence. Do not paste customer contracts, payroll data or access credentials into a prompt. Use synthetic or aggregated data for experiments, and talk to the data protection office before you build anything that processes personal data at scale.

## When something goes wrong

- **401 Unauthorized**: the key is wrong, disabled or expired. Check the cockpit; every failed sign-in also shows up in Security Notifications.
- **429 Too Many Requests**: you hit a rate limit or a quota. Back off and retry later.
- **5xx errors**: the provider is having a bad day. The gateway retries transient failures for you; if errors persist for more than ten minutes, post in the platform channel with the request id from the response header.

Questions about this handbook go to the Platform Enablement team at platform@example.com.
