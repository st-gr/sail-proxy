# PII Pseudonymization Plugin — Security Assessment

**Date:** 2026-05-13 (updated 2026-08-14)
**Component:** SAP LLM Gateway — Pseudonymization Plugin
**Purpose:** Evidence that PII is intercepted and masked before reaching external LLM providers

---

> **2026-07-07 redesign — security-relevant changes.** The masking→LLM direction and its guarantees are unchanged (the LLM still receives only masked content). The following changed on the unmasking/response side and in token generation; example tokens below of the form `MASKED_PERSON_1` are now illustrative of *behavior*, not format:
> - **Placeholder format is now content-derived and stable.** Ids are `SHA-256(value)`-derived (8 decimal digits), so the same value maps to the same token in every request (e.g. `MASKED_PERSON_48213307`). This fixes cross-request/residue unmasking and makes response caching safe. **New residual risk:** stable tokens make the same entity *linkable across requests* by anyone observing masked traffic (acceptable for reversible pseudonymization; use anonymization mode — which keeps random per-request counters — where unlinkability is required). See §11.
> - **URLs mask origin-only as a URL-shaped placeholder** (`http://masked-url-<id>.invalid`), and **loopback/private/link-local/template URLs are not masked** (data-minimization: no privacy value, and masking them broke agent edit workflows). See §11.
> - **JSON-style credentials** (`"token": "..."`) are now detected (value-only capture).
> - **No double-masking:** existing placeholders are excluded from re-detection.
> - Unmasking now also covers streamed assistant text, non-streaming `res.json`/cache-hit bodies, and multi-turn residue; a leak audit logs any placeholder that reaches the client.

---

## 1. Executive Summary

The pseudonymization plugin intercepts all LLM API requests at the gateway level and replaces Personally Identifiable Information (PII) with opaque placeholders before forwarding to the upstream LLM provider (SAP AI Core / AWS Bedrock). The original PII never leaves the organization's network boundary.

**Key guarantees:**
- PII is detected and replaced **before** the request leaves the gateway
- The LLM provider receives only pseudonymized tokens (e.g., `MASKED_PERSON_1`)
- The gateway's payload logging provides an auditable evidence chain per request
- Activation is caller-controlled (explicit `masking` field or in-message triggerword) or operator-forced per model/endpoint via `api_config.json` — see §6
- Performance overhead is negligible (~0.12ms per message)

---

## 2. Architecture

```
┌─────────────┐          ┌──────────────────────────────────┐          ┌─────────────────┐
│   Client    │──────────▶│        Gateway (localhost)        │──────────▶│  LLM Provider   │
│  (internal) │          │                                  │          │  (SAP AI Core)  │
└─────────────┘          │  ┌────────────────────────────┐  │          └─────────────────┘
                         │  │  Pseudonymization Plugin    │  │
                         │  │                            │  │
                         │  │  1. Detect PII             │  │
                         │  │  2. Replace with tokens    │  │
                         │  │  3. Forward masked request │  │
                         │  │  4. Unmask response        │  │
                         │  └────────────────────────────┘  │
                         └──────────────────────────────────┘
```

**Network boundary:** PII exists only within the gateway process. The outbound HTTP request to the LLM provider contains only masked tokens.

---

## 3. Detection Capabilities

### 3.1 Detection Tiers (ordered by priority)

| Priority | Tier | Method | Entity Types |
|----------|------|--------|--------------|
| 0 | Custom regex | User-defined patterns | Domain-specific (permits, badges, employee IDs) |
| 1 | Structural regex | Pattern matching + validation | Email, phone, SSN, credit card (Luhn), IBAN (mod-97), URL, address, credentials, passport, driver's license, national ID, ITIN, bank account (ABA checksum + context), medical license (DEA checksum + context), IP address, organization (configured legal-form suffix), location (configured gazetteer) |
| 2 | NER | wink-nlp (POS tagging + heuristics) | Person names only — organization and location detection is configuration-driven at priority 1 (see above), not NER |
| 3 | Dictionary | Word-list matching (172 nationalities, 27 ethnicities, etc.) | Nationality, ethnicity, gender, religion, political group, sexual orientation, trade union |

### 3.2 Validation Rules

Structural detectors include post-detection validation to minimize false positives:

- **Credit card numbers**: Luhn algorithm check (rejects invalid checksums)
- **IBAN**: Mod-97 check (ISO 13616 validation)
- **Phone numbers**: Digit count validation (7–15 digits)
- **SSN**: Excludes invalid area numbers (000, 666, 900–999)
- **ABA routing numbers**: Weighted 3-7-1 checksum, plus a required nearby context word (`routing`/`ABA`/`RTN`) — a checksum alone admits roughly one in ten arbitrary 9-digit runs, so the context anchor is what makes the category safe to enable by default
- **DEA numbers**: Check-digit validation, plus a required nearby `DEA` context word, for the same reason — measured, roughly 1 in 10 two-letter-plus-seven-digit strings pass the checksum alone
- **ITIN**: Leading 9 plus IRS-assigned group ranges (50–65, 70–88, 90–92, 94–99); cannot collide with the SSN pattern, which already excludes the 9xx space
- **IP addresses**: Octet range validation; loopback/RFC1918/link-local addresses are never masked — the exclusion list is shared with URL masking so the two cannot drift apart
- **Organizations**: Matched only via a configured legal-form suffix, never inferred from capitalization; blank suffix entries are discarded rather than producing a degenerate pattern

### 3.3 Overlap Resolution

When multiple detectors match overlapping text, the system applies deterministic resolution:
1. Higher priority tier wins
2. Within same tier, longer match wins
3. Remaining ties resolved by position (leftward first)

---

### 3.4 Confidence Scoring and Tuning

Every detected candidate carries a confidence between 0 and 1, and masks only when that
score reaches a threshold. The technical-context filter (§3.3's neighbour, applied before
scoring) has already dropped identifiers, SQL columns, JSON keys, paths and code, so what
reaches the scorer is a candidate with no technical shape. Scoring then weighs what the
surrounding text says about it.

| Evidence | Score |
|---|---|
| Custom (operator-defined) regex | 1.0 |
| Checksum- or format-validated pattern (e-mail, SSN, IBAN, credit card, IP) | 0.95 |
| Organisation via a configured legal form; location via the configured gazetteer | 0.95 |
| Pattern that only fires next to a label (passport, driving licence, national ID, credentials) | 0.85 |
| wink-nlp entity verdict | 0.7 (never reached — see below) |
| Dictionary (nationality, religion, political group, …) | 0.5 |
| Capitalised-run heuristic | 0.5 |

The surrounding text then adjusts the score, each adjustment applying at most once:

| Adjustment | Change |
|---|---|
| Honorific, salutation or `contact` within 40 characters (or inside the value) | +0.3 |
| Adjacent mail address or phone number | +0.2 |
| A recognised given name among the value's words | +0.15 |
| The value IS the whole content of a quoted string — a SQL `'…'` literal or a JSON string value | +0.15 |
| Machinery around the value — an identifier in its own column or field, or a SQL statement, JSON key, fenced block, path or URL anywhere on its line | −0.15 |
| Every word of the value is an ordinary English word (a heading, a column label, a job title) | −0.15 |
| An ALL-CAPS word **in** the value | −0.3 |
| The value sits in a code block or a SQL statement (not as a quoted literal) | −0.3 |

A shouted word *next to* the value is not evidence at all: capitals are how people write
emphasis, headers, department names and log levels, so `URGENT: <name>`, `The ACCOUNTING team
says <name>` and a log line carrying a level all keep their name. Nor is the quantity of PII
in the request: each value is judged only on its own surroundings, so a roster of sixty names
masks sixty names. (Saturation is reported, never scored — §12.)

**No** negative adjustment applies to custom rules, checksum-validated identifiers or
credentials — the same exemption the technical-context suppression makes. That includes the
code/SQL one: a `password:` line inside a fenced block stays masked however high the
threshold is set, because a code block is exactly where credentials live.

The capitalised-run tier carries the weight for names, and its 0.5 is deliberate. The
bundled `wink-eng-lite-web-model` emits no PERSON / ORG / GPE entity type at all — it
recognises dates, amounts, ordinals and the like — so the 0.7 entity tier is wired but
**never reached**, and that heuristic is in practice the only detector of personal names
there is. A name is not only found in sentences: a table row, a CSV line, a bullet, a chat
prefix, a `Subject:` header, a JSON value and a SQL string literal are all ordinary places to
find one, and all of them scored below the bar while the base was lower. The two −0.15 rules
carry the evidence against instead — a machinery line, or a run made only of ordinary
English words — and the +0.15 data-literal rule cancels the first exactly where a real name
legitimately sits inside machinery. The machinery rule is field-scoped for identifiers and
JSON keys: a name in its own column of a table row or CSV line is a name, whatever the
neighbouring column holds. Only a fence and a line-anchored SQL statement colour a whole
line. A URL or a file path counts for nothing there — a link beside a name says nothing
about the name, and a name INSIDE a URL or a path is dropped by the technical-context filter
before scoring begins.

Replacing the NER engine is a follow-up outside this plan; until then, no measurement should
credit the 0.7 tier.

**Tuning.** `pseudonymization.min_confidence` (default 0.5) sets the bar for every category;
`pseudonymization.thresholds` overrides it per category, e.g. `{ "profile-person": 0.65 }`.
Both are optional, layered global → per-endpoint → per-model like `entities`, and editable
in the admin config app. Raise a category's threshold when it is masking noise; lower it
when a category is missing values a reviewer can see. A value outside 0–1 is
rejected by the config form and by the backend schema, and ignored by the gateway if it
reaches it another way.

**What a rise costs, measured.** Because the capitalised-run tier scores a bare name at
exactly 0.5, the first step above the default is the expensive one — measured on the shipped
corpus with `detectEntities` at each bar:

| `min_confidence` | technical precision / recall | prose precision / recall | credentials still masked |
|---|---|---|---|
| **0.5** (default) | 0.925 / 0.902 | 0.987 / **1.000** | yes |
| 0.55 | 0.972 / 0.854 | 0.952 / **0.256** | yes |
| 0.65 | 0.972 / 0.854 | 0.952 / 0.256 | yes |
| 0.8 | 1.000 / 0.585 | 1.000 / 0.180 | yes |

Three quarters of the names in ordinary prose are lost at 0.55. What survives is the
validated and label-anchored end of the range: mail addresses, IBANs, SSNs and credentials
mask at 0.8 unchanged, because no negative adjustment applies to them — a credential written
inside a code fence stays masked however high the bar is set. So a global rise is not the
tool for a noisy category, and a per-category threshold is not a way round the same cliff for
`profile-person`: `{ "profile-person": 0.7 }` leaves 5 of the corpus's 67 prose person labels
masked. Use the allow-list to exempt named values instead (§3.5).

---

### 3.5 Operator Allow-list and Saturation Reporting

`pseudonymization.allowlist` is an explicit, deployment-wide instruction NOT to mask:
`terms` are case-sensitive literals and `patterns` are regular expressions the gateway
anchors to the whole detected value (`^(?:…)$`) before compiling. It is applied after the
technical-context filter and before scoring, so a listed value is exempt regardless of the
evidence for masking it, and no threshold change can bring it back. It cannot cause more
masking: a value no detector produced is unaffected by anything in it. A pattern that does
not compile is skipped with one warning naming it, and the remaining entries still apply —
one typo must not silently return an operator's whole allow-list to masking. The lists of
the three layers are concatenated, so a per-model list can only add an exemption.

**This is a masking OFF switch, per value, and should be reviewed as one.** An over-broad
pattern is the failure mode worth guarding against: `[A-Z].*` compiles, matches almost every
person the run heuristic finds, and disables name masking for the deployment without erroring.
Three things narrow it. The anchoring makes the blast radius readable — an entry either
describes a whole value or it matches nothing. The config form and the backend schema both
hold the block to `terms`/`patterns` string arrays and nothing else. And every pattern that
compiles is measured against a frozen built-in sample of ordinary personal data — a person, a
mail address, a phone number and an IBAN, all synthetic — with one WARN per pattern source per
process when it matches any of them:

```
Allow-list pattern "[A-Z].*" also matches ordinary personal data — it may disable masking
far beyond what was intended. The pattern is still applied; narrow it if that was not the
intent (it is anchored to the whole detected value, so it needs to describe one completely).
```

It reports and never rejects. An operator may mean a broad entry, and refusing to apply a
valid one would be a second and worse surprise — but a masking control being switched off
must not be silent. The sample is deliberately small and fixed: it detects the careless
pattern, not the deliberate one, and no sample can do better than that.

`pseudonymization.saturation_warn` (default 40) is REPORT-ONLY. After masking, the distinct
masked values of the request are counted; above the number the gateway writes one WARN line
carrying the per-category histogram and the most common value SHAPES (letters as `X`, digits
as `9`, `_`/`-` kept, everything else `.`), and either way the request's usage SIEM event
carries `pseudonymization: { masked_values, categories, saturated }`. Neither carries a masked
value. The block is counts rather than text, so it is not subject to the §12 content gates and
reaches a sink that is not opted into content.

It can never lower a score or drop a mask. The spec's original −0.2 saturation adjustment was
removed for exactly that reason (task 2, fix round 3): keyed on a count crossing a threshold,
it was a cliff — a roster of 41 names masked nothing while the same roster of 30 masked all of
them — and it fired precisely where a request carried the most personal data. A test asserts
that a 60-name roster with the bar at 40 masks all sixty.

---

## 4. Evidence: Detection Test Results

### Test Case 1: Mixed PII (person, email, SSN, address)

```
INPUT:  John Smith (john.smith@sandiego.gov, SSN 123-45-6789) lives at 456 Oak Avenue.
OUTPUT: MASKED_PERSON_1 (MASKED_EMAIL_1, SSN MASKED_SOCIAL_SECURITY_NUMBER_1) lives at MASKED_ADDRESS_1.
```

| Entity Type | Original Value | Placeholder |
|-------------|---------------|-------------|
| profile-person | John Smith | MASKED_PERSON_1 |
| profile-email | john.smith@sandiego.gov | MASKED_EMAIL_1 |
| profile-ssn | 123-45-6789 | MASKED_SOCIAL_SECURITY_NUMBER_1 |
| profile-address | 456 Oak Avenue | MASKED_ADDRESS_1 |

### Test Case 2: Allow-list (organizational terms preserved)

```
INPUT:  Jane Doe works for City of San Diego in San Diego.
OUTPUT: MASKED_PERSON_1 works for City of San Diego in San Diego.
```

"San Diego" and "City of San Diego" are on the allow-list and pass through unmasked. Only the person name is detected and replaced.

### Test Case 3: Credit card with Luhn validation

```
INPUT:  Card 4111111111111111. Invalid: 4111111111111112.
OUTPUT: Card MASKED_CREDIT_CARD_1. Invalid: 4111111111111112.
```

Only the Luhn-valid number (`4111111111111111`) is masked. The invalid number (`4111111111111112`) is left untouched — no false positive.

### Test Case 4: Sensitive attributes (GDPR special categories)

```
INPUT:  He is Mexican, identifies as Buddhist, and voted Republican.
OUTPUT: He is MASKED_NATIONALITY_1, identifies as MASKED_RELIGIOUS_GROUP_1, and voted MASKED_POLITICAL_GROUP_1.
```

All three GDPR Article 9 special category attributes detected and masked.

### Test Case 5: Credentials and URLs

```
INPUT:  Use password: S3cr3t!Pass and api_key=sk-abc123xyz at https://portal.internal.com/admin
OUTPUT: Use MASKED_USER_PASSWORD_2 and MASKED_USER_PASSWORD_1 at MASKED_URL_1
```

Passwords, API keys, and internal URLs are all intercepted.

---

## 5. Evidence: Payload Log Chain

When `PAYLOAD_LOGGING_ENABLED=true`, the gateway writes timestamped JSON files capturing each processing stage. These provide an auditable chain of custody for each request.

### Log Stages

| Stage | File Pattern | Contents |
|-------|-------------|----------|
| 00 | `*_00_original_anthropic_request.json` | Original client request (contains PII) |
| 01 | `*_01_original_bedrock_request.json` | Request body sent to LLM provider (**contains only MASKED_ tokens**) |
| 02 | `*_02_native_request_to_sap.json` | Full HTTP request to SAP AI Core (masked) |
| 03 | `*_03_native_response_from_sap.json` | Raw response from LLM provider |
| 04 | `*_04_after_plugin_modified_response.json` | Response after unmasking (returned to client) |

### Verified Evidence Chain (actual log output)

**Stage 00 — Client sent (PII present):**
```json
{
  "messages": [{"role": "user", "content": "John Smith called Jane Doe yesterday."}]
}
```

**Stage 01 — Sent to LLM provider (PII replaced):**
```json
{
  "messages": [{"role": "user", "content": "MASKED_PERSON_1 called MASKED_PERSON_2 yesterday."}]
}
```

**Conclusion:** The LLM provider only received pseudonymized tokens. Original PII never crossed the network boundary.

---

## 6. Operating Modes

### Pseudonymization Mode
- Entities get unique identifiers: `MASKED_PERSON_1`, `MASKED_PERSON_2`
- A reverse map is maintained for the lifetime of the request
- The LLM response is unmasked before returning to the client
- All exact occurrences of a detected value are masked with the same token across the whole request (value-consistency propagation), so a secret caught in one place cannot ride through unmasked in another (e.g. an `Authorization: Bearer` header)
- `masking_info` audit field is attached to the response only when explicitly requested (body `masking.debug: true` or header `x-sail-proxy-masking-debug: on`); it is off by default for pseudonymization
- Which categories are masked is operator-configurable in `api_config.json` (`observability.pseudonymization.entities` toggles, layered global → endpoint → model) with the plugin's built-in category set as the fallback default; toggles apply to force-config/triggerword activation, not to explicit caller `masking` requests
- `profile-org` and `profile-location` additionally require their own inputs — `observability.pseudonymization.org_suffixes` and `observability.pseudonymization.location_gazetteer` respectively, layered the same global → endpoint → model way. The location gazetteer ships empty, so enabling `profile-location` masks nothing until an operator populates it; enabling either category with no configured input logs a one-time warning naming the category

### Anonymization Mode
- Entities get unique identifiers (for LLM comprehension): `MASKED_PERSON_1`, `MASKED_PERSON_2`
- **No reverse map is stored** — original values are irrecoverable
- The LLM response is **not** unmasked — placeholders remain in the output
- Irreversible by design

### Activation Methods

The plugin supports four activation methods, evaluated in priority order (first match wins):

**1. Explicit `masking` field in request body (fine-grained, caller-controlled):**
Allows specifying entity types, replacement strategies, allow-lists, and custom regex patterns per request.

**2. Triggerword in message content (zero-config, caller-controlled):**
Include `<sail-proxy:pseudonymization:on>` or `<sail-proxy:anonymization:on>` in any message. The triggerword is stripped before processing — it never reaches the LLM. Activates masking with the plugin's default category set enabled (see §6); `profile-org`, `profile-location`, and `profile-ip-address` are opt-in and stay off unless an operator enables them in `api_config.json`.

**3. Per-model force flag (operator-controlled):**
`api_config.json` → `models.overrides[<id>].pseudonymization.enabled: true`. Activates masking on every request to that model regardless of caller.

**4. Per-endpoint force flag (operator-controlled):**
`api_config.json` → `hooks.defaults.<endpoint>.pseudonymization.enabled: true`. Activates masking on every request to that endpoint regardless of model or caller. Per-model takes precedence when both are set.

All four methods feed into the same masking pipeline. Operator-controlled methods (3, 4) cannot be overridden by adversarial prompt content — only by operator-gated bypass (see below).

### User-initiated bypass of forced pseudonymization

When activation came from a force flag (Method 3 or 4), an operator can optionally allow callers to opt out per-request by setting `allow_user_bypass: true` on the matching block in `api_config.json`. Default is `false`.

**Bypass mechanisms (both gated by `allow_user_bypass`):**
- HTTP header: `x-sail-proxy-pseudonymization: off`
- Body field: `"pseudonymization_off": true` (stripped from the body before forwarding so the LLM never sees it)

**Threat model:**
- A caller with valid API credentials can disable masking for their requests when bypass is enabled — PII would then reach the LLM provider unmasked.
- This is by design: bypass exists for operators who want flexibility on internal/development endpoints.

**Mitigations:**
1. **Default-deny.** `allow_user_bypass` defaults to `false`. Operators must explicitly opt in per endpoint or per model.
2. **Out-of-band signals only.** Bypass is requested via HTTP header or top-level body field, never from prompt content. A malicious or accidental string inside a user message, tool result, or web search result cannot trigger bypass — even when `allow_user_bypass` is `true`.
3. **Audit logging.** Every applied bypass is logged at INFO with the API key id, endpoint, model, and bypass source. Every rejected bypass attempt (when the flag is `false`) is logged at WARN. Both records are emitted by the gateway's structured logger.
4. **Caller intent precedence.** An explicit `masking` field or an ON triggerword in the same request defeats bypass — both represent unambiguous intent to mask.

**Operator recommendation:** leave `allow_user_bypass: false` for endpoints subject to PII compliance regimes (GDPR Art. 32 technical and organizational measures). Enable only on internal / development endpoints where the trade-off is explicitly accepted and audit log review is in place.

---

## 7. Performance Impact

Benchmarked on a 190-character message containing 6 entity types (500 iterations, Node.js v20):

| Component | Latency |
|-----------|---------|
| Regex detectors (email, SSN, CC, URL, address, credentials) | 0.003 ms |
| NER detector (wink-nlp person only) | 0.129 ms |
| Dictionary detector (nationality, religion, political) | 0.003 ms |
| **Full pipeline (detect + resolve + replace)** | **0.119 ms** |

**Overhead relative to LLM call latency:**
- Typical LLM response time: 500–3000 ms
- Pseudonymization overhead: ~0.12 ms
- **Percentage overhead: 0.004%–0.024%**

The plugin adds zero perceptible latency either way. The near-zero-cost no-op path applies only when none of the four activation methods (see §6) fire for a request; on force-enabled endpoints — `anthropic`, `openai`, and `aws-bedrock` by default — every request instead runs full detection at the ~0.12 ms measured above.

---

## 8. NER Engine

**Library:** wink-nlp v2.4.0 with wink-eng-lite-web-model v1.8.1

**How it works:**
1. wink-nlp tokenizes the text and applies Part-of-Speech (POS) tagging
2. Tokens tagged as `PROPN` (proper noun) are identified
3. Consecutive proper nouns (2–4 tokens) are grouped as person name candidates
4. A heuristic exclusion list filters common false positives (sentence-initial words)
5. Each detected name is searched for ALL occurrences in the text (idempotent masking)

**Model size:** ~3.5 MB (bundled via npm, no runtime downloads)
**Language support:** English

---

## 9. Security Controls

### Data at Rest
- No PII is persisted by the plugin's per-request masking pipeline (the replacement map, below); the optional learned entity cache is a deliberate, scoped exception — see "Learned Entity Cache" below
- The replacement map exists only in process memory for the duration of a single request
- After the response is sent, the map is garbage collected
- Payload logs (when enabled) are local files under operator control

### Data in Transit
- PII exists only between the client and the gateway (internal network)
- The outbound connection to the LLM provider carries only masked tokens
- TLS protects both segments independently

### Configuration Security
- The plugin activates via any of four methods (see §6): an explicit `masking` field, an in-message triggerword, or an operator-set per-model/per-endpoint force flag in `api_config.json`
- PII detection also occurs with no client field at all on force-enabled models/endpoints — e.g., this gateway force-enables pseudonymization on the `anthropic`, `openai`, and `aws-bedrock` endpoints today
- Allow-lists and entity type selection are per-request and client-controlled only on the explicit `masking` field path; on the triggerword and force-config paths, entity type selection uses the operator-configured default category set and allow-lists are unavailable
- Custom regex patterns are per-request (not persisted)

### Learned Entity Cache
- Optional Valkey-backed cache stores confirmed entity text (e.g., "John Smith") keyed by type
- Valkey entries expire after 7 days (TTL); the in-memory fallback has no TTL and is instead capped at 10,000 entries with oldest-first (LRU) eviction
- Cache stores only the entity text, not the replacement mapping
- Falls back to in-memory LRU if Valkey is unavailable
- Cache improves detection speed for repeat entities but is not required for operation

---

## 10. Testing Methodology

### Unit Tests (217 tests)
```bash
pnpm test:pseudonymization
```

Covers: entity detection accuracy, Luhn validation, overlap resolution, allow-list filtering, idempotent replacement, streaming buffer (split-token & prefix-collision handling), anonymization mode, plugin handler lifecycle, content-derived stable tokens (cross-request stability, collision probing), URL origin masking (composable pseudo-URLs, scheme switches, loopback/private/template skip), no-double-masking, JSON-credential detection, non-streaming `res.json`/cache-hit unmasking, organization/location detection and round-trip masking (configured legal-form suffixes, gazetteer-driven locations), US identifier types (ITIN, SSN, ABA-routing, DEA, IP address) with checksum and context-word validation, and entity-toggle activation gating (opt-in categories, entities-less config never activates masking).

### Integration Tests (7 scenarios, 17 assertions)
```bash
pnpm test:pseudonymization:integration -- --api-key YOUR_KEY
```

Exercises the full gateway pipeline end-to-end:
1. Basic pseudonymization (mask + unmask + masking_info)
2. Allow-list preservation
3. Custom regex detection
4. Anonymization mode (irreversible)
5. Pass-through config: `masking_info` is absent from the response when no `masking` field is given — this endpoint is force-enabled in the shipped `api_config.json`, so masking still runs; the test verifies the audit field's default-off behavior, not that masking was skipped
6. Triggerword activation (pseudonymization)
7. Triggerword activation (anonymization)

### Payload Log Verification

```bash
# Start gateway with logging
DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev

# After any request with masking, inspect:
ls -lt ./logs/payloads/

# Verify masked content was sent to LLM:
grep "MASKED_" ./logs/payloads/*01_original_bedrock_request*.json

# Verify original PII was NOT sent:
grep "John Smith" ./logs/payloads/*01_original_bedrock_request*.json  # should return nothing
```

---

## 11. Limitations and Residual Risks

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| NER is English-only | Non-English names may not be detected | Custom regex can cover known non-English patterns |
| Address detection covers US street patterns only | International addresses may pass through | Supplement with custom regex for target locales |
| A capitalised name surrounded by machinery is not masked | A name sharing its column with an identifier or a JSON key, or its line with a SQL statement or a code fence, scores 0.35 unless it is itself a quoted literal | Deliberate — that is the shape the 2026-08-25 incident was made of. A name in its own table column, in a JSON value or in a SQL string literal, which is where real data sits, scores 0.5 and is masked |
| A capitalised phrase of ordinary English words is not masked | "Data Transfer Process", "Senior Auditor": every word is a common noun, so the run scores 0.35 | Deliberate. A person whose name consists entirely of ordinary English words is not covered; the word list holds no surname or given name, so the run cancels as soon as one real name token appears |
| Name detection rests on capitalisation, not on a model | The bundled NER model emits no person entity, so the 0.7 tier never fires and an uncapitalised or unusually written name has nothing to catch it | Known gap; replacing the NER engine is tracked outside this plan. `profile-person` recall is best improved today by populating a custom regex for names the deployment knows |
| A Title-Case product or system name is masked as a person | `Watson Studio`, `Redis Sentinel` mask at `profile-person@0.5`. Neither is made of ordinary English words, so the common-words adjustment does not fire and nothing else distinguishes them from a name | Name them in `allowlist.terms` (§3.5). The residual is measured, not hidden: both are unlabelled corpus cases, so they count against technical precision in the harness |
| An internal double space inside a name defeats the tokeniser | `owner: Miguel  Torres` masks nothing; `owner: Miguel Torres` masks correctly. wink-nlp drops the capitalised run when it is split by a double space, before scoring sees it | Not fixed. Pinned as a labelled corpus case (`log-line-double-space`) so it costs recall visibly rather than silently |
| A signature block can lift a job title into a person mask | `Regards,` / name / `Senior Auditor`: the honorific bonus reaches 40 characters backwards, so both lines of the block take +0.3 and the title line masks at `profile-person@0.65` | Not fixed. Labelled NOT PII in the corpus (`signature-block`), so it shows correctly as a prose-set false positive |
| Short dictionary terms may false-positive | Common words in dictionaries (e.g., "Liberal" in political context) | Allow-list can exempt specific terms |
| Organization detection requires a configured suffix | A bare name like "Apple" is never masked as an organization — only a capitalized run immediately followed by a configured legal-form suffix (e.g., "Apple Inc") is detected | Deliberate: the ambiguity is resolved by refusing to guess rather than by classification. Populate `org_suffixes` with all legal forms in use; supplement with custom regex for names that never carry one |
| Stateless per-request | Multi-turn conversations re-mask each time | Content-derived tokens keep this consistent (same value → same token); a token whose value is absent from the current request cannot be unmasked and is flagged by the leak audit |
| Stable tokens are linkable | The same entity yields the same token across requests, allowing correlation by an observer of masked traffic | Inherent to reversible pseudonymization; use anonymization mode for unlinkability |
| Loopback/private/template URLs not masked | Local/dev/infra endpoints reach the LLM unmasked | Deliberate data-minimization — these carry no personal data and masking them broke edit workflows; public hosts are still masked |
| Unmask depends on verbatim token reproduction | A model that garbles a placeholder id produces an unrecoverable value | Copy-friendly decimal ids, a verbatim-copy system instruction, and composable URL placeholders; leak audit flags misses |
| No image/file PII detection | PII in uploaded images is not detected | Out of scope for text-based masking |
| An over-broad allow-list pattern disables masking | `allowlist.patterns` is applied before scoring and outranks every threshold; `[A-Z].*` compiles and exempts almost every detected name | No longer silent: every compiled pattern is tested against a built-in sample of ordinary personal data (name, mail address, phone number, IBAN) and one WARN names it, without rejecting it (§3.5). Anchoring bounds it further — an entry describes a complete value or matches nothing — and both the config form and the backend schema constrain the block. A deliberately narrow-but-wrong entry still passes; review allow-list changes as masking changes, because that is what they are |
| Saturation is reported, never enforced | A request carrying hundreds of distinct values is logged and flagged on its SIEM event, but nothing throttles or blocks it | Deliberate — the alternative was tried and removed: a rule keyed on the count stopped masking exactly when a request held the most personal data. Enforcement, if wanted, belongs in a policy layer above the plugin, not in the scorer |

---

## 12. SIEM Event Export

Independent of the masking pipeline above, the gateway can export its own security and audit
events (not LLM prompts or responses) to an external SIEM. This section documents what that
export path does and does not carry, since it is a second channel out of the gateway and
governed by the same data-minimization concerns as masking.

### 12.1 Path and Scope

A security or audit event is normalized into a single `SiemEvent` shape, written once to a
durable outbox (`SiemOutbox`), and delivered at-least-once to each individually enabled sink
via a per-sink delivery row (`SiemDelivery`), so one failing sink cannot block the others. Six
sink types exist — `webhook`, `otel`, `datadog`, `azure_sentinel`, `gcs_pubsub`, `s3` — configured
under `api_config.observability.siem` in `api_config.json`.

Dispatch requires two switches to both be true: `observability.siem.enabled` (the master switch) and the
individual sink's own `enabled`. **In the shipped `api_config.json`, the master switch and all
six configured sinks are `enabled: false`.** The export path exists in code and is unit-tested,
but nothing is currently deployed or delivering events anywhere.

### 12.2 Metadata Only as Shipped, Content Only by Explicit Opt-In

The normalized `SiemEvent` carries metadata: an event id, timestamp, category
(`security`/`audit`/`usage`), type, severity, outcome, actor fields (a credential identifier or
hash-based hint, auth type, client IP, user agent), resource fields (type, id, model, endpoint —
with any query string stripped), a request id/status, and a length-capped description. **As
shipped it carries no LLM prompt or response text**, and the `security` and `audit` events — the
only ones the gateway emits without an operator opting in — cannot carry any at all.

A per-sink `include_content` boolean has been in the schema since the export landed. It is now
implemented, and only on the `usage` category: one request-completion event per request, which
exists to carry content and nothing else does. Three gates stand in front of it, all default-off:

1. `observability.siem.categories` must include `usage`. The shipped configuration lists only
   `security` and `audit`, so no usage event is emitted at all.
2. Some *enabled* sink must have `include_content: true`. The gateway checks this before
   attaching anything, so content no sink asked for is never written to the outbox — a
   deliberate divergence from `include_credential_material`, which is carried through the
   outbox and stripped at send. A credential hint is small; a conversation is not.
3. The dispatcher strips `content` again, per sink, on the copy sent to that sink.

What ships under `include_content` alone is the **masked** form: the pseudonymized text this
document's guarantees produce, placeholders rather than PII, taken from the pipeline's own output
rather than re-read from the body. A request that bypassed masking is marked `masked: false` and
withheld — the sink receives `content.omitted: 'not-masked'` and no text.

Raw conversation content leaves the system under exactly one combination:
`include_content` **and** `allow_unmasked_content` on the same enabled sink, with masking
disabled or bypassed for that request. That is a second data path off the gateway carrying
unmasked conversation content to a third party — the exposure this document's masking guarantees
exist to prevent. It is deliberately reachable only by an operator who sets two separate
default-false flags whose descriptions state the risk, it is asserted positively in the test
suite so that it is a known property rather than a later discovery, and it should not be enabled
anywhere without re-assessing it against those guarantees.

Both prompt and response are capped independently at `observability.siem.content_max_bytes` (default 8192),
and a cut event carries `content.truncated: true`.

A related, separately-implemented flag, `include_credential_material`, **is** wired: an
unresolved credential's raw presented value is stripped from every event before it is sent to a
sink, unless that specific sink has opted in (default `false`), for example for forensic use.

### 12.3 Streaming Responses

The instant a non-streaming response exists as one complete string is the pseudonymization
after-handler, just before it unmasks the text for the client — that string is what
`include_content` ships. A streamed response never has that instant: it leaves as a sequence of
deltas. The masked deltas are accumulated in a plain in-memory array on the request as they pass
the same handler, capped at `content_max_bytes`, and assembled into one string once the stream
ends — published through the same path a non-streaming response uses. Nothing is accumulated
unless the configuration in force says some enabled sink will actually receive content: a
gateway with no content sink allocates nothing extra for this per request. Accumulating in
process memory rather than round-tripping every delta through the outbox keeps the per-chunk cost
to one array push per delta; measured over 400 requests per arm at 200 deltas per stream, the
effect on time-to-first-token was indistinguishable from zero (-0.000 to +0.010 ms mean).

A stream that errors or that the client abandons before it finishes never has a complete response
to publish. Publishing a partial answer as though it were the whole one would be worse than
publishing none, so such a request ships the masked **prompt** only — no `response` — with
`content.omitted: 'stream-incomplete'`, distinguishing "this stream did not finish" from "this
request had no response".

A response is captured at all only when the pseudonymization plugin ran in **pseudonymization**
mode; anonymization mode never unmasks and never stashes the masked response for export, so it
ships the masked prompt with no response text. The same is true when masking was bypassed for a
request: no response is captured, and the prompt itself ships only through the
`allow_unmasked_content` path described above (§12.2) — otherwise the whole `content` block is
withheld as `{ omitted: 'not-masked' }`. This holds on both the streaming and non-streaming paths.

### 12.4 Sink Credential Storage

Sink credentials (a webhook bearer token, a Datadog API key, a cloud service-account key, etc.)
are never stored in `api_config.json` — the config carries only the *name* of a credential slot
(e.g. `SIEM_DATADOG_API_KEY`), constrained by the schema to `^[A-Z][A-Z0-9_]*$`. The value is
entered once through the cockpit (see Chapter 6) and stored in a dedicated `SiemCredentials`
table:

- **Encryption**: AES-256-GCM, with a random 32-byte salt and a random 16-byte IV generated per
  write. The encryption key is derived from a master key (`SIEM_CREDENTIAL_KEY`) via `scrypt`,
  keyed by `(salt, master key)` — a derived key is cached only as long as the master key that
  produced it is still current. GCM's authentication tag detects tampering with stored
  ciphertext, which the AWS-credential store's AES-256-CBC (see Chapter 6, AWS Credential
  Management) cannot.
- **Scoping**: a credential is scoped to the configuration it was set on — the same slot name can
  hold different values in two different configurations, and only the active configuration's
  values are ever resolved for dispatch. Deleting a configuration deletes its credentials with it
  (a database-level composition/cascade).
- **No environment fallback**: the credential store is the only source a sink resolves a
  credential from. `SIEM_CREDENTIAL_KEY` itself (the master encryption key) is the sole
  `process.env` read anywhere in the SIEM module tree — every credential *value* comes from the
  encrypted store, never from an environment variable.
- **Values are never returned**: the API that lists stored credentials returns metadata only
  (slot name, masked hint, who set it and when) — never the plaintext or the ciphertext.

### 12.5 Master Key Rotation Is Destructive

`SIEM_CREDENTIAL_KEY` is read fresh on every encrypt/decrypt call rather than cached at process
start, so a rotated value takes effect immediately, without a restart. That immediacy has a
consequence: because every stored credential's encryption key is derived from `(that credential's
own random salt, SIEM_CREDENTIAL_KEY)`, **rotating `SIEM_CREDENTIAL_KEY` makes every previously
stored credential undecryptable.** Decryption fails GCM's authentication check, the store logs
the failure (never the value) and treats the credential as unset, and the affected sink stops
authenticating until an admin re-enters the credential through the cockpit. There is no
automatic re-encryption path across a key rotation — each credential must be re-entered by hand.
Operators rotating `SIEM_CREDENTIAL_KEY` should plan to re-enter every stored SIEM credential
immediately afterward.

---

## 13. Compliance Mapping

| Requirement | How Addressed |
|-------------|--------------|
| GDPR Art. 4(5) — Pseudonymization definition | Entities replaced with tokens that cannot identify the subject without additional information (the reverse map) |
| GDPR Art. 9 — Special categories | Nationality, ethnicity, religion, political opinion, sexual orientation, trade union membership all detected |
| CCPA — PI categories | Names, email, SSN, address, financial (credit card), credentials all covered |
| Data minimization principle | Only masked tokens sent to third-party processor; originals stay within data controller boundary |
| Right to erasure compatibility | Anonymization mode produces irreversible masking (no reverse map stored) |

---

## 14. Appendix: How to Reproduce

```bash
# 1. Start gateway with payload logging
cd services/gateway
DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev

# 2. Create an API key
curl -s -X POST http://localhost:3000/api/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"security-test","email":"security@org.com"}'

# 3a. Send a request using the triggerword (simplest method)
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role":"user","content":"<sail-proxy:pseudonymization:on> John Smith (SSN 123-45-6789) lives at 456 Oak Ave. Email: john@example.com"}],
    "max_tokens": 100
  }'

# 3b. Or with explicit masking config (fine-grained control)
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role":"user","content":"John Smith (SSN 123-45-6789) lives at 456 Oak Ave. Email: john@example.com"}],
    "max_tokens": 100,
    "masking": {
      "method": "pseudonymization",
      "entities": [
        {"type":"profile-person"},
        {"type":"profile-email"},
        {"type":"profile-ssn"},
        {"type":"profile-address"}
      ]
    }
  }'

# 4. Verify evidence chain
# Original request (has PII):
cat logs/payloads/*00_original_anthropic_request*.json | python3 -m json.tool

# What was sent to LLM provider (PII replaced):
cat logs/payloads/*01_original_bedrock_request*.json | python3 -m json.tool

# 5. Run automated test suite
pnpm test:pseudonymization
pnpm test:pseudonymization:integration -- --api-key YOUR_KEY
```
