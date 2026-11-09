/**
 * Tier 0: Custom Regex Entity Detection (Highest Priority)
 *
 * User-defined regex patterns for domain-specific PII (permits, badges, etc.)
 */

import { EntityMatch, CustomEntity } from '../types';
import { DETECTOR_CONFIDENCE } from './confidenceScores';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/** Caller-supplied flags outside this set are rejected (same as an invalid pattern). */
const ALLOWED_FLAGS_PATTERN = /^[gimsuy]*$/;

/**
 * Run custom regex detectors on the given text
 */
export function detectCustomEntities(text: string, customEntities?: CustomEntity[]): EntityMatch[] {
  if (!customEntities || customEntities.length === 0) return [];

  const matches: EntityMatch[] = [];

  for (const entity of customEntities) {
    try {
      const rawFlags = entity.flags || 'i';
      if (!ALLOWED_FLAGS_PATTERN.test(rawFlags)) {
        throw new Error(`unsupported flag(s) in "${rawFlags}"`);
      }
      // Always iterate globally so `lastIndex` advances regardless of what the caller
      // passed: `exec` only honours `lastIndex` under `g`/`y`, and without one of those
      // the loop below never terminates (C3). Sticky (`y`) is dropped rather than kept
      // alongside `g`: it silently misses non-anchored matches, which is a correctness
      // gap this fix removes for free. `i`/`m`/`s`/`u` are kept as given, de-duplicated.
      const flags = `${[...new Set(rawFlags.replace(/[^imsu]/g, ''))].join('')}g`;
      const regex = new RegExp(entity.pattern, flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // A zero-length match (e.g. `a*` sitting on a non-'a' position) masks nothing, so
        // it is never recorded - only advanced past. Under the `u` flag, `text` is indexed
        // by UTF-16 code unit, so a zero-length match sitting on the low surrogate of an
        // astral code point must advance past both units, not just one. This also prevents
        // the infinite loop a zero-length match would otherwise cause.
        if (match[0].length === 0) {
          const cp = flags.includes('u') ? text.codePointAt(regex.lastIndex) : undefined;
          regex.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
          continue;
        }

        // No cap here: every match is non-zero-length, so the loop is bounded by the text
        // length (itself bounded by the request body limit) - capping would fail the rest
        // of the text open (unmasked) instead of masking it.
        matches.push({
          original: match[0],
          type: 'custom',
          start: match.index,
          end: match.index + match[0].length,
          priority: 0, // Tier 0: highest priority
          // Operator intent is the strongest evidence there is: 1.0, so no adjustment can
          // push a configured rule below any threshold in [0,1] except a code-fence one.
          confidence: DETECTOR_CONFIDENCE.custom,
          placeholder: entity.placeholder, // Custom placeholder prefix
        });
      }
    } catch (error: any) {
      // Neither the pattern nor the error message is logged: both are caller input.
      logger.warn('pseudonymization', 'A custom_entities pattern from the request is invalid and was skipped');
    }
  }

  return matches;
}
