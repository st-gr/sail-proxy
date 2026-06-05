/**
 * Tier 0: Custom Regex Entity Detection (Highest Priority)
 *
 * User-defined regex patterns for domain-specific PII (permits, badges, etc.)
 */

import { EntityMatch, CustomEntity } from '../types';

/**
 * Run custom regex detectors on the given text
 */
export function detectCustomEntities(text: string, customEntities?: CustomEntity[]): EntityMatch[] {
  if (!customEntities || customEntities.length === 0) return [];

  const matches: EntityMatch[] = [];

  for (const entity of customEntities) {
    try {
      const flags = entity.flags || 'gi';
      const regex = new RegExp(entity.pattern, flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        matches.push({
          original: match[0],
          type: 'custom',
          start: match.index,
          end: match.index + match[0].length,
          priority: 0, // Tier 0: highest priority
          placeholder: entity.placeholder, // Custom placeholder prefix
        });

        // Prevent infinite loops for zero-length matches
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
    } catch (error: any) {
      console.error(`[pseudonymization] Invalid custom regex "${entity.pattern}": ${error.message}`);
    }
  }

  return matches;
}
