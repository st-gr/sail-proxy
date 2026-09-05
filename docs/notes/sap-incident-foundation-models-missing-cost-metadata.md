# SAP Incident — `foundation-models` API omits `cost` for several billable models

> Draft to file a support incident with SAP for **SAP AI Core (Generative AI Hub,
> Extended plan)**. Fill in the bracketed `[...]` tenant identifiers before
> submitting. Component: **CA-ML-AIC** (SAP AI Core).

## Summary

The model-catalog API

```
GET /v2/lm/scenarios/foundation-models/models
```

returns each model's per-token price in `versions[].cost`
(`[{"inputCost": "..."}, {"outputCost": "..."}]`). For **14 of the 62 models**
our tenant is offered, this `cost` field is **absent**, even though those models
are deployable, billable, and (per **SAP Note 3437766**) have defined pricing.
Comparable models in the same response *do* carry `cost`. This inconsistency
prevents programmatic cost tracking and estimation for the affected models —
notably the newest GPT-5.x models.

## Environment

- Service: **SAP AI Core**, service plan **Extended**, **Generative AI Hub**.
- Subaccount: **[subaccount name / ID]**, region **[e.g. us-central1 / us30]**.
- Global account: **[global account ID]**.
- API base: `[SAP_AI_CORE_URL, e.g. https://sap.example]`
- Resource group: `default`.
- Observed: **2026-08-30**.

## What the API returns

For 48 of 62 models, each version carries a price, e.g.:

| Model | `versions[].cost` |
|---|---|
| `anthropic--claude-4.5-sonnet` | `[{"inputCost": "0.00223"}, {"outputCost": "0.01087"}]` |
| `gpt-4o` | `[{"inputCost": "0.00312"}, {"outputCost": "0.0092"}]` |
| `gemini-2.5-flash` | `[{"inputCost": "0.00027"}, {"outputCost": "0.00167"}]` |

For the following **14 models, no `cost` field is present on any version** (the
version object carries `name`, `isLatest`, `deprecated`, `retirementDate`,
`contextLength`, `inputTypes`, `capabilities`, `streamingSupported` — but no
`cost`):

| Model | `executableId` |
|---|---|
| `gpt-realtime` | azure-openai |
| `gpt-5.3-codex` | azure-openai |
| `gpt-5.4` | azure-openai |
| `gpt-5.4-nano` | azure-openai |
| `gpt-5.5` | azure-openai |
| `gpt-5.6-sol` | azure-openai |
| `gpt-5.6-luna` | azure-openai |
| `gpt-5.6-terra` | azure-openai |
| `gemini-2.5-flash-image` | gcp-vertexai |
| `cohere-reranker` | aicore-cohere |
| `sap-rpt-1-large` | aicore-sap |
| `sap-rpt-1-small` | aicore-sap |
| `sap-rpt-1.5` | aicore-sap |
| `sap-rpt-1.5-large` | aicore-sap |

The affected set is dominated by the **newest Azure-OpenAI GPT-5.x models**
(`gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol/luna/terra`, `gpt-5.3-codex`, `gpt-realtime`),
which suggests the `cost` metadata was not populated when these models were added
to the catalog. `gpt-4o` and Claude/Gemini 2.5 models — added earlier — do carry
`cost`.

## Impact

- Cost estimation and per-request cost tracking cannot be computed for these
  models from the catalog API; consumers must hard-code or omit their pricing.
- The gap is most acute for the **flagship current models** (`gpt-5.6-*`), which
  are exactly the ones customers are moving to.
- It is inconsistent with the same API's own behaviour for 48 other models and,
  we believe, with the pricing published in SAP Note 3437766.

## Questions / requests for SAP

1. Please **populate `versions[].cost`** for the 14 models listed above in
   `/v2/lm/scenarios/foundation-models/models`, consistent with the other 48.
2. Is the omission **intentional** for any of these (e.g. reranker/embedding-style
   or SAP-RPT models with a different metering model), or is it a metadata gap?
3. What is the **relationship between the API's `cost` field and SAP Note
   3437766** (GenAI-token conversion rates)? Is `cost` derived from the note, and
   is it kept in sync when new models are onboarded?
4. Is there a **supported alternative** endpoint or field to retrieve authoritative
   per-model pricing for models the catalog omits?

## Desired outcome

`cost` present and correct for every billable model in the foundation-models
catalog (or a documented reason and an alternative source where it is
intentionally absent), so per-model cost can be computed reliably for current
models including `gpt-5.6-sol`.

---

*Prepared from a live query of `/v2/lm/scenarios/foundation-models/models` on the
tenant above, 2026-08-30 (62 models; 48 with `cost`, 14 without).*
