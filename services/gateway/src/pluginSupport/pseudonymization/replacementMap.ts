/**
 * ReplacementMap - bidirectional map for pseudonymization
 *
 * Maintains forward (original → placeholder) and reverse (placeholder → original)
 * mappings for the lifetime of a single request. Ensures idempotency: the same
 * original text always gets the same placeholder within a request.
 *
 * Pseudonymization placeholders are CONTENT-DERIVED (truncated SHA-256 of the
 * original value), so the same value produces the same token in every request:
 *   - tokens echoed by the model out of older conversation turns ("residue")
 *     resolve correctly as long as the underlying value is present in the
 *     current request (it re-mints the identical token);
 *   - the response cache can safely replay a masked response cached from an
 *     equivalent request — its tokens are reproducible from content alone;
 *   - masked request bodies are byte-stable across requests, which also keeps
 *     upstream prompt caching effective.
 * Anonymization placeholders remain per-request counters: without a reverse
 * map they are never unmasked, and a content-derived token would make the same
 * entity linkable across requests, defeating anonymization.
 */

import crypto from 'crypto';
import { DEFAULT_PREFIXES, EntityMatch, MaskingConfig } from './types';

/** Digits of the content-derived placeholder id. Decimal (not hex) on purpose:
 *  models copy short digit runs far more reliably than hex strings — a garbled
 *  id is unrecoverable, so copy fidelity is part of the security design. */
const HASH_ID_DIGITS = 8;

/**
 * Derive a decimal id from a SHA-256 digest. `level` widens the id (8, 10, 12 …
 * digits) using more of the digest — used for deterministic collision probing:
 * the same value always yields the same ladder of candidate ids.
 */
function idFromDigest(digest: string, level: number): string {
  const digits = HASH_ID_DIGITS + 2 * level;
  const window = digest.slice(0, Math.min(12 + 4 * level, digest.length));
  const num = BigInt(`0x${window}`) % (10n ** BigInt(digits));
  return num.toString().padStart(digits, '0');
}

export class ReplacementMap {
  readonly forward: Map<string, string> = new Map();
  readonly reverse: Map<string, string> = new Map();
  private counters: Map<string, number> = new Map();
  private minCountersByPrefix: Map<string, number> = new Map();
  private method: 'pseudonymization' | 'anonymization';

  constructor(method: 'pseudonymization' | 'anonymization' = 'pseudonymization') {
    this.method = method;
  }

  /**
   * Ensure freshly minted placeholders for `prefix` start above `minCount`.
   *
   * Used when the incoming request already contains literal MASKED_*_n tokens
   * ("residue" leaked into the conversation history by an earlier session).
   * Without this, a fresh entity could mint the same number as a residue token,
   * and unmasking the model's echo of that residue would substitute the WRONG
   * person's name.
   */
  reserveMinCount(prefix: string, minCount: number): void {
    const current = this.minCountersByPrefix.get(prefix) || 0;
    if (minCount > current) {
      this.minCountersByPrefix.set(prefix, minCount);
    }
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

    // URL origins get a URL-SHAPED placeholder (e.g. `http://masked-url-12345678.invalid`)
    // instead of a bare token: the model can then legitimately append paths and query
    // parameters, and the composed URL still unmasks (the placeholder origin is replaced
    // by the real origin wherever it appears). `.invalid` is an RFC 2606 reserved TLD,
    // so an unresolved placeholder can never route traffic anywhere.
    const isUrl = prefix === 'MASKED_URL';
    const urlScheme = isUrl ? (originalValue.match(/^(?:https?|wss?|ftps?):\/\//)?.[0] ?? '') : '';
    const render = (id: string): string =>
      isUrl ? `${urlScheme}masked-url-${id}.invalid` : `${prefix}_${id}`;

    let placeholder: string;
    if (this.method === 'pseudonymization') {
      // Content-derived stable id: same value → same placeholder in every request.
      const digest = crypto.createHash('sha256').update(originalValue, 'utf8').digest('hex');
      let level = 0;
      placeholder = render(idFromDigest(digest, level));
      // In-request collision probing: two DIFFERENT values sharing an id widen it
      // deterministically (each value always follows the same ladder of candidates,
      // so the resolution itself is stable across requests).
      while (this.reverse.has(placeholder) && this.reverse.get(placeholder) !== originalValue) {
        level += 1;
        if (12 + 4 * level > digest.length) {
          // Full-digest collision is not realistically reachable; guard anyway.
          placeholder = render(`${idFromDigest(digest, level)}${this.forward.size}`);
          break;
        }
        placeholder = render(idFromDigest(digest, level));
      }
    } else {
      // Anonymization: per-request incrementing id so the LLM can distinguish entities
      // without the token being linkable across requests. Never collide with residue
      // numbers already present in the request input.
      const minForPrefix = this.minCountersByPrefix.get(prefix) || 0;
      const count = Math.max(this.counters.get(entityType) || 0, minForPrefix) + 1;
      this.counters.set(entityType, count);
      placeholder = render(String(count));
    }

    this.forward.set(originalValue, placeholder);

    if (this.method === 'pseudonymization') {
      // Only store reverse mapping for pseudonymization (enables unmasking)
      this.reverse.set(placeholder, originalValue);

      // Scheme-less alias for URL placeholders: if the model reproduces the masked
      // host without (or with a different) scheme, the bare form still unmasks to
      // the bare origin, keeping whatever scheme the model chose.
      if (isUrl && urlScheme) {
        const bareKey = placeholder.slice(urlScheme.length);
        if (!this.reverse.has(bareKey)) {
          this.reverse.set(bareKey, originalValue.slice(urlScheme.length));
        }
      }
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
