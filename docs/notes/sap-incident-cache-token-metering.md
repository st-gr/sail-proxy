# SAP Incident — Cache Read/Write Input Token metering vs. model API–reported counts

> Draft to file a support incident with SAP for **SAP AI Core (Generative AI Hub, Extended plan)**.
> Fill in the bracketed `[...]` tenant identifiers before submitting. Component:
> **CA-ML-AIC** (SAP AI Core) / BTP metering.

## Summary

For Anthropic Claude models consumed through SAP AI Core's generative AI hub, the
**"Cache Read Input Tokens"** figure shown in BTP usage/metering is **~2× the
`cache_read_input_tokens` value the model inference API returns** for the same
requests, consistently across four billing months. The **"Cache Write Input
Tokens"** figure does not reconcile at all against the API-returned
`cache_creation_input_tokens`. We would like SAP to clarify how these two metered
quantities are defined and computed, and how they convert into GenAI Tokens and
Capacity Units.

## Environment

- Service: **SAP AI Core**, service plan **Extended**, **Generative AI Hub**.
- Subaccount: **[subaccount name / ID]** (region **[e.g. us-central1]**).
- Global account: **[global account ID]**.
- Models: `anthropic--claude-4.5-sonnet--deployed`,
  `anthropic--claude-4.8-opus--deployed` (Anthropic Claude served via the
  Bedrock-backed deployment; inference responses carry `msg_bdrk_…` ids).
- Access: orchestration + native deployment via the AI Core inference API, with
  Anthropic prompt caching (`cache_control`) enabled.
- Billing months analysed: **March–June 2026**.

## What we measured

We record, per request, the exact `usage` object returned by the model inference
API — `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens` — and aggregate them per month. We then compare those
aggregates to the corresponding BTP metering line items.

### Cache Read Input Tokens — a consistent ~2× gap

| Month (2026) | BTP "Cache Read Input Tokens" | API-reported `cache_read_input_tokens` (sum) | BTP ÷ API |
|---|---:|---:|---:|
| March | 1,071,637,966 | 553,181,834 | **1.94×** |
| April | 4,066,429,164 | 2,066,865,011 | **1.97×** |
| May   | 17,334,632,539 | 8,704,921,649 | **1.99×** |
| June  | 8,004,694,289 | 4,129,177,753 | **1.94×** |

The BTP metric is close to **twice** the token count the API reports as read from
cache, stable across four months and two subaccounts.

### Cache Write Input Tokens — does not reconcile

| Month (2026) | BTP "Cache Write Input Tokens" | API-reported `cache_creation_input_tokens` (sum) | BTP ÷ API |
|---|---:|---:|---:|
| March | 58,136,359 | 10,398,438 | 5.6× |
| April | 225,262,924 | 4,545,585 | 49.6× |
| May   | 402,792,093 | 8,600,231 | 46.8× |
| June  | 364,230,376 | 85,373,276 | 4.3× |

By contrast, plain **Input Tokens** and **Output Tokens** reconcile within a few
percent every month, so the discrepancy is specific to the two cache metrics.

### Controlled two-turn probe (2026-08-30)

To rule out a measurement error on our side, we issued a controlled pair of
requests with a single ~2,362-token cacheable prefix (`cache_control: ephemeral`,
5-minute TTL) to `anthropic--claude-4.5-sonnet--deployed`:

- **Turn 1 (cache write):** API `usage` = `cache_creation_input_tokens: 2362`,
  `cache_read_input_tokens: 0`, `input_tokens: 13`, `output_tokens: 4`,
  `cache_creation.ephemeral_5m_input_tokens: 2362`.
- **Turn 2 (cache read):** API `usage` = `cache_read_input_tokens: 2362`,
  `cache_creation_input_tokens: 0`, `input_tokens: 13`, `output_tokens: 4`.

The API-reported cache counts are internally consistent and match the size of the
cached prefix. Our records equal these API values exactly; the divergence is
between the **API-reported counts** and the **BTP-metered counts**.

## What we already checked (so you can skip it)

- Anthropic and AWS Bedrock apply their cache multipliers to **price**, not token
  **count** (cache read ≈ 0.1× input price; cache write ≈ 1.25× for 5-min TTL,
  2× for 1-hour TTL). None of these is a factor-of-two on the **token count**, so
  the ~2× we see on the **count** is not explained by the published Anthropic /
  Bedrock pricing model.
- The gap is not double-counting on our side: each request is recorded once, and
  the controlled probe shows our records equal the API `usage` exactly.

## Questions for SAP

1. **Cache Read (the ~2×):** How is the BTP **"Cache Read Input Tokens"** metric
   computed relative to the `cache_read_input_tokens` returned by the model
   inference API? Is a multiplier or a distinct counting convention applied
   (e.g. related to cache TTL tier, or cached tokens being counted in more than
   one metric)? Is the factor of ~2 expected?
2. **Cache Write:** How is **"Cache Write Input Tokens"** computed relative to
   `cache_creation_input_tokens`, and what accounts for its month-to-month
   variability against the API-reported counts?
3. **Conversion to GenAI Tokens / CU:** What are the per-type conversion rates
   from Cache Read Input Tokens and Cache Write Input Tokens to **GenAI Tokens**,
   and then to **Capacity Units**? (We are reconciling against SAP Note 3437766.)
4. **Path dependence:** Does cache-token metering differ between the **native
   deployment** path (Anthropic via Bedrock) and the **orchestration** path?
5. **Overlap with Input Tokens:** Are cached tokens also included in the
   **"Input Tokens"** metric, or are the three input-side metrics (Input, Cache
   Read, Cache Write) mutually exclusive?

## Desired outcome

A definitive description of how Cache Read/Write Input Tokens are metered and how
they convert to Capacity Units, so we can reconcile our per-request usage capture
to the BTP invoice to the token. If the ~2× on cache read is an intended metering
convention, please confirm the exact multiplier and the models/paths it applies
to.

---

*Prepared from an internal reconciliation of per-request model-API usage against
BTP metering, March–June 2026, plus a controlled two-turn cache probe on
2026-08-30.*
