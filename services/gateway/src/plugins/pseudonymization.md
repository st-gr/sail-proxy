# PII Pseudonymization Plugin

## Overview

The pseudonymization plugin intercepts LLM API calls, detects Personally Identifiable Information (PII) in message content, replaces it with pseudonymized placeholders before forwarding to the LLM, and unmasks placeholders in the response before returning to the caller.

This protects sensitive data from being exposed to third-party LLM providers while maintaining conversational coherence (the LLM sees consistent placeholders like `MASKED_PERSON_48213307` for a given value across messages **and across requests**).

### Placeholder format

Pseudonymization placeholders are **content-derived and stable**: the id is an 8-digit decimal derived from `SHA-256(value)`, so the *same value maps to the same token in every request* (e.g. `MASKED_PERSON_48213307`). This is central to correctness:

- **Residue resolves.** A token echoed from an earlier turn/file re-mints identically as long as its value is present in the current request, so it unmasks instead of leaking.
- **The response cache is safe.** A masked response cached for an equivalent request replays correctly — its tokens are reproducible from content alone.
- **Copy fidelity.** Decimal (not hex) ids because models reproduce digit runs far more reliably; a garbled id is unrecoverable. The plugin also injects a short system instruction telling the model to copy placeholder tokens verbatim. On an in-request id collision the id widens deterministically (8 → 10 → 12 digits).
- **Anonymization** keeps per-request incrementing counters (`MASKED_PERSON_1`) — a content-derived token would make the same entity linkable across requests, defeating anonymization.

URLs use a **URL-shaped** placeholder instead of a bare token (see the URL note under Detection).

## Problem Statement

When organizations use LLM APIs, prompts often contain PII: names, emails, SSNs, addresses, phone numbers, and sensitive attributes (nationality, religion, political affiliation, etc.). Sending this data to external LLMs creates privacy/compliance risk.

## Solution

A gateway plugin that:
1. **Detects** PII using a hybrid multi-tier pipeline (regex + NER + dictionary + custom patterns)
2. **Masks** detected entities with consistent placeholders before forwarding to the LLM
3. **Unmasks** placeholders in the LLM response before returning to the client
4. **Supports streaming** with a token buffer that handles placeholders split across SSE chunks

## Architecture

```
Client Request (with masking config)
    |
    v
[BEFORE handler] ── Detect PII ── Replace with placeholders ── Store map on req
                                                              ── Install res.write / res.json unmask interceptor
    |
    v
Upstream LLM (sees only masked content)
    |
    v
[AFTER handler / wire interceptor] ── Unmask via reverse map ── Attach masking_info
    |
    v
Client Response (original PII restored, + diagnostic info)
```

Unmasking happens on **every** response path:
- **Non-streaming (after handler):** unmask the full body, including tool-call inputs.
- **Streaming wire interceptor (`res.write`):** unmask assistant text (`text_delta`) *and* tool input (`input_json_delta`) as SSE events are written; required for pipelines (e.g. AWS Bedrock native streaming) where the after handler does not fire per chunk.
- **Non-streaming cache hits (`res.json`):** the response cache serves some hits via `res.json` with `{ stop: true }`, bypassing both `res.write` and the after handler — so the interceptor also patches `res.json` to unmask those bodies.

A **leak audit** logs any placeholder that still reaches the client: an error if it was in the map (a genuine unmask miss) or a warning if it was unresolvable residue.

### Streaming Flow

The `StreamUnmaskBuffer` accumulates output that might be a partial placeholder and only flushes text that can no longer be the start of a token. It computes the safe flush point *before* replacing, so a longer token split at a boundary is never corrupted by a shorter prefix.

```
Chunks: ["I recommend ", "MASKED_", "PERSON_48213", "307", " call back"]
Client: ["I recommend ", "",       "",             "John Smith", " call back"]
```

## Detection Pipeline (4 Tiers)

| Priority | Tier | Detector | Examples |
|----------|------|----------|----------|
| 0 (highest) | Custom Regex | User-defined patterns | Permit numbers, badge IDs |
| 1 | Structural Regex | Email, phone, SSN, credit card, IBAN, URL, address, credentials | `john@example.com`, `123-45-6789` |
| 2 | NER (wink-nlp) | Person names, organizations, locations | `John Smith`, `Acme Corp` |
| 3 (lowest) | Dictionary | Nationality, ethnicity, gender, religion, political group, etc. | `Republican`, `Buddhist` |

**Overlap resolution**: When detections overlap, higher priority wins. Within same tier, longest match wins.

**Never re-masks a placeholder**: any span already occupied by an existing placeholder (`MASKED_*_<id>` or a `masked-url-<id>.invalid` URL) is excluded from detection, preventing a double-masking loop where a placeholder gets masked again into a new, unresolvable token.

**URL handling**: URLs mask **origin only** (`scheme://host[:port]`), never the path/query, using a URL-shaped placeholder like `http://masked-url-48213307.invalid`. This lets the model compose new URLs from a masked host (append paths / query params) while the composed URL still unmasks; a scheme-less alias also covers model-initiated scheme switches (e.g. `http` → `wss`). `ws`/`wss`/`ftp(s)` are recognized. URLs whose host is **loopback / private / link-local** (`localhost`, `127.x`, `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `::1`, `*.local`, `*.internal`) or that are **templates** (`<...>`, `{...}`, `${...}`, or a malformed authority) are **not masked** — they carry no privacy value and masking them breaks edit-by-match workflows. `.invalid` is an RFC 2606 reserved TLD, so an unresolved pseudo-URL can never route traffic.

**JSON credentials**: `"token": "..."`, `"password": "..."`, `"api_key": "..."`, etc. are detected with the quoted value captured only (masking preserves the surrounding JSON structure).

## Modes

### Pseudonymization (default)
- Content-derived stable IDs: `MASKED_PERSON_48213307` (same value → same token in every request)
- Response is unmasked (placeholders replaced with originals)
- Same value always gets the same placeholder (idempotent within a request, stable across requests)

### Anonymization
- Per-request incrementing IDs: `MASKED_PERSON_1`, `MASKED_PERSON_2` (LLM can distinguish them; not linkable across requests)
- Response is NOT unmasked (placeholders remain — irreversible)
- No reverse map is maintained

## Replacement Strategies

### Constant (default)
Replaces with a stable, content-derived placeholder `{PREFIX}_{id}` (pseudonymization) or `{PREFIX}_{N}` (anonymization): `MASKED_PERSON_48213307`, `MASKED_EMAIL_11924883`. URL origins use the URL-shaped `http://masked-url-{id}.invalid` form.

### Fabricated Data
Replaces with realistic fake values: `Maria Garcia`, `maria456@example.com`
The LLM sees plausible but fake data; the response is still unmasked back to originals.

## Activation Methods

The plugin checks the following sources in order; the first match wins:

1. Explicit `masking` field in the request body (caller-controlled, full configurability)
2. ON triggerword in message content (`<sail-proxy:pseudonymization:on>` / `<sail-proxy:anonymization:on>`)
3. Per-model force flag in `api_config.json` under `model_list_changes[<id>].pseudonymization.enabled`
4. Per-endpoint force flag in `api_config.json` under `defaultHooks.<endpoint>.pseudonymization.enabled`

If none of these activate, the plugin no-ops.

### Method 1: Triggerword in message content

Include `<sail-proxy:pseudonymization:on>` or `<sail-proxy:anonymization:on>` anywhere in a message. The triggerword is stripped before processing and never reaches the LLM. This activates masking with all entity types — no additional configuration needed.

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "<sail-proxy:pseudonymization:on> John Smith lives at 123 Main St..."}],
  "max_tokens": 200
}
```

The triggerword can be placed in any message (user, assistant, system) and in either string or content-block format. It will be removed from the text before PII detection runs.

| Triggerword | Effect |
|-------------|--------|
| `<sail-proxy:pseudonymization:on>` | Activate with all entity types, unmask response |
| `<sail-proxy:anonymization:on>` | Activate with all entity types, do NOT unmask response |

### Method 2: Explicit `masking` field in request body

For fine-grained control over entity types, replacement strategy, allow-list, and custom patterns:

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "..."}],
  "max_tokens": 200,
  "masking": {
    "method": "pseudonymization",
    "entities": [
      {"type": "profile-person"},
      {"type": "profile-email"},
      {"type": "profile-ssn"},
      {"type": "profile-address", "replacement_strategy": "fabricated_data"}
    ],
    "allow_list": ["San Diego", "City of San Diego"],
    "custom_entities": [
      {"pattern": "\\bPTS-\\d{4,8}\\b", "placeholder": "MASKED_PERMIT"}
    ]
  }
}
```

### Entity Types

| Type | Detection Method | Placeholder Prefix |
|------|-----------------|-------------------|
| `profile-email` | Regex | `MASKED_EMAIL` |
| `profile-phone` | Regex + digit count validation | `MASKED_PHONE_NUMBER` |
| `profile-ssn` | Regex (US SSN, Canada SIN) | `MASKED_SOCIAL_SECURITY_NUMBER` |
| `profile-credit-card-number` | Regex + Luhn validation | `MASKED_CREDIT_CARD_NUMBER` |
| `profile-iban` | Regex + mod-97 validation | `MASKED_IBAN` |
| `profile-url` | Regex (origin only; skips loopback/private/template) | `http://masked-url-<id>.invalid` |
| `profile-address` | Regex (US street patterns) | `MASKED_ADDRESS` |
| `profile-username-password` | Regex | `MASKED_USER_PASSWORD` |
| `profile-nationalid` | Regex (UK NI, Mexico CURP) | `MASKED_NATIONAL_ID` |
| `profile-passport` | Context-anchored regex | `MASKED_PASSPORT` |
| `profile-driverlicense` | Context-anchored regex | `MASKED_DRIVERS_LICENSE` |
| `profile-person` | NER (wink-nlp) | `MASKED_PERSON` |
| `profile-org` | NER (wink-nlp) | `MASKED_ORG` |
| `profile-location` | NER (wink-nlp) | `MASKED_LOCATION` |
| `profile-nationality` | Dictionary | `MASKED_NATIONALITY` |
| `profile-ethnicity` | Dictionary | `MASKED_ETHNICITY_OR_RACE` |
| `profile-gender` | Dictionary | `MASKED_GENDER` |
| `profile-pronouns-gender` | Context-anchored regex | `MASKED_PRONOUNS_GENDER` |
| `profile-religious-group` | Dictionary | `MASKED_RELIGIOUS_GROUP` |
| `profile-political-group` | Dictionary | `MASKED_POLITICAL_GROUP` |
| `profile-sexual-orientation` | Dictionary | `MASKED_SEXUAL_ORIENTATION` |
| `profile-trade-union` | Dictionary + pattern | `MASKED_TRADE_UNION` |
| `profile-sensitive-data` | Enables ALL dictionary types | — |

> Placeholder prefixes match SAP AI Core's `sap_data_privacy_integration` masking module exactly.

### Allow List

Terms in `allow_list` are never masked, even if detected:
```json
"allow_list": ["San Diego", "California", "Department of IT"]
```

### Custom Entities

Domain-specific patterns with user-defined placeholders:
```json
"custom_entities": [
  {"pattern": "\\bPTS-\\d{4,8}\\b", "placeholder": "MASKED_PERMIT", "flags": "gi"},
  {"pattern": "\\bBDG-\\d{5,6}\\b", "placeholder": "MASKED_BADGE"}
]
```

### Method 3: Per-model force flag

In `api_config.json`, add a `pseudonymization` block to a model entry under `model_list_changes`:

```json
"model_list_changes": {
  "anthropic--claude-4-sonnet--deployed": {
    "pseudonymization": { "enabled": true, "method": "pseudonymization" }
  }
}
```

When set, every request to that model gets masked using the default entity set (all entity types). Callers do not need a triggerword.

### Method 4: Per-endpoint force flag

In `api_config.json`, add a `pseudonymization` block to a `defaultHooks` endpoint:

```json
"defaultHooks": {
  "openai":   { "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... },
  "anthropic":{ "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... },
  "aws-bedrock":{ "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... }
}
```

This activates masking for **every** model accessed via that endpoint with the default entity set, including models that have no per-model entry. Per-model takes precedence over per-endpoint when both apply.

## Bypassing forced pseudonymization

When pseudonymization is forced via Method 3 or Method 4, callers can opt out for individual requests **only if the operator has explicitly opted in** by setting the `allow_user_bypass: true` flag on the matching block. Default is `false`.

```json
"defaultHooks": {
  "openai": {
    "pseudonymization": { "enabled": true, "method": "pseudonymization", "allow_user_bypass": true }
  }
}
```

With the flag enabled, callers request bypass via either:

- HTTP header `x-sail-proxy-pseudonymization: off`
- Body field `"pseudonymization_off": true` (stripped from the body before forwarding upstream so the LLM never sees it)

Both signals are out-of-band from prompt content so prompt injection via tool results, web search results, or pasted text cannot trigger bypass.

Precedence: an explicit `masking` field or an ON triggerword in the request still wins over a bypass request — both represent unambiguous caller intent to mask. Bypass only applies when activation came from a force flag.

Every applied bypass and every rejected attempt is logged at INFO/WARN with the API key id, endpoint, and model for audit. Recommended operator policy: leave `allow_user_bypass: false` for endpoints subject to PII compliance regimes; enable only on internal / development endpoints where the trade-off is acceptable.

## Response Format

The response includes a `masking_info` diagnostic field:

```json
{
  "content": [{"type": "text", "text": "John Smith lives at 123 Main St..."}],
  "masking_info": {
    "masked_input": "MASKED_PERSON_48213307 lives at MASKED_ADDRESS_71620094...",
    "entities_detected": [
      {"placeholder": "MASKED_PERSON_48213307", "type": "profile-person", "start": 0, "end": 10},
      {"placeholder": "MASKED_ADDRESS_71620094", "type": "profile-address", "start": 20, "end": 31}
    ],
    "method": "pseudonymization"
  }
}
```

## Self-Improving Entity Cache

The plugin maintains a learned entity cache (Valkey or in-memory LRU):
- After detection, confirmed NER entities (persons, orgs, locations) are cached
- On future requests, cached entities are matched via fast dictionary lookup before running NER
- Reduces NER latency from ~5ms to ~0.1ms for repeat entities
- Cache entries expire after 7 days of inactivity
- Falls back to in-memory LRU if Valkey is unavailable

## Performance

- Full pipeline (regex + NER + dictionary): ~10-20ms per message
- Repeat entities via cache: ~0.1ms
- Zero overhead when `masking` field is absent (plugin no-ops)
- Regexes compiled once at module load, not per-request
- Dictionaries combined into single alternation regex for single-pass matching

## Hook Configuration

The plugin is wired to models in `api_config.json` with empty match (always executes, no-ops internally if no masking config):

```json
{
  "request": {
    "callback": { "id": "pseudonymizationPlugin" },
    "match": []
  }
}
```

Added to both `invoke` and `invoke-with-response-stream` subpaths.

## File Structure

```
src/plugins/
  pseudonymization.ts              # Entry point (re-export for plugin loader)
  pseudonymization/
    index.ts                       # Plugin handlers (before/after/stream)
    types.ts                       # Shared types & default prefixes
    replacementMap.ts              # Bidirectional forward/reverse map
    replacer.ts                    # Apply replacements to text
    unmasker.ts                    # Unmask placeholders in response
    streamBuffer.ts                # Token buffer for streaming
    fabricatedData.ts              # Fake data generation
    entityCache.ts                 # Valkey/in-memory learned cache
    detectors/
      index.ts                     # Pipeline orchestrator + overlap resolution
      regexDetectors.ts            # Tier 1: structural patterns
      nerDetector.ts               # Tier 2: wink-nlp NER
      dictionaryDetector.ts        # Tier 3: word-list matching
      customDetector.ts            # Tier 0: user-defined patterns
    dictionaries/
      nationalities.ts, ethnicities.ts, genders.ts,
      religions.ts, politicalGroups.ts, sexualOrientations.ts, tradeUnions.ts
```

## Testing

### Unit Tests
```bash
pnpm test:pseudonymization
```

### Integration Test (requires running gateway)
```bash
# Start gateway with payload logging enabled
DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev

# In another terminal, run integration tests (from test/ directory)
pnpm test:pseudonymization:integration

# Or with custom port/key
pnpm test:pseudonymization:integration -- --port 3000 --api-key your-key
```

### Payload Log Verification
With `DEBUG=true PAYLOAD_LOGGING_ENABLED=true`, the gateway logs:
- `02_sap_request_payload.json` — shows the masked content sent to the LLM
- `03_sap_response_streaming.json` or `04_transformed_response.json` — shows what was returned

Compare the request payload to verify PII was replaced before reaching the LLM.

## Debugging

```bash
# Watch plugin execution in logs
tail -f logs/gateway.log | grep -i pseudonym

# Check entity cache stats
# (logged at INFO level when cache hits occur)
```

## Dependencies

- `wink-nlp` — NER engine (~500K tokens/sec)
- `wink-eng-lite-web-model` — English language model (~3.5MB)
- `iovalkey` (optional) — Valkey/Redis client for distributed entity cache

## Limitations

- NER is English-only (wink-eng-lite-web-model)
- Address detection uses US street patterns; international addresses may need custom regex
- Dictionary matching is case-insensitive but may produce false positives for short common words
- The proxy is stateless per-request; multi-turn conversations re-mask each time. Content-derived tokens keep this correct — the same value re-masks to the same token — but a token whose **value is no longer present** in the request (e.g. context truncated/compacted, or a token echoed from a session that used an older token scheme) cannot be unmasked; it is left as-is and flagged by the leak audit.
- Unmasking depends on the model reproducing placeholder tokens verbatim. This is mitigated (copy-friendly decimal ids, a verbatim-copy system instruction, composable URL placeholders), but a badly garbled id is unrecoverable.
- Loopback/private/template URLs are intentionally **not** masked (see URL handling).
- Pseudonymization tokens are stable per value, which makes the same entity **linkable across requests** by anyone observing the masked traffic. This is acceptable (and required) for reversible pseudonymization; use anonymization mode where unlinkability matters.
- The gateway fails fast on `EADDRINUSE`, so a stale instance cannot silently serve old plugin code (a past source of "unmasking looks broken" reports).
