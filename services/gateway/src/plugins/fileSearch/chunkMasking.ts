/**
 * Mask a retrieved document chunk on its way to the deployment, extending the LIVE
 * request map so the client-facing unmask can reverse whatever we introduce.
 *
 * WHY THIS EXISTS AT ALL. Every other string the hosted-tool engine sends upstream was
 * masked on the request side by pseudonymizationPlugin before it ever reached a
 * descriptor, so `ToolExecCtx.remask` — which only replays THIS request's existing
 * pairs — is enough for it. A file_search chunk is different: it comes out of the
 * gateway's own corpus, was never part of the request body, and therefore carries
 * entities the request map has never seen. Replaying the existing pairs over it would
 * mask nothing. So detection has to run again, here.
 *
 * WHY IT MUST WRITE THROUGH THE REQUEST MAP rather than mask into a throwaway map: the
 * model will quote these passages back, and the client is owed the real text. The
 * placeholders we mint are only reversible if they are registered in the map the
 * response-side unmasker reads.
 *
 * `map.reverse` is a strict SUPERSET of the inverse of `map.forward` — `ReplacementMap`
 * registers a scheme-less alias for URL placeholders in `reverse` only, so a model that
 * drops the `https://` still unmasks (see its "Scheme-less alias" branch, and
 * webSearch/queryMasking.ts's note on the same asymmetry). That is exactly why this goes
 * through `replaceEntities` → `map.getPlaceholder` — the one registration path — instead
 * of assigning to `forward` and `reverse` directly. Direct assignment type-checks, runs,
 * and silently flattens the asymmetry: URLs would still mask, and would stop unmasking.
 *
 * WHICH ENTITY CATEGORIES — AND WHY THE REQUEST'S OWN CONFIG, NOT THE BASE SET. The
 * request's resolved `MaskingConfig` (the very object pseudonymizationPlugin masked the
 * request body with, stashed on `req.__pseudonymization.config`) now reaches this function:
 * the engine reads it there and hands it to every descriptor on `ToolExecCtx.maskingConfig`,
 * and `fileSearch/descriptor.ts` passes it straight through. `DEFAULT_MASKING_CONFIG` is
 * kept only as the fallback for a request that has no resolved config at all.
 *
 * That routing was added because using the base set here was a PROVEN LEAK, not a
 * theoretical divergence. Of the three ways a request's config differs from the base set,
 * two are fail-safe and one is not:
 *
 *   - a category an operator DISABLED via api_config toggles was still masked here
 *     -> chunk side masked MORE. Fail-safe.
 *   - a value the request's `allow_list` exempts was still masked here
 *     -> chunk side masked MORE. Fail-safe.
 *   - `custom_entities`, the caller-supplied regex tier `detectCustomEntities` runs at
 *     priority 0, is ABSENT from the base set and so was never applied here
 *     -> chunk side masked LESS. THAT WAS THE LEAK.
 *
 * Concretely, reproduced before the fix: a caller who declared "mask anything matching
 * `EMP-\d{6}`" got `badge MASKED_BADGE_17078648` in their prompt and `badge EMP-004417`
 * verbatim in every retrieved passage sent to the deployment — exactly the class of
 * identifier they flagged as sensitive. `test/responses-filesearch-execute.test.ts`'s
 * "chunk masking honours the REQUEST's config" block pins the fixed behaviour end to end,
 * including the deployment-bound `renderOutput`; do not revert the `config` parameter to a
 * constant without re-reading it.
 *
 * The `method` the effective config carries is inert either way — no entry in the default
 * set carries `replacement_strategy: 'fabricated_data'`, so `replaceEntities` normally
 * takes the `map.getPlaceholder` branch, and the placeholder STYLE (content-hash vs
 * per-request counter) and reverse-map registration are decided by the MAP's own method,
 * fixed when pseudonymizationPlugin constructed it, not by this config.
 *
 * @see ../pseudonymization/replacementMap.ts - getPlaceholder, the one registration path
 * @see ../pseudonymization/defaultMaskingConfig.ts - the shared category list
 * @see descriptor.ts - the only caller
 */
import { detectEntities } from '../pseudonymization/detectors';
import { replaceEntities } from '../pseudonymization/replacer';
import { DEFAULT_MASKING_CONFIG } from '../pseudonymization/defaultMaskingConfig';
import { ReplacementMap } from '../pseudonymization/replacementMap';
import { MaskingConfig } from '../pseudonymization/types';

/**
 * The categories to detect in a chunk: the REQUEST's own resolved config whenever there is
 * one, so a caller's `custom_entities` apply to retrieved passages exactly as they applied
 * to the prompt.
 *
 * The base set is the fallback for a config that is genuinely absent, and only for that —
 * `entities` is checked because a config with no category list would detect nothing at all,
 * which on this path means "ship the document to the model raw". Falling back to the base
 * set there masks strictly more than nothing.
 *
 * THE EMPTY-`entities` ARM IS UNREACHABLE TODAY, and deliberately left in as a backstop
 * rather than covered by a test that fakes its way into it. What makes it unreachable is
 * one early return in `pseudonymization/index.ts`: a config with no `entities` never
 * activates, so `__pseudonymization` is never stashed, so nothing ever reaches
 * `ToolExecCtx.maskingConfig` and this function is handed `undefined` (the absent-config
 * arm) instead. Relaxing that early return would re-open the `custom_entities` leak
 * described at the top of this file, so it is the GATE that is pinned by test, not this
 * fallback: `test/pseudonymization-activation-gate.test.ts`.
 */
function effectiveConfig(config: MaskingConfig | undefined): MaskingConfig {
  return config && Array.isArray(config.entities) && config.entities.length > 0
    ? config
    : DEFAULT_MASKING_CONFIG;
}

/**
 * Mask `text` with this request's placeholders, minting and registering new ones for
 * entities the request map has not seen.
 *
 * No map (masking off for this request, or an endpoint with no masking hook) returns the
 * text untouched: absent config must mean unchanged behaviour, and there would be nothing
 * to unmask against on the way back out.
 *
 * `config` is the request's resolved `MaskingConfig`, routed here from
 * `ToolExecCtx.maskingConfig`. Passing it is not optional in spirit even though it is
 * optional in the signature: omitting it silently drops the caller's `custom_entities`
 * tier, which is the leak documented at the top of this file.
 *
 * Idempotent per value within a request — `getPlaceholder` returns the existing
 * placeholder for a value already in `forward`, so a name that appeared in the user's
 * prompt keeps the very same token when it turns up again in a retrieved passage. That
 * is what lets the model connect the two.
 */
export function maskThroughRequestMap(
  text: string, map: ReplacementMap | undefined, config?: MaskingConfig,
): string {
  if (!map || typeof text !== 'string' || text.length === 0) return text;

  const active = effectiveConfig(config);
  const matches = detectEntities(text, active);
  if (matches.length === 0) return text;

  return replaceEntities(text, matches, map, active);
}
