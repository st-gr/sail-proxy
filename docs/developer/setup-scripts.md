---
title: Setup scripts internals
description: How setup-docker.js and setup-kyma.js ask, replay, review, load current values and write, and how their golden and pty tests work.
---

# Setup scripts internals

`docker/setup-docker.js` and `kyma/scripts/setup-kyma.js` share the engine in `docker/setup-flow/`. The user-facing behaviour is described in [Docker](/deploy/docker#going-back-reviewing-and-running-again) and [Kyma](/deploy/kyma#going-back-reviewing-and-running-again). This page covers how it works and how to change it.

## Constraints

- `--ci` and `--config` runs keep their output files. CI runs `setup-docker.js --ci --force`; the golden tests pin it.
- Key handling uses readline `keypress` key names only (`key.name === 'up'`), never raw escape sequences, so Windows Terminal, PowerShell, cmd, Linux and macOS behave the same.
- inquirer stays at 8.2.6. The engine takes the loaded `inquirer` instance and subclasses prompts from `inquirer.prompt.prompts`; it never requires `inquirer/…` paths.
- Nothing changes state before the review screen's **Write configuration**.
- No secret value is printed by any path.

## Files

| File | Role |
|---|---|
| `docker/setup-flow/session.js` | `PromptSession`: ids, memory, replay, `once`, review |
| `docker/setup-flow/prompts.js` | Back-aware prompt types, `← Back` list choice, editor choices |
| `docker/setup-flow/secrets.js` | `askSecret`, `askKeyRegeneration`, `KEY_WARNINGS`, `mask` |
| `docker/setup-flow/billing.js` | Billing questions and the admin env lines |
| `docker/setup-flow/docker-config.js` | Reads the files a Docker setup wrote (shared with setup-kyma) |

## The session replay model

Each script has a `collectAnswers(session)` function that asks every question through `session.ask(...)`, a drop-in for `inquirer.prompt`. `session.run(collect)` calls it, shows the review screen, and calls it again after Back or a jump.

- Every question gets an id (`question.id`, default `name`; a repeated id becomes `id#2`). The session remembers the answer per id.
- Back (Up arrow, `← Back`) throws a `Replay` signal. `run` catches it and re-runs `collect` with a target id. Questions before the target are answered silently from memory; the target and everything after are shown again with the remembered answer as the default.
- The first question has no Back.
- The review screen lists the answers of the last complete run. Choosing one replays from that id. **Write configuration** returns the collected answers.
- A helper step that should not be listed passes `review: false`; its owner adds one entry with `session.record({ id, label, value, display })`. `display` must never contain a secret.
- Branches work because memory is keyed by id: switching a branch and back finds the earlier answers.
- `session.resetExcept(ids)` forgets every remembered answer, starting value (what the review's `(changed)` compares against) and generated value except those of `ids`. setup-kyma calls it with `['namespace']` when the namespace answer differs from the one the answers were given for, because `session.current` is reloaded per namespace and remembered answers would otherwise beat the new namespace's current values.
- `session.forget(ids)` forgets only `ids`. setup-kyma's `getContainerConfig` reads the namespace's `registry-secret.yaml` (`readRegistrySecret`) and puts its login into `session.current` (`dockerUsername`, `dockerPassword`) only when its server is the registry just chosen; a login answered for another registry before a Back or review jump is forgotten, so it is never offered for a different registry. `--force` reads nothing.

### The replay signal must not be swallowed

`Replay` is a thrown non-`Error` object. A blanket `try { … } catch {}` around a `session.ask` call in collect code swallows it, and Back then silently does nothing. Catch narrowly, or rethrow what you do not handle. Other errors (Ctrl-C, aborts) pass through `run` unchanged.

### `once()` for read-only probes

Collect runs again on every replay, so work that is slow or has side effects on the screen must not run inline. Use `session.once(key, fn)` for read-only probes: cluster reads, Docker volume listing, registry tag lookups, metadata fetches. The result of the first call is returned on later replays (a failed call is not cached). Make the key include everything the result depends on, for example `saml-metadata:${url}`. `once` is for reading only; anything that changes state belongs in `applyAnswers`.

## Collect and apply

Each script splits into:

- `collectAnswers(session)` for interactive runs, and `unattendedAnswers()` for `--ci`/`--config`. Both return the same answers object.
- `applyAnswers(answers)`, which does all writing.

What counts as a write, and so belongs in apply: writing or deleting files, creating backups, `docker login`, pulling images, deleting Docker volumes, `kubectl create/apply`, creating a namespace. Reading files, `kubectl get`, listing volumes and fetching metadata are reads and may run in collect through `once`.

## Adding a question

1. In `collectAnswers`, call `session.ask({ type, name, id, message, default, validate })`. Give it a stable `id` if its `name` is not unique.
2. Put the answer on the answers object and use it in `applyAnswers` and, for `--ci`, set the same field in `unattendedAnswers` to today's default.
3. For a value that was written to a file by an earlier run, add it to `loadCurrentValues` under the question id, validated by the same function the question uses. An invalid stored value is dropped, and the question falls back to its default.
4. For a secret use `askSecret` and list it in `KEY_WARNINGS` with the consequence of replacing it. Verify the consequence in the consuming code before writing it.
5. Add a scripted test in `setup-docker-interactive.test.ts` or `kyma-interactive.test.ts`, a re-run test in the `*-rerun` suites, and extend the golden only if the `--ci` output is meant to change.

## Current values and precedence

An interactive run without `--force` seeds `session.current` (id to value) and, separately, a secrets map that never enters the session. With `--force` both are empty, so it starts from today's defaults and overwrites what exists. A question's default is the first of: the remembered answer in this session, the current value, the question's own default.

**Docker** (`loadCurrentValues`, `loadCurrentSecrets`) reads only files the script wrote: `docker/.env`, `.env.auth`, `.env.nginx`, `.env.docker`, `dex.config.yaml`, `.env.filesearch-runtime` and the admin `.env`. Template placeholders count as unset. Image mode comes from `.env.docker` (`usesImageRegistry` in `docker-config.js`): registry when it holds the `DOCKER_IMAGE_MODE=registry` marker that interactive registry runs write, or a registry or organization other than `ghcr.io`/`st-gr`, else local builds. The compose override file is not read. A registry run made before the marker existed against `ghcr.io/st-gr` therefore reads as local builds. The marker is not written by `--ci`, which keeps the golden byte-identical.

The delete-volumes question (asked only when Docker volumes exist) defaults to No when the database user equals the current one and the password equals the current secret (kept, not entered anew or regenerated), and to Yes otherwise, so an Enter-only re-run keeps the data.

**Kyma** (`loadCurrentValues` in `setup-kyma.js`) takes, for each value, the first valid source:

1. the namespace's generated Kyma files (rendered Secrets, the Dex ConfigMap, the manifests),
2. the live cluster (the Secrets `readExistingKeys` already fetches; no extra `kubectl` calls),
3. Docker's files, which only fill gaps the first two leave.

An existing namespace never offers `POSTGRES_USER` from these sources, because the database volume only accepts the live user. A namespace that does not exist yet keeps today's behaviour (new encryption keys and database password) except that OAuth2 proxy secrets carry over from the generated files.

## Secrets

Three mechanisms handle secrets on a re-run:

- `askSecret` offers Keep current / Enter new (and Generate new only when the caller passes `generate`) when a current value exists, else a password question. Today only setup-docker's database password uses it, without `generate`. setup-kyma does not use it; for an existing namespace its database password question keeps the live password on an empty answer.
- Any other `password` or `secret: true` question with a current value (provider secrets such as the GitHub client secret or the LDAP bind password, the SAP AI Core client secret) gets the message suffix `(set — Enter keeps it)` from `PromptSession.askOne`: the value never reaches the prompt as a default, and an empty answer keeps it.
- Generated secrets (encryption keys, OAuth2 proxy secrets, the file search runtime password, a generated database password) are kept on a re-run unless the user picks them in `askKeyRegeneration` (**Generated keys** → **Regenerate a key…**), which shows the `KEY_WARNINGS` text before each confirmation. The review shows `set`, `new` or `generated`. Completion summaries go through `mask`. The registry token is never printed: setup-kyma writes it into the namespace's `templates/secrets/registry-secret.yaml` (`kyma/scripts/registry-secret.js`, owner-only where the OS supports it), the printed deploy command is plain `node kyma/scripts/deploy-kyma.js [--namespace <ns>]`, and deploy-kyma applies that file with `kubectl apply -f`. A `KYMA_DEPLOY_CONFIG` that still carries `dockerPassword` (older setups, the screencast) is written to the same file first, so the token never reaches a kubectl command line.

## Billing

`askBilling` asks for the currency (three letters, default the stored one or USD). For a currency other than USD it asks whether to enter the productive and non-productive capacity-unit prices (positive numbers below 10000, up to six decimals: the admin stores them as `Decimal(10,6)` and its `parsePrice` ignores larger values). Without prices it prints that SAP cost shows as not priced until rates are entered in the SAP Rates app.

Write rule (`billingToWrite`): `SAP_BILLING_CURRENCY` is written only when one is already stored or the answer is not USD. A USD answer with nothing stored changes nothing. Prices are written when entered and removed otherwise. The keys go into the admin `.env` (Docker) or the admin-env Secret (Kyma), and are documented in `services/admin/.env.sample`. `--ci`, `--config` and the setup-docker child run of setup-kyma write none.

The admin side: when `SAP_BILLING_CURRENCY` is set, price lookups and recalculation consider only SAP Rates rows of that currency; when unset, behaviour is unchanged. At boot, for a non-USD currency with valid prices, the admin (`applySetupPriceRates`) inserts one SAP Rates row per usage type, valid from now, whenever the setup values (currency, price) differ from the values it last applied (recorded in `SetupPriceApplied`). It never updates or deletes rows, so a rate edited in the SAP Rates app stays in force until the setup prices change again. This is why an unnecessary explicit USD would be harmful: it would make the admin ignore hand-added rows in other currencies.

## Tests

Run from `services/gateway`:

```bash
npx jest test/setup- test/kyma-
```

- `setup-flow-*.test.ts` test the engine pieces with scripted prompts.
- `setup-docker-interactive`, `kyma-interactive`, `setup-docker-rerun` and `kyma-rerun` drive the scripts with scripted answers against temporary project roots and stubbed `docker`/`kubectl` calls. Tests never touch the real `.env` files, volumes or a cluster.
- `setup-docker-unattended-golden` and `kyma-golden` pin the files written by `--ci --force`, `--config` and the Kyma render.
- `setup-docker-tty-e2e` runs the real script under a pseudo-terminal (Python `pty`; skipped without `python3` and on Windows): Up arrow back, the review jump, Write, and that a typed password never appears in the output.

### Golden fixtures

Fixtures live in `services/gateway/test/fixtures/setup-docker-golden/` and `kyma-golden/`. Files named `.env` are stored as `dot-env` because `.env` files are gitignored; the test maps the names both ways. The fixtures hold no real-looking secrets: `snapshotRoot` in `test/helpers/setupDockerHarness.ts` replaces every 64-, 32- and 16-character lower-case hex run with `<hex64>`, `<hex32>` and `<hex16>` (the generated keys and passwords) and every AWS access key id (`AKIA…`) with `<aws-access-key-id>`. The `--config` case of the golden test passes fixed constants as its shared secrets (`'a'.repeat(64)` and the like) and fake SAP AI Core values. The Kyma golden renders a fixed fake configuration with the generated secrets stubbed.

A golden failure means the output of an unattended run changed. If that is not intended, fix the code. If it is (for example a new line from `.env.sample`), regenerate and read the diff before committing:

```bash
UPDATE_GOLDEN=1 npx jest test/setup-docker-unattended-golden.test.ts
UPDATE_KYMA_GOLDEN=1 npx jest test/kyma-golden.test.ts
git diff -- test/fixtures
```

The diff must contain only the intended change. Never regenerate to make a red test green without understanding it.
