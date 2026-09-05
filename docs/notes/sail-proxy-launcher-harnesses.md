# The sail-proxy launcher: driving codex / Claude Code / opencode

**Runs 2026-08-29**, against the dev gateway on `localhost:3000` (repo
`services/gateway` via ts-node), launcher built from `npm-dist/sail-proxy`.

The standalone CLI now has a harness launcher: `sail-proxy <harness> [args]`
configures codex, Claude Code, or opencode to talk to a sail-proxy gateway and
execs it — no manual per-harness config. It is the LiteLLM-style "prefix a
coding-agent invocation" idea, built on the existing npm CLI.

```
sail-proxy endpoint set local                       # bundled gateway (auto-started)
sail-proxy endpoint set https://gw.kyma… --key-env SP_KEY   # or a remote docker/kyma root
sail-proxy endpoint show
sail-proxy codex "…"        # also: claude, opencode
sail-proxy codex --dry-run "…"    # preview the exact config + exec line, write/start nothing
```

One **active endpoint** at a time (`endpoint set` overwrites it). The endpoint
stores the gateway **root**; each adapter derives its own route (codex/opencode
→ `/openai/v1`, claude → `/v1/messages`, which Claude Code appends itself).

## codex — works, config-only, and **non-invasive** (writes no config file)

**It works.** `sail-proxy codex …` runs codex against the gateway with
web_search routed through it. Verified live: `sail-proxy codex exec …` answered
*"the current stable Node.js LTS major version is **24** (Krypton)"* citing
`nodejs.org`, and the gateway payload count rose by 4 per turn — i.e. the hosted
`web_search` tool executed on the gateway (→ direct Perplexity), not standalone.

### Why `-c` overrides, not a profile

The first design wrote a `[profiles.sail-proxy]` table into `~/.codex/config.toml`
and passed `-p sail-proxy`. **codex 0.149.1 rejects that:**

```
Error loading config.toml: --profile `sail-proxy` cannot be used while
/Users/…/.codex/config.toml contains legacy `profile = "sail-proxy"` or
[profiles.sail-proxy] config; move those settings into
/Users/…/.codex/sail-proxy.config.toml and remove the legacy profile selector.
```

Recent codex forbids an **inline** profile table used with `-p`. Neither the
unit tests nor `--dry-run` caught this — it is a codex *runtime* behavior that
only a live run surfaces (the container-verification lesson again: static
checks pass, the real binary refuses).

The fix mirrors how a hand-written working setup avoids profiles: pass
everything as codex `-c` config overrides and **write no config file at all**.
The adapter emits exactly:

```
codex \
  -c model_provider=sail-proxy \
  -c model_providers.sail-proxy.name="sail-proxy" \
  -c model_providers.sail-proxy.base_url="<root>/openai/v1" \
  -c model_providers.sail-proxy.env_key="SAILPROXY_KEY" \
  -c model_providers.sail-proxy.wire_api="responses" \
  -c model=gpt-5.6-sol \
  -c web_search=live \                                    # only when web search is on
  -c model_catalog_json="<~/.sail-proxy/codex-web-search-catalog.json>" \  # ditto
  <passthrough args>
```

and sets `SAILPROXY_KEY` in codex's environment to the resolved gateway key.
`-c` global flags work before a subcommand, so `sail-proxy codex exec …` becomes
`codex -c … exec …` and runs fine.

Consequences:
- **Nothing is written to `~/.codex/config.toml`** — the user's own config,
  comments, trust list, and web-search recipe are untouched. Confirmed: after a
  full launcher run the file was byte-identical.
- `model=gpt-5.6-sol` (the bare foundation slug) is deliberate — the gateway's
  `/responses` route auto-resolves it to `gpt-5.6-sol--deployed` (native
  Responses on the deployed model), while codex still sees a web-search-capable
  slug. See `docs/notes/codex-cli-against-the-gateway.md` for the web_search
  mechanism (the `use_responses_lite` gate, the catalog override, and why the
  hosted tool must reach the gateway).

### The web_search catalog

Web search only routes through the gateway when codex emits the **hosted**
`web_search` tool, which requires `use_responses_lite=false` for the model. The
launcher reuses `~/.codex/models_cache.json`, flips that flag, and writes a copy
to `~/.sail-proxy/codex-web-search-catalog.json`, pointed to by
`model_catalog_json`. Best-effort: if no catalog exists, the launcher prints a
seed hint and runs codex without web search rather than failing. See the codex
note above for how to seed the catalog once.

## Claude Code — env-only

`sail-proxy claude` writes no config file. It sets three environment variables
and execs `claude`:

```
ANTHROPIC_BASE_URL = <endpoint root>          # Claude Code appends /v1/messages itself
ANTHROPIC_AUTH_TOKEN = <gateway key>          # sent as Authorization: Bearer (matches sail-proxy sk- keys;
                                              #   vs ANTHROPIC_API_KEY's x-api-key)
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1  # no telemetry/auto-update phone-home bypassing the gateway
```

Not live-smoked in this run (env-only, and the flow mirrors codex's endpoint
wiring); the adapter's env output is covered by unit tests.

## opencode — works (Responses API by default; chat/completions works too now)

**It works.** `sail-proxy opencode` writes a **namespaced** `provider.sail-proxy`
block into `~/.config/opencode/opencode.json` (leaving any other providers
untouched) using **`@ai-sdk/openai`** — the Vercel provider that drives the
**Responses API**. As of 2026-08-30 the `chat/completions` path
(`@ai-sdk/openai-compatible`) works too — see the update below — so either
provider is viable; the launcher keeps `@ai-sdk/openai`.

```json
{ "provider": { "sail-proxy": {
  "npm": "@ai-sdk/openai",
  "options": { "baseURL": "<root>/openai/v1", "apiKey": "<gateway key>" },
  "models": { "gpt-5.6-sol": {} } } } }
```

Verified live: `sail-proxy opencode run -m sail-proxy/gpt-5.6-sol "…"` completes
(exit 0), and the gateway payloads show the **`/responses`** path
(`00_original_responses_request` → `02_responses_request_to_deployment` →
`03_responses_stream_from_deployment`) — i.e. the same deployed-model Responses
route codex uses. Select the model with `-m sail-proxy/gpt-5.6-sol`.

### chat/completions (`@ai-sdk/openai-compatible`) — failed originally, fixed at the gateway (2026-08-30)

The first design used `@ai-sdk/openai-compatible`, which speaks only
`chat/completions`, and **at the time it failed**: `sail-proxy opencode run`
errored with `Error: {"message":"[object Object]"}` (debug: `stream error …
error.error.message="[object Object]"`) and the gateway logged the request as
**canceled client-side** (`ERR_CANCELED`). The `[object Object]` was opencode's
own opaque error object — its `@ai-sdk/openai-compatible` client aborted the
stream. A bare stream was valid SSE (curl → `HTTP 200`, `data: [DONE]`), so
switching to `@ai-sdk/openai` (Responses) was the quick unblock.

**The real cause, though, was the gateway's `/openai` chat-completions responses
not being fully OpenAI-spec-compliant** — which opencode's strict ai-sdk parser
rejected: token `usage` rode the streaming **delta** chunks, and the `id`/`model`
**varied across chunks**. The `/openai` route spec-compliance work (commits on
`claude`, 2026-08-30) fixed exactly those: `usage` is now client-opt-in and
emitted only in a final empty-`choices` chunk (never on a delta chunk), the `id`
is one stable value per completion, and the `model` echoes the request. So the
earlier "not a gateway fault" reading was incomplete — the non-spec-compliant
details were the gateway's, and they are now fixed.

**After those fixes, `@ai-sdk/openai-compatible` works too.** Verified live
(2026-08-30): `sail-proxy opencode run -m sail-proxy/gpt-5-mini "…"` completes and
answers via the `chat/completions` → orchestration path (was: total failure);
and **Open WebUI** — a stricter chat/completions client — drives tool-rich
streaming *and* non-streaming against `/openai/v1` (model `gpt-5.6-luna`) with
zero errors, its responses carrying a stable id, the echoed model, correct
`finish_reason`, and opt-in `usage`.

So both providers now work: `@ai-sdk/openai` (Responses — the launcher's default,
where `gpt-5.6-sol` resolves to its deployed twin like codex) and
`@ai-sdk/openai-compatible` (chat/completions). The launcher keeps the Responses
provider; openai-compatible is now an equally valid alternative.

## Endpoint & key notes

- The **local** endpoint targets the npm-dist **bundled** gateway (auto-started,
  keys seeded from `~/.sail-proxy/apikeys.json`). It is a *different* gateway
  from the repo dev gateway on the same port — if a dev gateway is already
  running on `:3000`, the launcher reuses it but the bundled-key story does not
  apply.
- **Warm-gateway 401 (known):** the local `resolveKey()` mints/uses a stored
  `~/.sail-proxy` key, but a gateway that is *already running* only seeds its
  keys at startup — so a freshly-minted key can 401 against it. Confirmed live:
  the stored key 401s against the running dev gateway. Workaround used for these
  smokes: register the dev gateway as a **remote** endpoint with an env-ref key
  it already accepts — `sail-proxy endpoint set http://127.0.0.1:3000 --key-env
  OPENAI_API_KEY`. Proper fix (register the key via the admin API, or detect and
  hint on 401) is a follow-up.
- `--dry-run` previews the exact config diff + exec line and writes/starts
  nothing; the API key is **redacted** in dry-run output.
