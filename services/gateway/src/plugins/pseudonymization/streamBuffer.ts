/**
 * Stream Unmask Buffer
 *
 * Handles unmasking of placeholder tokens in streaming responses where
 * placeholders may be split across SSE chunks.
 *
 * Algorithm:
 * - Accumulates text in a buffer
 * - Scans for complete placeholder tokens and unmasks them
 * - Determines a "safe flush point" — the longest suffix that could be a partial placeholder
 * - Flushes everything before that point, retains the rest for next chunk
 */

import { ReplacementMap } from './replacementMap';

export class StreamUnmaskBuffer {
  private buffer = '';
  private reverseMap: Map<string, string>;
  private knownPrefixes: string[];
  private placeholderRegex: RegExp;
  private maxPrefixLength: number;

  constructor(map: ReplacementMap) {
    this.reverseMap = map.reverse;

    // Collect all unique prefixes from the reverse map
    const prefixes = new Set<string>();
    for (const placeholder of map.reverse.keys()) {
      // "MASKED_PERSON_1" → prefix "MASKED_PERSON_"
      const lastUnderscore = placeholder.lastIndexOf('_');
      if (lastUnderscore > 0) {
        prefixes.add(placeholder.slice(0, lastUnderscore + 1));
      }
    }
    this.knownPrefixes = Array.from(prefixes);

    // Also add partial prefixes like "M", "MA", "MAS", "MASK", etc.
    // to detect very early splits
    this.maxPrefixLength = 0;
    for (const p of this.knownPrefixes) {
      if (p.length > this.maxPrefixLength) {
        this.maxPrefixLength = p.length;
      }
    }
    // Add room for the id after the prefix: hash-stable ids are 8 digits
    // (up to a few more under collision probing); legacy numeric ids are shorter.
    this.maxPrefixLength += 16;

    // Retention must also cover the longest exact key (URL-shaped placeholders like
    // "https://masked-url-12345678.invalid" carry no MASKED_ prefix family).
    for (const placeholder of map.reverse.keys()) {
      if (placeholder.length > this.maxPrefixLength) {
        this.maxPrefixLength = placeholder.length;
      }
    }

    // Build regex for complete placeholders
    const placeholders = Array.from(map.reverse.keys())
      .sort((a, b) => b.length - a.length);

    if (placeholders.length > 0) {
      const escaped = placeholders.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.placeholderRegex = new RegExp(escaped.join('|'), 'g');
    } else {
      this.placeholderRegex = /(?!)/g; // Never matches
    }
  }

  /**
   * Append new text from a chunk. Returns text safe to emit to client.
   */
  append(text: string): string {
    this.buffer += text;

    // Find the safe flush point on the RAW buffer first, then unmask only the
    // flushed slice. Replacing before choosing the flush point corrupted longer
    // placeholders split at a digit boundary: with both MASKED_PERSON_11 and
    // MASKED_PERSON_113 in the map, a chunk ending in '…MASKED_PERSON_11'
    // followed by '3…' must NOT be eagerly replaced as _11 plus a stray '3'.
    // couldBePartialPlaceholder retains a complete placeholder that is a strict
    // prefix of a longer one, so the ambiguous tail stays buffered until the
    // next chunk (or flush) disambiguates it.
    const safePoint = this.findSafeFlushPoint();
    let flushed = this.buffer.slice(0, safePoint);
    this.buffer = this.buffer.slice(safePoint);

    this.placeholderRegex.lastIndex = 0;
    flushed = flushed.replace(this.placeholderRegex, (match) =>
      this.reverseMap.get(match) || match
    );

    return flushed;
  }

  /**
   * Flush everything remaining (called at end of stream)
   */
  flush(): string {
    // Final unmask attempt on whatever is left
    this.placeholderRegex.lastIndex = 0;
    const result = this.buffer.replace(this.placeholderRegex, (match) =>
      this.reverseMap.get(match) || match
    );
    this.buffer = '';
    return result;
  }

  /**
   * Find the point up to which we can safely emit text.
   * Any suffix that could be the beginning of a known placeholder must be retained.
   */
  private findSafeFlushPoint(): number {
    // No placeholders at all → nothing can ever match, flush everything.
    // (knownPrefixes alone is not sufficient: URL-shaped placeholders like
    // "https://masked-url-<id>.invalid" have no MASKED_*_ prefix family but
    // still require suffix retention via the exact-key check below.)
    if (this.knownPrefixes.length === 0 && this.reverseMap.size === 0) return this.buffer.length;

    const maxCheck = Math.min(this.buffer.length, this.maxPrefixLength);

    for (let len = maxCheck; len >= 1; len--) {
      const suffix = this.buffer.slice(-len);
      // Check if this suffix is a prefix of any known placeholder
      if (this.couldBePartialPlaceholder(suffix)) {
        return this.buffer.length - len;
      }
    }

    return this.buffer.length;
  }

  /**
   * Check if the given string could be the start of any placeholder we know about
   */
  private couldBePartialPlaceholder(suffix: string): boolean {
    // Check against all actual placeholders in reverse map
    for (const placeholder of this.reverseMap.keys()) {
      if (placeholder.startsWith(suffix) && placeholder !== suffix) {
        return true;
      }
    }
    // Check against known prefixes (e.g., "MASKED_PERSON_" could start "MASKED_PERSON_2")
    for (const prefix of this.knownPrefixes) {
      if (prefix.startsWith(suffix)) {
        return true;
      }
    }
    return false;
  }
}
