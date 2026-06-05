/**
 * ReplacementMap - bidirectional map for pseudonymization
 *
 * Maintains forward (original → placeholder) and reverse (placeholder → original)
 * mappings for the lifetime of a single request. Ensures idempotency: the same
 * original text always gets the same placeholder within a request.
 */

import { DEFAULT_PREFIXES, EntityMatch, MaskingConfig } from './types';

export class ReplacementMap {
  readonly forward: Map<string, string> = new Map();
  readonly reverse: Map<string, string> = new Map();
  private counters: Map<string, number> = new Map();
  private method: 'pseudonymization' | 'anonymization';

  constructor(method: 'pseudonymization' | 'anonymization' = 'pseudonymization') {
    this.method = method;
  }

  /**
   * Get or assign a placeholder for an entity
   */
  getPlaceholder(entityType: string, originalValue: string, customPrefix?: string): string {
    // Idempotent: return existing placeholder if already mapped
    if (this.forward.has(originalValue)) {
      return this.forward.get(originalValue)!;
    }

    const prefix = customPrefix || DEFAULT_PREFIXES[entityType] || 'MASKED_UNKNOWN';

    // Assign incrementing ID so the LLM can distinguish between entities
    const count = (this.counters.get(entityType) || 0) + 1;
    this.counters.set(entityType, count);
    const placeholder = `${prefix}_${count}`;

    this.forward.set(originalValue, placeholder);

    if (this.method === 'pseudonymization') {
      // Only store reverse mapping for pseudonymization (enables unmasking)
      this.reverse.set(placeholder, originalValue);
    }

    return placeholder;
  }

  /**
   * Get all known placeholder prefixes (for stream buffer partial matching)
   */
  getKnownPrefixes(): string[] {
    const prefixes = new Set<string>();
    for (const placeholder of this.reverse.keys()) {
      // Extract prefix without the _N suffix: "MASKED_PERSON_1" → "MASKED_PERSON_"
      const lastUnderscore = placeholder.lastIndexOf('_');
      if (lastUnderscore > 0) {
        prefixes.add(placeholder.slice(0, lastUnderscore + 1));
      }
    }
    return Array.from(prefixes);
  }

  /**
   * Unmask a single placeholder token
   */
  unmask(placeholder: string): string | undefined {
    return this.reverse.get(placeholder);
  }

  /**
   * Get the size of the map
   */
  get size(): number {
    return this.forward.size;
  }
}
