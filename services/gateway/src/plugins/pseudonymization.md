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
| 1 | Structural Regex | Email, phone, SSN, ITIN, credit card, IBAN, bank routing number, DEA number, URL, IP address, address, credentials, org (legal-form suffix), location (gazetteer), transcript speaker labels | `john@example.com`, `123-45-6789`, `Okafor, Lena:` |
| 2 | NER (wink-nlp) | Person names | `John Smith` |
| 3 (lowest) | Dictionary | Nationality, ethnicity, gender, religion, political group, etc. | `Republican`, `Buddhist` |

**Overlap resolution**: When detections overlap, higher priority wins. Within same tier, longest match wins.

**Organisation and location detection is NOT NER.** wink-nlp's shipped model emits no `ORG`/`GPE`/`LOC` entity types, so `profile-org` and `profile-location` are detected at Tier 1 instead: an organisation is recognised only by a configured legal-form suffix (`Acme Industries Inc`), a location only by a literal, configured gazetteer term. See [Organisation, location and the new US identifier categories](#organisation-location-and-the-new-us-identifier-categories) below.

**Person name run length is capped at 4 tokens.** Alongside wink-nlp's own PERSON entities, a supplemental heuristic masks runs of 2+ capitalised tokens wink-nlp misses. A run of up to 4 tokens masks whole. A run longer than 4 tokens is **not discarded** — it is truncated to its last 4 tokens, keeping the trailing tokens and dropping the leading remainder unmasked. For example, `Carlos Alberto De La Fuente Salgado` masks only `De La Fuente Salgado`; the leading `Carlos Alberto` stays in the prompt unmasked. This is deliberate: truncating from the tail keeps the placeholder stable regardless of what precedes the name (placeholders are content-derived, see "Placeholder format" above), and a partially masked long name is still an improvement over the pre-truncation behaviour, where a run over 4 tokens was masked not at all.

**Transcript speaker labels, and the names they vouch for.** The capitalised run cannot see a
speaker written `Surname, Given:` - the comma splits it into two single tokens, and one token is
never a run. In the request behind incident k80nbbxr6 that form occurred 83 times and was masked
zero times, and two of the three people in it never appeared as `Given Surname` at all. A line that
opens with `Surname, Given:`, optionally behind a cue number, is therefore detected at Tier 1 - but
only in a text that shows it is a transcript: the same label heads a second line, or the line
carries a cue (a leading cue number, or a `-->` timing line directly above). One label-shaped line
proves nothing (`Paris, France: the capital`), and neither does a list of `City, Country: value`
rows, where no label repeats; ordinary heading words (`Note, Important:`) never count.

The surname and the given name are masked as **separate** values, with the label's punctuation left
in place. That keeps the round trip exact, and it gives a given name the same placeholder in its
label and where it stands alone. Names a label has vouched for are then masked **wherever they
stand alone in the request** - `I know Lena, you were going to say`, and the model's own later
`Lena chaired the meeting` - case-sensitively and as whole words only, so `Lenaville` and
`lena_config` are untouched. The 12-character floor of ordinary propagation does not apply to them,
because something else has already established that the word is a person's name in this request.
Two limits are deliberate. A name that is far more often an everyday word (`Will`, `May`, `Mark`,
`Grace`, `Hill` - see `EVERYDAY_WORD_NAMES`) is masked in its label but never travels, so `Will you
send it in May?` survives a transcript with speakers called Will and May. And only a speaker label
vouches: the parts of a capitalised run never travel, because `Visual Studio` and `New York` are
runs too. A given name with nothing in the request vouching for it (`Thanks, Lena`) is still not
masked - the given-name dictionary is a confidence signal, never a detector.

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

**SIEM response capture is gated by the mode.** Only `pseudonymization` stashes the masked
response for the usage SIEM event, so under `anonymization` a sink with `include_content: true`
receives the request half but never the response half — the after-handler returns before the
response is captured, whatever the sink's own settings say. The mode is set by the `method` key on
the force-activation block and defaults to `pseudonymization` (see
[Method 3](#method-3-per-model-force-flag) / [Method 4](#method-4-per-endpoint-force-flag)).

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
3. Per-model force flag in `api_config.json` under `models.overrides[<id>].pseudonymization.enabled`
4. Per-endpoint force flag in `api_config.json` under `hooks.defaults.<endpoint>.pseudonymization.enabled`

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
| `profile-itin` | Regex (`9XX-GG-XXXX`, IRS-assigned group ranges; cannot collide with `profile-ssn`) | `MASKED_ITIN` |
| `profile-credit-card-number` | Regex + Luhn validation | `MASKED_CREDIT_CARD_NUMBER` |
| `profile-iban` | Regex + mod-97 validation | `MASKED_IBAN` |
| `profile-bank-account` | Context-anchored regex (`routing`/`ABA`/`RTN`) + ABA checksum | `MASKED_BANK_ACCOUNT_NUMBER` |
| `profile-url` | Regex (origin only; skips loopback/private/template) | `http://masked-url-<id>.invalid` |
| `profile-ip-address` *(off by default)* | Regex (IPv4 + IPv6; skips loopback/RFC1918/link-local) | `MASKED_IP_ADDRESS` |
| `profile-address` | Regex (US street patterns) | `MASKED_ADDRESS` |
| `profile-username-password` | Regex | `MASKED_USER_PASSWORD` |
| `profile-nationalid` | Regex (UK NI, Mexico CURP) | `MASKED_NATIONAL_ID` |
| `profile-passport` | Context-anchored regex | `MASKED_PASSPORT` |
| `profile-driverlicense` | Context-anchored regex | `MASKED_DRIVERS_LICENSE` |
| `profile-medical-license` | Context-anchored regex (`DEA`) + DEA check-digit | `MASKED_MEDICAL_LICENSE` |
| `profile-person` | NER (wink-nlp) | `MASKED_PERSON` |
| `profile-org` *(off by default)* | Legal-form suffix match against configured `org_suffixes` | `MASKED_ORG` |
| `profile-location` *(off by default)* | Literal, case-insensitive match against configured `location_gazetteer` | `MASKED_LOCATION` |
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

`allow_list` is the request-body form: a flat list of literals, compared case-INSENSITIVELY,
applied before the technical-context filter.

The deployment-wide form is `pseudonymization.allowlist` in `api_config.json`, applied after
that filter and before the confidence score — so a listed value is exempt whatever the score
says:
```json
"allowlist": {
  "terms": ["Watson Studio", "Data Transfer Process"],
  "patterns": ["Z[A-Z0-9_]+", "REQ-\\d{6}"]
}
```
`terms` are case-SENSITIVE literals. `patterns` are regex sources that the gateway anchors to
the whole detected value itself (`^(?:…)$`), so `Studio` does not exempt `Watson Studio` and an
unanchored `[A-Z]` cannot exempt everything capitalised. A pattern that does not compile is
skipped with one warning naming it; the rest of the list still applies. The lists of the global,
per-endpoint and per-model layers are concatenated, never replaced.

Every entry here switches masking OFF for what it matches. A pattern that also matches ordinary
personal data is reported — once per pattern, at WARN — and still applied:

```
Allow-list pattern "[A-Z].*" also matches ordinary personal data — it may disable masking
far beyond what was intended. The pattern is still applied; narrow it if that was not the intent.
```


### Saturation reporting

`pseudonymization.saturation_warn` (default 40) is the number of DISTINCT masked values above
which a request is reported as saturated. It changes nothing about masking. Above it the gateway
logs one line per request:

```
Pseudonymization saturation: 41 distinct values masked in one request (saturation_warn=40).
By category: profile-person=41. Top shapes: XXX.XXXXX9.XXXXXXXX9 x41
(letters shown as X, digits as 9 — never the values).
```

Read the shapes, not the counts, to tell what happened: `XXX_XXXX_XXXX_XXXXX` says the detectors
swept up object names, `XXXXXXXX.XXXXXXXX` says the request really did carry a roster of people.
Either way every value found was masked. The same counts ride on the request's usage SIEM event
as `pseudonymization: { masked_values, categories, saturated }`, whether or not the number was
passed, and whether or not any sink is opted into content — the block is counts, not text.

### Placeholders the model invents (`unknown_placeholders`)

A model does not reliably copy an eight-digit id out of a long context. It sometimes answers with
a well-formed placeholder it was never sent. The plugin tells it not to (see the instruction it
appends to the system prompt), and it happens anyway - measured over 7,230 logged pseudonymized
responses, 56 carried such a placeholder: about 1 in 1,000 when a request masks up to fifty values,
1 in 40 above 150, in every model family. Most are entirely new ids rather than copy errors, and a
model will even tokenise a name it had in clear, by imitation of the placeholders around it.

Such a placeholder names nobody and can never be resolved: the id is a hash of the original value,
and nothing hashes to an invented one. Passed through, it lands in whatever the client writes and
returns with every later request, where the model treats it as genuine.

| `unknown_placeholders` | A placeholder in a response that is not in the request's map |
|---|---|
| `withhold` (default) | is replaced by a plain marker - `[name withheld]`, `[email address withheld]`, `[link withheld]`, `[value withheld]` - and reported |
| `report` | reaches the client unchanged and is reported |
| `off` | reaches the client unchanged, as it did before |

Anything unreadable means `withhold`; a typo never turns the control off. A placeholder **the
client itself sent in the same request** is never treated as invented: a developer discussing this
plugin, a test file the model has just read, or residue from an earlier turn are all in the
conversation already, and rewriting them would corrupt source code the model is editing. Use
`report` for a deployment whose own developers write NEW placeholders into fixtures through the
gateway.

Reporting is one grep-stable log line per request,
`pseudonymization_invented_placeholder_total=<n> by_type=<TYPE:n,...> action=withheld|reported placeholders=<ids> requestId=<id>`,
and one `placeholder_invented` security event (severity low) per distinct placeholder, which the
cockpit shows as a notification. The ids are random and name nobody, so logging them is safe, and
they are what lets you find the artifact one ended up in.

Streaming needs no special handling from a client: an invented placeholder is held until its id is
complete, exactly as a real one is, so no fragment of it is ever sent ahead.

### Custom Entities

Domain-specific patterns with user-defined placeholders:
```json
"custom_entities": [
  {"pattern": "\\bPTS-\\d{4,8}\\b", "placeholder": "MASKED_PERMIT", "flags": "gi"},
  {"pattern": "\\bBDG-\\d{5,6}\\b", "placeholder": "MASKED_BADGE"}
]
```

### Method 3: Per-model force flag

In `api_config.json`, add a `pseudonymization` block to a model entry under `models.overrides`:

```json
"models": {
  "overrides": {
    "anthropic--claude-4-sonnet--deployed": {
      "pseudonymization": { "enabled": true, "method": "pseudonymization" }
    }
  }
}
```

When set, every request to that model gets masked using the default entity set (all entity types). Callers do not need a triggerword.

### Method 4: Per-endpoint force flag

In `api_config.json`, add a `pseudonymization` block to a `hooks.defaults` endpoint:

```json
"hooks": {
  "defaults": {
    "openai":   { "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... },
    "anthropic":{ "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... },
    "aws-bedrock":{ "pseudonymization": { "enabled": true, "method": "pseudonymization" }, ... }
  }
}
```

This activates masking for **every** model accessed via that endpoint with the default entity set, including models that have no per-model entry. Per-model takes precedence over per-endpoint when both apply.

## Configuring which categories are masked

> **Plugin-bound scope:** these keys configure the pseudonymizationPlugin. They do **not** activate masking on their own — pseudonymization only runs when the plugin is wired into the endpoint/model hook chain (`callback.id: "pseudonymizationPlugin"`) **and** an activation source fires (force-config `enabled: true`, triggerword, or an explicit body `masking`). If the plugin is absent from the hook chain, these toggles have no effect.

When masking is activated via force-config or triggerword, the entity set comes from the plugin's built-in defaults. `api_config.json` can enable/disable individual categories with an `entities` map (`{ "<category>": true | false }`) at three layers, applied in order — **later layers win**:

1. **Global** — `api_config.observability.pseudonymization.entities`
2. **Per-endpoint** — `hooks.defaults.<endpoint>.pseudonymization.entities`
3. **Per-model** — `models.overrides.<model>.pseudonymization.entities`

```json
"observability": {
  "pseudonymization": {
    "entities": { "profile-person": true, "profile-address": false }
  }
},
"hooks": {
  "defaults": {
    "anthropic": { "pseudonymization": { "enabled": true, "entities": { "profile-address": true } } }
  }
},
"models": {
  "overrides": {
    "anthropic--claude-4-sonnet--deployed": { "pseudonymization": { "enabled": true, "entities": { "profile-url": false } } }
  }
}
```

Semantics:
- `false` disables masking of that category; `true` enables it (adding non-default categories such as `profile-sensitive-data` is supported).
- `profile-sensitive-data` is a **blanket switch**: enabling it turns on every detector at once — overriding even a category explicitly set to `false` in the same map — **except** the three opt-in categories (`profile-org`, `profile-location`, `profile-ip-address`), which stay off unless named directly.
- Categories not listed keep their current state. An absent `entities` map at every layer means the built-in defaults apply — identical to prior behavior.
- Unknown category names are ignored (logged once as a WARN), never fatal.
- These toggles shape only the **default** entity set. A caller who sends an explicit `masking` object in the request body (Method 2) controls their own entity list, and the config toggles do not filter it.

**Available categories** (all `profile-`-prefixed): `person`, `email`, `phone`, `ssn`, `itin`, `credit-card-number`, `iban`, `bank-account`, `url`, `address`, `username-password`, `nationalid`, `passport`, `driverlicense`, `medical-license`, `pronouns-gender`, `nationality`, `ethnicity`, `gender`, `religious-group`, `political-group`, `sexual-orientation`, `trade-union`, `org`, `location`, `ip-address`. All are enabled by default **except** `org`, `location` and `ip-address`, which are opt-in — see [Organisation, location and the new US identifier categories](#organisation-location-and-the-new-us-identifier-categories) below.

**Hot reload:** the config is read per request, so changes apply on the next request in distributed mode (admin-service-notified). In standalone mode the gateway must be restarted for `api_config.json` changes to take effect (as for all plugin config).

## Tuning pseudonymization precision

The `entities` map above decides *what is looked for*. Four further keys in the same
`pseudonymization` block decide *how much evidence a candidate needs before it is masked*, and
what happens when a single request masks a great deal. All four are optional, all four are absent
from the shipped `api_config.json`, and a deployment that sets none of them behaves exactly as
before.

| Key | Default | Layering | What it does |
|---|---|---|---|
| `min_confidence` | `0.5` | scalar, last layer wins | The bar every category must clear |
| `thresholds` | `{}` | merged per category | Per-category override of `min_confidence` |
| `allowlist` | absent | `terms`/`patterns` concatenated across layers | Values this deployment must never mask |
| `saturation_warn` | `40` | scalar, last layer wins | Distinct-value count above which a request is reported. **Report only** |

Each is settable at all three layers — `observability.pseudonymization` (global),
`hooks.defaults.<endpoint>.pseudonymization`, `models.overrides.<model>.pseudonymization` — and
each is editable in the admin config app under **Observability → Pseudonymization**.

As with the `entities` toggles above, a caller who sends an explicit `masking` object in the
request body (Method 2) uses that block verbatim
(`services/gateway/src/plugins/pseudonymization/index.ts:484`) and is not reached by these four
keys at all, so the allow-list and the saturation bar do not apply to such requests (the default
bar of 40 does, since an unset `saturation_warn` falls back to it regardless of config).

```json
"observability": {
  "pseudonymization": {
    "min_confidence": 0.5,
    "thresholds": { "profile-driverlicense": 0.9 },
    "allowlist": {
      "terms": ["Watson Studio", "Redis Sentinel"],
      "patterns": ["Z[A-Z0-9_]+", "REQ-\\d{6}"]
    },
    "saturation_warn": 40
  }
}
```

### How a candidate's score is built

Every detected value carries a score from 0 to 1, and is masked when its score reaches
`min_confidence`. Detectors start it at a base:

| Detector | Base | Note |
|---|---|---|
| Operator custom rule | 1.0 | Never lowered by anything below |
| Checksum- or format-validated pattern (IBAN, card, SSN, email, IP…) | 0.95 | Never lowered |
| Credentials (password/token/key patterns) | 0.95 | Never lowered — a fenced code block is exactly where a credential lives |
| Label-anchored pattern (fires only next to a trigger word) | 0.85 | |
| Word-list hit | 0.5 | |
| A run of capitalised words | 0.5 | In practice the only detector of personal names |

The bundled language model recognises dates and amounts but emits no person, organisation or place
entity at all, so the 0.7 reserved for a model verdict is never reached today — names rest entirely
on the capitalised-run heuristic.

That heuristic starts at 0.5 rather than lower because the technical-context filter has already
dropped identifiers, SQL, JSON keys, paths and code *before* scoring begins. A capitalised run that
survives that **is** a name unless something argues otherwise, and a name in a table row, a CSV
line, a bullet, a log line or a JSON value is as much a name as one in a sentence. The score then
moves:

**Argues against (subtracts):**

- an identifier or a JSON key in the value's **own** column/field, or a SQL statement or fenced
  block **anywhere on its line** — −0.15
- every word of the value being an ordinary English word (a column heading, a job title) — −0.15
- an ALL-CAPS word **inside** the value — −0.3
- the value sitting in code or SQL — −0.3

**Argues for (adds):**

- a nearby honorific or salutation — +0.3
- an adjacent mail address or phone number — +0.2
- a recognised given name — +0.15
- the value being the whole content of a quoted string — a SQL literal or a JSON string value,
  where real names sit inside machinery — +0.15 (this cancels the machinery subtraction exactly)

Two things are deliberately **not** evidence: a shouted word *next to* the value (capitals are how
people write emphasis, headers, department names and log levels), and a link or file path *next to*
the value (only a value **inside** a URL or path is machinery — and the technical filter already
dropped that). And the number of other values in the request changes nothing: each value is judged
on its own surroundings, so a long roster of names masks every one of them.

**Worked examples** (at the default bar of 0.5):

| Text | Score | Masked? |
|---|---|---|
| `Dear Dr. Ana Fernandez, …` | 0.5 + 0.3 honorific = **0.8** | yes |
| `\| Ana Fernandez \| ZPC_FICA_TRAN_DAILY \|` (name in its own cell) | **0.5** | yes |
| `… WHERE owner = 'Ana Fernandez'` | 0.5 − 0.15 SQL line + 0.15 quoted literal = **0.5** | yes |
| `Senior Auditor` (a job title, all ordinary words) | 0.5 − 0.15 = **0.35** | no |
| `Data Transfer Process failed` on a log/SQL line | 0.5 − 0.15 − 0.15 = **0.2** | no |
| `password: hunter2` in a ```` ``` ```` block | credential **0.95**, never lowered | yes |

### `min_confidence` — and why raising it is expensive

Masking happens when the score above reaches the bar. Raising the bar buys precision with recall, and on the
shipped corpus the exchange rate is brutal, because the capitalised-run heuristic — in practice
the only detector of personal names there is — scores a bare name at exactly `0.5`:

| `min_confidence` | technical precision | technical recall | prose precision | prose recall | credentials still masked |
|---|---|---|---|---|---|
| **0.5** (default) | 0.925 | 0.902 | 0.987 | **1.000** | yes |
| 0.55 | 0.972 | 0.854 | 0.952 | **0.256** | yes |
| 0.6 | 0.972 | 0.854 | 0.952 | 0.256 | yes |
| 0.65 | 0.972 | 0.854 | 0.952 | 0.256 | yes |
| 0.7 | 0.968 | 0.732 | 1.000 | 0.205 | yes |
| 0.8 | 1.000 | 0.585 | 1.000 | 0.180 | yes |

One step, from 0.5 to 0.55, costs three quarters of the names in ordinary prose — a name with no
honorific, no adjacent mail address and no recognised given name has nothing else to earn a
higher score with. **Do not raise `min_confidence` to quieten a noisy category.** What survives a
rise is the format-validated and context-anchored end of the range: mail addresses, IBANs, SSNs
and credentials all still mask at 0.8, because no negative adjustment applies to them and a code
fence is exactly where a credential lives.

Lowering it below 0.5 has the opposite cost and is rarely the right move either: 0.35 is where
the technical machinery of the 2026-08-25 incident sat.

### `thresholds` — per category, same cliff for names

`thresholds` overrides `min_confidence` for the categories named, e.g.
`{ "profile-driverlicense": 0.9 }`. This is the right knob for a category whose detections are
format-validated or label-anchored and therefore score 0.85 or higher: raising its bar removes
the weak hits without touching anything else.

It is **not** a way round the cliff above for `profile-person`. Setting
`{ "profile-person": 0.7 }` leaves 5 of the corpus's 67 prose person labels masked — the same
loss, confined to the category you were trying to tune. To stop a specific value being masked,
name it in the allow-list; that is what the allow-list is for.

### `allowlist` — the OFF switch, per value

`terms` are case-sensitive literals; `patterns` are regex sources the gateway anchors to the
whole detected value (`^(?:…)$`) for you, so write `Z[A-Z0-9_]+`, not `^Z[A-Z0-9_]+$`. It is
applied after the technical-context veto and before scoring, so a listed value is exempt
whatever the evidence says and no threshold change brings it back. The lists of the three layers
are concatenated, never replaced — a per-model list can only add an exemption.

The cost of an entry is that it switches masking off for everything it matches, and the failure
mode is an entry that is broader than it looks. `[A-Z].*` compiles, is anchored, and exempts
almost every name the run heuristic finds. Every compiled pattern is tested against a small,
frozen sample of ordinary personal data and warns once per pattern when it matches:

```
Allow-list pattern "[A-Z].*" also matches ordinary personal data — it may disable masking
far beyond what was intended. The pattern is still applied; narrow it if that was not the intent.
```

It **warns and still applies** — an operator may mean a broad entry. Review an allow-list change
the way you would review switching masking off, because that is what it is. See
[Allow List](#allow-list) above for the request-body form (`allow_list`), which is a different,
case-insensitive list applied earlier in the pipeline.

### Reading the saturation report

`saturation_warn` changes nothing about masking (see [Saturation reporting](#saturation-reporting)).
Above the bar, one WARN line per request:

```
Pseudonymization saturation: 41 distinct values masked in one request (saturation_warn=40).
By category: profile-person=41. Top shapes: XXXXXXXX.XXXXXXXX99.XXXXX x31,
XXXXXXXX.XXXXXXXX9.XXXXX x10 (letters shown as X, digits as 9 — never the values).
```

Read the **shapes**, not the count. `XXXXXXXX.XXXXXXXX99.XXXXX` is a mail-address shape — the
request really did carry a roster of people, and masking 41 values was correct.
`XXX_XXXX_XXXX_XXXXX` is an object-name shape — the detectors swept up machinery, and the fix is
an allow-list pattern, not a threshold.

Every request the plugin ran for — saturated or not — also carries the same counts on its usage
SIEM event:

```json
"pseudonymization": { "masked_values": 41, "categories": { "profile-person": 41 }, "saturated": true }
```

`saturated: false` events are what make a rising trend visible; a block that appeared only at the
moment of alarm would give a SIEM no baseline. The block is counts, not text, so it is gated by
`emit` alone and reaches a sink that is not opted into content. Neither the WARN line nor the
block ever carries a masked value.

### Re-baselining deliberately, with the harness

`services/gateway/test/pseudonymization-precision/` is the regression gate for every detector
change: a labelled corpus (`corpus.ts`), a scorer independent of the plugin (`scorer.ts`), and
the asserted thresholds (`precision.test.ts`). CI runs it in Phase 4.

```bash
cd services/gateway
pnpm run test:pseudonymization                      # this harness plus every other pseudonymization suite
npx jest --testPathPattern=pseudonymization-precision  # just the gate
```

What it asserts, and what a failure means:

| Gate | Meaning of a failure |
|---|---|
| technical precision ≥ 0.9, and > the `30747f6` baseline | The detectors are masking more machinery — moving back toward the incident's behaviour |
| prose recall ≥ the `30747f6` baseline | A name/mail address/credential that used to be found no longer is |
| mixed set exactly 5 tp / 0 fp | The incident-shaped document changed behaviour |
| the NER tier is unreachable | The wink-nlp model started emitting entities — re-measure everything |
| saturation stability | Something reintroduced a saturation-based score adjustment. This must never happen |
| wall time ≤ 2× baseline | Detection got materially slower |

Tune first, then re-measure — never edit a threshold to make a red test green. The full
procedure for producing fresh baseline numbers, and the four situations that justify doing so, is
in that directory's `README.md` ("Re-baselining deliberately"). The one rule worth repeating
here: if the corpus grows, the `30747f6` numbers must be re-measured on the *new* corpus, or the
comparison means nothing.

Current numbers, baseline `30747f6` → HEAD:

| Set | Metric | `30747f6` | HEAD |
|---|---|---|---|
| technical | precision | 0.830 | **0.925** |
| prose | recall | 0.987 | **1.000** |
| mixed (the incident's shape) | precision | 0.156 | **1.000** |

### Known limitations of the precision work

- **The NER tier is unreachable.** The bundled `wink-eng-lite-web-model` emits no PERSON / ORG /
  GPE entity type, so the 0.7 tier is wired but never fires. Name detection is the capitalised-run
  heuristic and the scoring around it, and nothing else. Replacing the NER engine is a follow-up.
- **A name made only of ordinary English words is not masked.** The `−0.15` common-words
  adjustment cannot tell `Senior Auditor` from a person whose name happens to be two dictionary
  words. The word list deliberately holds no given name or surname, so one real name token
  cancels the adjustment — but the gap is real.
- **An uncapitalised name has nothing to catch it.** With the NER tier dead, a lower-case name is
  invisible to the detector. A custom regex is the only cover.
- **An over-broad allow-list entry is warned about, not refused.** The canary sample detects the
  careless pattern, not the deliberate one, and no sample can do better.
- **A Title-Case product or system name is still masked unless it is allow-listed.** `Watson
  Studio` and `Redis Sentinel` mask as `profile-person@0.5`: neither is made of ordinary English
  words, so nothing distinguishes them from a person. Name them in `allowlist.terms`.
- **wink-nlp's tokeniser drops a run split by an internal double space.** `owner: Miguel  Torres`
  masks nothing, while `owner: Miguel Torres` masks correctly. Any internal double space in a
  name triggers it.
- **A `Regards,` window can lift a following title line.** `hasHonorificNear` reaches a salutation
  from up to 40 characters away, so in a two-line signature block (`Regards,` / name / job title)
  the honorific bonus applies to the title line as well — `Senior Auditor` masks as
  `profile-person@0.65`.

Each of these has a labelled regression case in the harness's corpus, so a future fix shows up as
a test that needs updating rather than as a silent change.

## Organisation, location and the new US identifier categories

Six categories were added or changed to close gaps where the plugin previously detected nothing:

| Category | Default | How it detects |
|---|---|---|
| `profile-org` | **off** (opt-in) | A run of 1-5 capitalised tokens immediately followed by a configured legal-form suffix from `org_suffixes` (e.g. `Inc`, `LLC`, `GmbH`). Ordinary leading words like "Please"/"Contact" are trimmed so only the entity is masked; a leading "The" is deliberately **not** trimmed, so `The Home Depot Inc` stays intact rather than being truncated. |
| `profile-location` | **off** (opt-in) | Literal, case-insensitive, whole-word matches against `location_gazetteer`, which **ships empty**. Nothing is inferred from capitalisation or context. |
| `profile-itin` | on | US ITIN, `9XX-GG-XXXX` with the group digits in the IRS-assigned ranges. Cannot collide with `profile-ssn`, whose pattern already excludes the `9xx` prefix space. |
| `profile-bank-account` | on | ABA routing number. Requires a nearby `routing`/`ABA`/`RTN` context word **and** passes the ABA checksum — a bare 9-digit run is not enough (roughly 1 in 10 pass the checksum by chance). |
| `profile-medical-license` | on | DEA registration number. Requires a nearby `DEA` context word **and** passes the DEA check-digit, for the same reason as above. |
| `profile-ip-address` | **off** (opt-in) | IPv4 and IPv6. Loopback, RFC 1918 private, and link-local addresses never mask (`127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `::1`, `localhost`). Exempt from the `profile-sensitive-data` blanket (below) so its opt-in default holds even when that convenience toggle is used. |

When enabled, `profile-ip-address` masks a public address like `203.0.113.45` (RFC 5737 documentation range) but leaves a private one like `192.168.1.1` untouched.

### Why `profile-org`, `profile-location` and `profile-ip-address` are off by default

Every other category detects a value with an unambiguous, checksummed, or context-anchored shape — a credit card number either passes Luhn or it doesn't. Organisation names, location names, and bare IP-shaped numbers do not have that property: a capitalised run of words, a place name, or a dotted-decimal quad can just as easily be ordinary prose (a bare IPv4-shaped string can be a version number or ratio). Over-masking here is the more dangerous failure mode: a value the model paraphrases into a *different* string when echoing it back mints a placeholder that exists in no reverse map and can never be unmasked. A missed value is merely missed. Requiring an explicit opt-in — a populated `org_suffixes`/`location_gazetteer`, or a deliberate `profile-ip-address: true` toggle — keeps these categories from masking on a guess.

### The two configuration knobs

`org_suffixes` and `location_gazetteer` live under `api_config.observability.pseudonymization` (siblings of `entities`), and — like `entities` — are also settable per-endpoint (`hooks.defaults.<endpoint>.pseudonymization`) and per-model (`models.overrides.<model>.pseudonymization`), layered global → per-endpoint → per-model with later layers winning:

```json
"observability": {
  "pseudonymization": {
    "entities": { "profile-org": true, "profile-location": true },
    "org_suffixes": ["Inc", "Inc.", "LLC", "L.L.C.", "Ltd", "Ltd.", "Limited", "Corp", "Corp.", "Corporation", "PLC", "GmbH", "AG", "S.A.", "B.V.", "Pty", "LLP"],
    "location_gazetteer": ["Springfield"]
  }
}
```

- `org_suffixes` ships with a set of generic legal forms (above) — safe defaults, since they name no deployment.
- `location_gazetteer` **ships empty**. Place names identify a deployment, and this repository is public, so no location term is tracked in code. Operators populate it per deployment through the admin config app; nothing is inferred.

### The empty-producer warning

Enabling `profile-org` or `profile-location` with nothing for the detector to match (an empty `org_suffixes` or `location_gazetteer`) masks **nothing**, silently, unless flagged. The gateway logs a one-time warning naming the category (`profile-org is enabled but org_suffixes is empty — NOTHING will be masked as an organisation...` / the `profile-location` equivalent) the first time this happens per process, so an operator who flips the toggle without also populating the list finds out from the log rather than from an eventual privacy incident.

### Publish hazard: `sync-api-config.js` and the two list knobs

`cli-tools/sync-api-config.js` copies `services/gateway/api_config.json` verbatim over `services/admin/api_config.json` and the npm-dist template. Re-running that sync (or any equivalent publish step) over a **live deployment's** config would overwrite an operator's populated `location_gazetteer` (and any customized `org_suffixes`) back to the repo's shipped defaults — `[]` for the gazetteer — silently turning location masking off with no error. Whoever owns that publish path should treat `observability.pseudonymization.org_suffixes` and `observability.pseudonymization.location_gazetteer` as **merge-on-publish** keys rather than overwrite-on-publish. This is not implemented — it is called out here as a known hazard for the tool's maintainer to pick up.

### Upgrading

`profile-org` and `profile-location` shipped **on** by default in earlier releases and are **off** (opt-in) as of this change, in both `DEFAULT_MASKING_CONFIG` and the shipped `api_config.json`. That default only governs a fresh install — an already-running deployment has its own stored configuration (served by the admin service from the database), and that stored config still carries whatever it was set to before, e.g. `"profile-org": true`. The shipped-default flip does **not** touch it.

This matters for two separate reasons:

- **Silent behavior change.** A deployment whose stored config still carries the pre-upgrade `"profile-org": true` (or `profile-location`) gets those categories newly active after the upgrade with no configuration change on the operator's part and no warning — the stored config was set under the old defaults and the new shipped default does not retroactively apply to it.
- **Placeholder prefix changes break in-flight conversations.** Independent of the toggle default, a value the NER heuristic previously tagged `MASKED_PERSON_<id>` can now be tagged `MASKED_ORG_<id>` with `profile-org` enabled (the id is content-derived and unchanged, only the prefix differs — see "Placeholder format" above). An old `MASKED_PERSON_<id>` token sitting in conversation history will **not** resolve against a post-upgrade map, because the map now keys that value under the `MASKED_ORG` prefix. Conversations that span the upgrade can end up with unresolvable residue.

Before upgrading a deployment that has `profile-org` or `profile-location` enabled in its stored configuration, operators should either:

- explicitly set the affected categories to `false` in the stored config to keep pre-upgrade behavior, or
- accept that the categories remain active and that placeholder prefixes for affected values may change, with the residue risk above for conversations already in progress.

## Bypassing forced pseudonymization

When pseudonymization is forced via Method 3 or Method 4, callers can opt out for individual requests **only if the operator has explicitly opted in** by setting the `allow_user_bypass: true` flag on the matching block. Default is `false`.

```json
"hooks": {
  "defaults": {
    "openai": {
      "pseudonymization": { "enabled": true, "method": "pseudonymization", "allow_user_bypass": true }
    }
  }
}
```

With the flag enabled, callers request bypass via either:

- HTTP header `x-sail-proxy-pseudonymization: off`
- Body field `"pseudonymization_off": true` (stripped from the body before forwarding upstream so the LLM never sees it)

Both signals are out-of-band from prompt content so prompt injection via tool results, web search results, or pasted text cannot trigger bypass.

When a bypass is applied the request reaches the LLM **completely unmasked**. It also ships
**unmasked** to a usage SIEM sink only where an enabled sink sets **both** `include_content` **and**
`allow_unmasked_content`; without the second flag the sink still receives the counts but not the
unmasked content.

Precedence: an explicit `masking` field or an ON triggerword in the request still wins over a bypass request — both represent unambiguous caller intent to mask. Bypass only applies when activation came from a force flag.

Every applied bypass and every rejected attempt is logged at INFO/WARN with the API key id, endpoint, and model for audit. Recommended operator policy: leave `allow_user_bypass: false` for endpoints subject to PII compliance regimes; enable only on internal / development endpoints where the trade-off is acceptable.

## Response Format

By default the response body is the plain unmasked model response with **no** extra
fields. The `masking_info` diagnostic (the full masked input plus the detected-entity
list) is **opt-in for pseudonymization** — it is large and echoes every mask token, so
it is attached only when the request asks for it via either:

- body field `masking.debug: true`, or
- header `x-sail-proxy-masking-debug: on` (out-of-band, works with triggerword activation).

Anonymization always attaches `masking_info` (it is that mode's primary diagnostic and
carries no reversible mapping).

When requested, the field looks like:

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

- The precision work has its own list — the unreachable NER tier, names made of ordinary words, uncapitalised names, allow-list breadth, Title-Case product names, the double-space tokeniser gap and the signature-block window — under [Known limitations of the precision work](#known-limitations-of-the-precision-work).
- NER is English-only (wink-eng-lite-web-model)
- Address detection uses US street patterns; international addresses may need custom regex
- Dictionary matching is case-insensitive but may produce false positives for short common words
- The proxy is stateless per-request; multi-turn conversations re-mask each time. Content-derived tokens keep this correct — the same value re-masks to the same token — but a token whose **value is no longer present** in the request (e.g. context truncated/compacted, or a token echoed from a session that used an older token scheme) cannot be unmasked; it is left as-is and flagged by the leak audit.
- Unmasking depends on the model reproducing placeholder tokens verbatim. This is mitigated (copy-friendly decimal ids, a verbatim-copy system instruction, composable URL placeholders), but a badly garbled id is unrecoverable.
- Loopback/private/template URLs are intentionally **not** masked (see URL handling).
- Pseudonymization tokens are stable per value, which makes the same entity **linkable across requests** by anyone observing the masked traffic. This is acceptable (and required) for reversible pseudonymization; use anonymization mode where unlinkability matters.
- The gateway fails fast on `EADDRINUSE`, so a stale instance cannot silently serve old plugin code (a past source of "unmasking looks broken" reports).
