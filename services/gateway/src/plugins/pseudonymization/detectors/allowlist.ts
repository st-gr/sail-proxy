/**
 * The operator allow-list: values this deployment has decided are never PII.
 *
 * Distinct from `MaskingConfig.allow_list` (the older key, a flat list of case-INSENSITIVE
 * literals applied before the technical veto). This one is
 * `pseudonymization.allowlist: { patterns, terms }`, layered global → endpoint → model by
 * CONCATENATION, and it is applied AFTER the veto and BEFORE scoring — so it is the last
 * word on a span the pipeline was otherwise going to mask, and no confidence adjustment can
 * bring an allowed span back.
 *
 * Two forms, because operators have two different problems:
 *
 *   - `terms` — case-SENSITIVE literals. A product name, a system name, a team name that the
 *     capitalised-run heuristic reads as a person. Case-sensitive on purpose: "Watson Studio"
 *     is a product and "watson studio" in prose is not the thing the operator exempted, and a
 *     case-insensitive list would quietly exempt a surname that happens to share the spelling.
 *   - `patterns` — regular-expression SOURCES, each anchored to the whole span (`^(?:…)$`)
 *     before it is compiled. An operator writes `Z[A-Z0-9_]+` and gets exactly the spans that
 *     ARE such an identifier, never the ones that merely contain one. Anchoring is applied
 *     here rather than asked of the operator: an unanchored `[A-Z]` from a config form would
 *     otherwise exempt every span with a capital letter in it.
 *
 * An invalid pattern is skipped with ONE warning naming it, and the rest of the list still
 * applies. The alternative — rejecting the whole allow-list — turns one typo into a silent
 * return to masking everything the operator had exempted.
 */

import { getDefaultLogger } from '@libs/logger';
import { AllowlistConfig } from '../types';

export interface CompiledAllowlist {
  terms: ReadonlySet<string>;
  patterns: ReadonlyArray<RegExp>;
}

/**
 * Pattern sources already warned about — one WARN per bad pattern per process, mirroring
 * `warnedUnknownToggles` in entityToggles.ts. Bounded, because an allow-list can also arrive
 * on a request body (`masking.allowlist`): without the cap a caller could grow this set one
 * unique broken pattern at a time.
 */
const warnedInvalid = new Set<string>();
const WARNED_INVALID_CAP = 200;

/**
 * Pattern sources already reported as over-broad — a separate set from `warnedInvalid`, so a
 * pattern cannot be silenced on one count by having been reported on the other.
 */
const warnedBroad = new Set<string>();

/**
 * The frozen sample every compiled pattern is measured against.
 *
 * The allow-list is a masking OFF switch, per value, and its failure mode is quiet: `[A-Z].*`
 * compiles, matches almost every person the run heuristic finds, and disables name masking for
 * the deployment without erroring anywhere. Nothing here rejects such a pattern — an operator
 * may have a reason, and refusing to apply a valid entry would be a second, worse surprise —
 * but it must not go unremarked.
 *
 * Four shapes, one per detector family that carries real personal data: a person, a mail
 * address, a phone number and a checksum-validated identifier. All four are synthetic and
 * `.invalid`; this repository is public.
 */
const ALLOWLIST_CANARIES: readonly string[] = Object.freeze([
  'Maria Schneider',
  'john@example.invalid',
  '+49 170 1234567',
  'DE89 3704 0044 0532 0130 00',
]);

/**
 * Compilation is memoised on the CONFIG OBJECT, not on its contents: the plugin builds one
 * resolved allow-list per request and hands the same object to every text in it, so a
 * request compiles its patterns once however many messages it carries. A WeakMap because the
 * key is per-request and must not be kept alive by this cache.
 */
const compiled = new WeakMap<AllowlistConfig, CompiledAllowlist>();

/** Non-empty strings only; an empty entry would anchor to `^(?:)$` and exempt the empty span. */
function usableEntries(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Warn — once per pattern source per process — when a compiled pattern also matches ordinary
 * personal data. The pattern still applies: this reports, it never rejects.
 */
function warnIfOverBroad(source: string, compiled: RegExp): void {
  if (warnedBroad.has(source)) return;
  if (!ALLOWLIST_CANARIES.some(canary => compiled.test(canary))) return;

  if (warnedBroad.size >= WARNED_INVALID_CAP) warnedBroad.clear();
  warnedBroad.add(source);
  getDefaultLogger().warn('Pseudonymization',
    `Allow-list pattern ${JSON.stringify(source)} also matches ordinary personal data — it may `
    + 'disable masking far beyond what was intended. The pattern is still applied; narrow it if '
    + 'that was not the intent (it is anchored to the whole detected value, so it needs to '
    + 'describe one completely).');
}

/**
 * Compile an allow-list, or return undefined when there is nothing in it. Undefined is the
 * signal the caller uses to skip the filter entirely, so a deployment that configures no
 * allow-list pays nothing per span.
 */
export function compileAllowlist(config: AllowlistConfig | undefined): CompiledAllowlist | undefined {
  if (!config) return undefined;

  const cached = compiled.get(config);
  if (cached) return cached;

  const terms = new Set(usableEntries(config.terms));
  const patterns: RegExp[] = [];

  for (const source of usableEntries(config.patterns)) {
    try {
      const compiled = new RegExp(`^(?:${source})$`);
      warnIfOverBroad(source, compiled);
      patterns.push(compiled);
    } catch (error: any) {
      if (!warnedInvalid.has(source)) {
        if (warnedInvalid.size >= WARNED_INVALID_CAP) warnedInvalid.clear();
        warnedInvalid.add(source);
        getDefaultLogger().warn('Pseudonymization',
          `Ignoring invalid pseudonymization.allowlist pattern ${JSON.stringify(source)}: `
          + `${error?.message || 'not a valid regular expression'}. The rest of the allow-list still applies.`);
      }
    }
  }

  if (terms.size === 0 && patterns.length === 0) return undefined;

  const result: CompiledAllowlist = { terms, patterns };
  compiled.set(config, result);
  return result;
}

/** Whether this exact span text is exempted by a term or by a pattern. */
export function isAllowlisted(value: string, allowlist: CompiledAllowlist): boolean {
  if (allowlist.terms.has(value)) return true;
  for (const pattern of allowlist.patterns) {
    if (pattern.test(value)) return true;
  }
  return false;
}
