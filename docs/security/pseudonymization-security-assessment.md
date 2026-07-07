# PII Pseudonymization Plugin — Security Assessment

**Date:** 2026-05-13 (updated 2026-07-07)
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
- The feature is opt-in per request via a `masking` configuration field
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
| 1 | Structural regex | Pattern matching + validation | Email, phone, SSN, credit card (Luhn), IBAN (mod-97), URL, address, credentials, passport, driver's license, national ID |
| 2 | NER | wink-nlp (POS tagging + heuristics) | Person names, organizations, locations |
| 3 | Dictionary | Word-list matching (190+ nationalities, 25+ ethnicities, etc.) | Nationality, ethnicity, gender, religion, political group, sexual orientation, trade union |

### 3.2 Validation Rules

Structural detectors include post-detection validation to minimize false positives:

- **Credit card numbers**: Luhn algorithm check (rejects invalid checksums)
- **IBAN**: Mod-97 check (ISO 13616 validation)
- **Phone numbers**: Digit count validation (7–15 digits)
- **SSN**: Excludes invalid area numbers (000, 666, 900–999)

### 3.3 Overlap Resolution

When multiple detectors match overlapping text, the system applies deterministic resolution:
1. Higher priority tier wins
2. Within same tier, longer match wins
3. Remaining ties resolved by position (leftward first)

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
- `masking_info` audit field is attached to the response

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
Include `<sail-proxy:pseudonymization:on>` or `<sail-proxy:anonymization:on>` in any message. The triggerword is stripped before processing — it never reaches the LLM. Activates masking with all entity types enabled.

**3. Per-model force flag (operator-controlled):**
`api_config.json` → `model_list_changes[<id>].pseudonymization.enabled: true`. Activates masking on every request to that model regardless of caller.

**4. Per-endpoint force flag (operator-controlled):**
`api_config.json` → `defaultHooks.<endpoint>.pseudonymization.enabled: true`. Activates masking on every request to that endpoint regardless of model or caller. Per-model takes precedence when both are set.

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
| NER detector (wink-nlp person/org/location) | 0.129 ms |
| Dictionary detector (nationality, religion, political) | 0.003 ms |
| **Full pipeline (detect + resolve + replace)** | **0.119 ms** |

**Overhead relative to LLM call latency:**
- Typical LLM response time: 500–3000 ms
- Pseudonymization overhead: ~0.12 ms
- **Percentage overhead: 0.004%–0.024%**

The plugin adds zero perceptible latency. When no `masking` field is present in the request, the plugin performs a single `undefined` check and returns immediately (true zero-cost no-op).

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
- No PII is persisted by the plugin
- The replacement map exists only in process memory for the duration of a single request
- After the response is sent, the map is garbage collected
- Payload logs (when enabled) are local files under operator control

### Data in Transit
- PII exists only between the client and the gateway (internal network)
- The outbound connection to the LLM provider carries only masked tokens
- TLS protects both segments independently

### Configuration Security
- The plugin activates only when the client sends a `masking` field in the request body
- No PII detection occurs for requests without this field
- Allow-lists and entity type selection are per-request (client-controlled)
- Custom regex patterns are per-request (not persisted)

### Learned Entity Cache
- Optional Valkey-backed cache stores confirmed entity text (e.g., "John Smith") keyed by type
- Cache entries expire after 7 days (TTL)
- Cache stores only the entity text, not the replacement mapping
- Falls back to in-memory LRU if Valkey is unavailable
- Cache improves detection speed for repeat entities but is not required for operation

---

## 10. Testing Methodology

### Unit Tests (65 tests)
```bash
pnpm test:pseudonymization
```

Covers: entity detection accuracy, Luhn validation, overlap resolution, allow-list filtering, idempotent replacement, streaming buffer (split-token & prefix-collision handling), anonymization mode, plugin handler lifecycle, content-derived stable tokens (cross-request stability, collision probing), URL origin masking (composable pseudo-URLs, scheme switches, loopback/private/template skip), no-double-masking, JSON-credential detection, and non-streaming `res.json`/cache-hit unmasking.

### Integration Tests (12 tests)
```bash
pnpm test:pseudonymization:integration -- --api-key YOUR_KEY
```

Exercises the full gateway pipeline end-to-end:
1. Basic pseudonymization (mask + unmask + masking_info)
2. Allow-list preservation
3. Custom regex detection
4. Anonymization mode (irreversible)
5. Pass-through (no masking config = no overhead)

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
| Short dictionary terms may false-positive | Common words in dictionaries (e.g., "Liberal" in political context) | Allow-list can exempt specific terms |
| Context-free detection | "Apple" as company vs. fruit not distinguishable | NER + overlap resolution handles most cases |
| Stateless per-request | Multi-turn conversations re-mask each time | Content-derived tokens keep this consistent (same value → same token); a token whose value is absent from the current request cannot be unmasked and is flagged by the leak audit |
| Stable tokens are linkable | The same entity yields the same token across requests, allowing correlation by an observer of masked traffic | Inherent to reversible pseudonymization; use anonymization mode for unlinkability |
| Loopback/private/template URLs not masked | Local/dev/infra endpoints reach the LLM unmasked | Deliberate data-minimization — these carry no personal data and masking them broke edit workflows; public hosts are still masked |
| Unmask depends on verbatim token reproduction | A model that garbles a placeholder id produces an unrecoverable value | Copy-friendly decimal ids, a verbatim-copy system instruction, and composable URL placeholders; leak audit flags misses |
| No image/file PII detection | PII in uploaded images is not detected | Out of scope for text-based masking |

---

## 12. Compliance Mapping

| Requirement | How Addressed |
|-------------|--------------|
| GDPR Art. 4(5) — Pseudonymization definition | Entities replaced with tokens that cannot identify the subject without additional information (the reverse map) |
| GDPR Art. 9 — Special categories | Nationality, ethnicity, religion, political opinion, sexual orientation, trade union membership all detected |
| CCPA — PI categories | Names, email, SSN, address, financial (credit card), credentials all covered |
| Data minimization principle | Only masked tokens sent to third-party processor; originals stay within data controller boundary |
| Right to erasure compatibility | Anonymization mode produces irreversible masking (no reverse map stored) |

---

## 13. Appendix: How to Reproduce

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
