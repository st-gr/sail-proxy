# 04 — Small cleanups

**Status:** open · **Type:** cosmetic / documentation · **Impact:** none on behavior

Six items, each judged real but non-blocking during the phase reviews. All are independent; take any subset. None changes behavior, so a single commit with a shared test run is fine.

## 04a — `collectHookArrays` does not recurse into array elements

`services/gateway/test/responses-hooks-config.test.ts`

The walker that finds every hook array returns as soon as it encounters an `Array`, so a hook array nested inside another array would be invisible to it. A brute-force fully-recursive sweep confirms this misses nothing in today's config (it finds the same 20 arrays), and the walker's own self-guard (`>= 20` arrays, both Responses subpaths by path, `>= 18` under `model_list_changes`) would catch a wholesale regression. But the test's stated selling point is that entries are "identified structurally rather than by location", and this is a gap in exactly that claim.

Fix: recurse into array elements as well as object values.

## 04b — `TERMINAL_RESPONSE_TYPES` is defined twice

`services/gateway/src/controllers/responsesController.ts:~55` and `services/gateway/src/plugins/responsesWebSearchPlugin.ts:~174`, with identical contents. Export one and import it, or move it to a shared util. Note the plugin deliberately avoids importing from the controller — if that direction is unwanted, put it in `utils/`.

## 04c — `headerValueMatches` is named and documented purely in `Content-Type` terms

`services/gateway/src/services/pluginLoader.ts`

It also governs `header:x-app=cli` (3 hook entries), which now matches case-insensitively where it did not before. That is a widening, so it is safe — verified during the phase-3 review — but the helper's name and docstring describe only media types, and a future header rule with meaningful case-sensitivity or a literal `;` in its value would silently get MIME semantics.

Fix: broaden the docstring to state the rule (parameters stripped and case folded only when the expected value carries no `;`), or rename to something not MIME-specific.

## 04d — The cap's shipped-config test cannot distinguish "read the config" from "fell back"

`services/gateway/test/websearch-cap-config.test.ts`

Mutation-proven: renaming the config key to `websearch` leaves the test green, because the shipped value (3) equals `DEFAULT_MAX_WEB_SEARCHES` (3). The consequence is bounded — it fails to the safe default and can never disable the bound — but a typo'd config path would go unnoticed.

Fix: assert a non-default value flows through, using a temporary or injected config rather than changing the shipped default.

## 04e — Field-set attribution in the re-masking docs

`services/gateway/src/plugins/webSearch/queryMasking.ts` and `responsesWebSearchPlugin.md`

Both say the six scoped fields are "the same text-bearing fields `unmaskResponsesOutput` itself unmasks". That function covers only four of them; bare-string `content` and `output` come from `extractResponsesInputTexts`. The **field list is correct** — it is the union of both functions' maskable fields, and `queryMasking.ts`'s own source comment attributes it correctly. Only the compressed restatement is imprecise.

Fix: name both functions in the two places that currently name one.

## 04f — `normalizeInputToItems` returns array inputs by reference, undocumented

`services/gateway/src/plugins/webSearch/continuation.ts`

Safe for the current call sites, which spread the result rather than mutating it. But a future direct caller that pushes onto the returned array would corrupt the caller's `req.body.input`.

Fix: one comment stating the contract, or a `toBe` assertion in the existing test pinning it deliberately.

## Verification

`npx tsc --noEmit -p tsconfig.json` clean and the full suite green from `services/gateway`. For 04a and 04d, confirm the strengthened tests fail against the defect they now cover before restoring.
