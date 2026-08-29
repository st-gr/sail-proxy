# Pointing codex-cli at the gateway

**Runs 2026-08-06/07** against the `claude` branch, gateway on `localhost:3000`, codex-cli 0.146.1.
Config lived under a scratch `CODEX_HOME` so the real `~/.codex` was untouched.

**It works.** `codex exec` completes against the gateway, exit 0, with codex's full 10-tool
request sent exactly as codex sends it — nothing stripped.

> An earlier version of this note concluded that `web_search` and `namespace` had to be stripped,
> and sketched an `unsupported_tool_types` config key to do it. **That conclusion was wrong and the
> proposal is withdrawn.** What follows replaces it.

## The blocker was the active configuration, not the tools

Codex sends 10 tools — 8 `function`, plus `namespace` and `web_search` — and `web_search` goes
regardless of `--search`. Replaying its captured request initially gave a 400 from SAP AI Core:

```json
{"error":"BadRequest",
 "message":"The following tools are not allowed for model 'gpt-5.3-codex': namespace and web_search."}
```

The tempting reading is "SAP rejects these tools, so strip them." The right reading is that
**those tools should never have reached SAP.** The gateway implements both:
`responsesWebSearchPlugin` and `responsesNamespaceToolsPlugin` intercept them in the hosted-tool
engine and serve them locally. `api_config.json` enables both on `responses` and
`responses-stream`.

They did not run because the gateway's **active configuration** was a 98-byte stub:

```
ACTIVE:   "Test Configuration After Fix"  98 bytes
          {"api_config":{"timeouts":{...},"logging":{"defaultLevel":"DEBUG"}}}
INACTIVE: "Default Configuration"         24,237 bytes
```

No `defaultHooks` key at all, so no plugin was configured, so the hosted tools were forwarded
verbatim. The gateway behaved correctly given the configuration it had.

**Where the stub came from:** admin integration suites that POST `activateConfiguration` against a
live service and never restore what was there. Fixed — see `libs/test-utils/active-config-guard.ts`
and commit `859e07b`. Reactivating "Default Configuration" made codex work with no code change.

The lesson generalises: **`api_config.json` on disk is not what the gateway is running.** The
active configuration row in the admin DB is. Check it before diagnosing anything plugin-shaped.

## Model naming: the gateway now accepts the bare name

The gateway lists every deployment twice — the foundation entry `gpt-5.3-codex` (orchestration, no
`deploymentUrl`) and `gpt-5.3-codex--deployed`. The suffix is our decoration, so a client carrying
its own table of published OpenAI names sends the bare name and used to get a 400.

`/openai/v1/responses` now falls back to the `--deployed` sibling when the requested name has no
deployment. Unambiguous, because the bare entry cannot serve that route at all. Confined to the
Responses path: `/chat/completions` still routes the bare name through orchestration, which is the
reason the two entries exist. Commit `9fbb403`.

### The metadata warning is NOT fixed by renaming — measured, not assumed

```
warning: Model metadata for `gpt-5.3-codex--deployed` not found.
         Defaulting to fallback metadata; this can degrade performance and cause issues.
```

The obvious hypothesis is that codex knows the slug `gpt-5.3-codex` (it is in the binary) and would
find metadata under it. **Tested directly: the warning is identical with the bare name.** So the
lookup is not a simple slug match against a built-in table — codex resolves model metadata from a
catalog it does not have for a custom provider.

**The gateway cannot fix this at all.** The lookup happens client-side, before the request; the
gateway never sees it.

It is fixable client-side via codex's `model_catalog_json` config key, which takes a path to
`{"models":[ … ]}`. Probing serde's own errors established the entry shape:

| Field | Notes |
|---|---|
| `slug`, `display_name` | strings |
| `supported_reasoning_levels` | array of `{effort, display_name, description}` |
| `shell_type` | `local` accepted |
| `visibility` | one of `list`, `hide`, `none` |
| `supported_in_api`, `priority` | bool, int |
| `base_instructions` | **string — this is codex's system prompt** |
| `support_verbosity`, `truncation_policy`, … | `ModelInfo` has 39 fields, several nested structs |

**Not pursued past that point, deliberately.** `base_instructions` carries codex's own system
prompt; supplying a hand-written value replaces it, and a wrong one degrades the agent far more
than fallback metadata does. Reconstructing an undocumented, version-specific 39-field struct to
silence a warning is a bad trade. Revisit only if the fallback's context window or auto-compact
limit turns out to hurt in practice — and then get the real catalog, do not invent one. **The
web-search section below revisits it — with the real catalog, not an invented one.**

## Web search: routing codex's searches through the gateway (Perplexity)

**Runs 2026-08-29**, gateway on `localhost:3000`, codex 0.147.0 AND 0.149.1, model `gpt-5.6-sol`.

**It works, config-only, no fork.** `codex --search` sends the hosted `web_search` tool to the
gateway, `responsesWebSearchPlugin` runs it via direct Perplexity, and codex answers from the
gateway's results — on the **deployed** model, on the **latest** codex.

### The mechanism (read from codex's own source, `openai/codex`)

codex has TWO web-search paths, and which one it takes is decided in
`codex-rs/core/src/tools/spec_plan.rs`:

```rust
if model_info.use_responses_lite { return Vec::new(); }   // responses-lite models emit NO hosted tools
let standalone = standalone_web_search_enabled(..) && ext has web.run;
let web_search_mode = (!standalone && provider.capabilities().web_search)
    .then_some(config.web_search_mode.value());            // provider web_search cap DEFAULTS to true
// create_web_search_tool (hosted_spec.rs) then builds {type:web_search, external_web_access}
// for WebSearchMode Live/Indexed/Cached; None/Disabled -> no tool.
```

So the **hosted** tool (the one the gateway executes) is emitted only when **all** hold:
`!model_info.use_responses_lite`, `provider.capabilities().web_search` (default `true`, so
sail-proxy already qualifies), standalone not available, and the top-level config key
`web_search` set to a live mode. Otherwise codex either falls back to OpenAI's **standalone**
search (which never touches the gateway — invisible to gateway logs, visible only in mitmproxy)
or reports "web_search unavailable".

**`gpt-5.6-sol`'s catalog carries `use_responses_lite: true`**, which trips the early return, so
out of the box codex searches standalone against OpenAI. That is the whole "it worked in August,
not now, same codex version" mystery: the delegate-vs-standalone choice is this flag (delivered
by OpenAI's catalog / account, not by anything local), and August's sessions were in delegate
mode. There is no codex version that changes this — 0.146.1 and 0.147.0 both search standalone
now; 0.148+ additionally can't even fetch the capability catalog from a custom provider (it GETs
`{base_url}/models?client_version=` and wants codex's `{models:[…]}` envelope, not the OpenAI
`{object,data}` list, so the refresh fails).

### The recipe

Override that one flag via `model_catalog_json` and pick the live mode:

1. Get a **real** catalog once (the `base_instructions` caveat above is why we reuse, not invent):
   run codex a single time against the real OpenAI provider so it fetches OpenAI's catalog to
   `~/.codex/models_cache.json` — e.g. `OPENAI_API_KEY=<openai-key> codex -c model_provider=openai
   -c model=gpt-5.6-sol "hi"`. This writes the authentic 8-model catalog (correct prompts).
2. Copy it, and set `use_responses_lite: false` on the `gpt-5.6-sol` entry. Save it somewhere
   stable (we use `~/.codex/sailproxy-web-search-catalog.json`).
3. In `~/.codex/config.toml`:
   ```toml
   model = "gpt-5.6-sol"          # NOT --deployed: /responses auto-resolves it to the deployed twin
   web_search = "live"            # selects the hosted web_search tool (external_web_access:true)
   model_catalog_json = "/Users/<you>/.codex/sailproxy-web-search-catalog.json"
   ```

`model = "gpt-5.6-sol"` (the bare foundation slug codex's catalog recognises) is deliberate: the
`/responses` deployed-sibling fallback (§ "Model naming" above) resolves it to
`gpt-5.6-sol--deployed`, so inference runs on the **deployed** model (native Responses) while
codex still sees a web-search-capable slug. `model_catalog_json` also sidesteps the 0.148+
provider-catalog-fetch failure, so this works on the latest codex — no version pin needed.

Verified end-to-end: gateway logs show `responsesWebSearchPlugin` → *Rewrote hosted web_search* →
*Using direct Perplexity* → *Found 20 citations*, and `responsesController` → *Resolved
gpt-5.6-sol to its deployment gpt-5.6-sol--deployed for the Responses API*.

**Maintenance:** `model_catalog_json` freezes the catalog (codex stops auto-refreshing it), so
regenerate it (step 1–2) after a codex upgrade if the `ModelInfo` shape changes or the model list
moves on.

### Search-quota vs. replay — validated live on this path

With web search finally flowing through the gateway, the `web_search.max_searches_per_request`
cap and the replay handling in the hosted-tool engine are exercised for real (they are unreachable
on the standalone path). Measured 2026-08-29, cap = 3:

- **Cap holds.** A turn asking for four searches ran exactly three via Perplexity and refused the
  fourth ("this turn's web-search budget was used up").
- **Replays do not re-execute.** The next turn replayed the prior turn's `web_search_call` items;
  the plugin rewrote them but ran **zero** new Perplexity searches — the cached ones were restored
  and the one that had been capped came back `not_retained` (codex: "Rust's result wasn't
  available"). So replayed history does **not** burn the per-request cap. This is the fix for the
  2026-08-10 incident (see `docs/notes/hosted-tool-result-replay-2026-08-10.md`), now confirmed
  end-to-end rather than only in code: pre-fix the drain re-ran replayed calls and exhausted the
  cap; post-fix a replay hits the process-local result cache (1 h TTL, owner-scoped) or returns
  `not_retained`, never a fresh search.

## Upstream error envelopes — fixed

`error` is a STRING in the SAP body above. OpenAI's envelope, and every SDK written against it,
reads `error.message` off an OBJECT, so a client got `undefined` — which is why codex printed raw
JSON instead of the reason.

`utils/upstreamErrorEnvelope.ts` now normalises it on the Responses path: the upstream message
becomes `error.message`, the label becomes `error.code`, `error.type` is derived from the status the
way OpenAI derives it, and the raw body is preserved under `error.details`. A body that is already
OpenAI-shaped passes through untouched, so an upstream's `param`/`code` survive. The mid-stream
`response.failed` frame carries the real message too, instead of axios's "Request failed with
status code 400". Commit `9fbb403`.

The chat-completions path already did this via `middlewares/errorHandler.ts`; only Responses
returned the upstream body verbatim.

## Operational notes for reproducing

- The tmux window has `http_proxy`/`https_proxy`/`all_proxy` set for mitmproxy. Without
  `NO_PROXY=localhost,127.0.0.1` every gateway call returns **502** from the proxy, which cannot
  reach *its own* localhost:3000. Not a gateway fault, and it looks exactly like one.
- `codex exec` refuses to run outside a trusted directory; `--skip-git-repo-check` or a
  `[projects."…"] trust_level = "trusted"` entry is required.
- The Responses API needs a **deployed** GPT-5+/o-series model. `gpt-5-mini` is rejected by our own
  gateway with a clear, correctly-shaped error — that one did its job.
- `unsupportedParamFilter` strips whole top-level parameters and is already wired into
  `responsesController`. It was never the right tool here; nothing needs stripping.

## Still open

- `web_search` lifecycle frames for the webSearch descriptor. `fileSearch` emits its three; the
  webSearch descriptor does not, and adding them needs a capture of OpenAI's real frame names first.
- Admin suites create configurations (`HTTP Test Configuration`, `Test Configuration After Fix`,
  `Performance Test Config`) and never delete them. The activation leak is fixed; the row leak is
  not — 21 accumulated on the dev stack by 2026-08-07.
