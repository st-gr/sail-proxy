/**
 * Self-Improving Entity Cache
 *
 * Stores confirmed entities in Valkey (or in-memory LRU fallback) so that
 * repeat entities hit a fast dictionary lookup instead of NER inference.
 *
 * Uses the same optional iovalkey dependency pattern as the rest of the gateway.
 */

interface CacheEntry {
  text: string;
  type: string;
  lastSeen: number;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_MEMORY_ENTRIES = 10000;
const VALKEY_PREFIX = 'pii:entity:';

class EntityCache {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private valkeyClient: any = null;
  private valkeyAvailable = false;

  constructor() {
    this.initValkey();
  }

  private initValkey() {
    try {
      const Valkey = require('iovalkey');
      const host = process.env.VALKEY_HOST || process.env.REDIS_HOST;
      const port = process.env.VALKEY_PORT || process.env.REDIS_PORT;

      if (!host) {
        // No Valkey configured, use memory-only mode
        return;
      }

      this.valkeyClient = new Valkey({
        host,
        port: port ? parseInt(port) : 6379,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        retryStrategy: (times: number) => {
          if (times > 3) return null; // Give up after 3 retries
          return Math.min(times * 200, 1000); // 200ms, 400ms, 600ms
        },
      });

      this.valkeyClient.on('error', (err: any) => {
        if (this.valkeyAvailable) {
          // Only log on state change
          console.error(`[pseudonymization] Valkey connection lost: ${err.message}`);
        }
        this.valkeyAvailable = false;
      });

      this.valkeyClient.on('ready', () => {
        this.valkeyAvailable = true;
        console.log(`[pseudonymization] Valkey connected at ${host}:${port || 6379}`);
      });
    } catch {
      // iovalkey not available, memory-only mode
    }
  }

  /**
   * Store confirmed entities after successful detection
   */
  async store(entities: Array<{ text: string; type: string }>): Promise<void> {
    const now = Date.now();

    for (const entity of entities) {
      const key = `${entity.type}:${entity.text.toLowerCase()}`;

      // Always store in memory
      this.memoryCache.set(key, {
        text: entity.text,
        type: entity.type,
        lastSeen: now,
      });

      // Store in Valkey if available
      if (this.valkeyAvailable && this.valkeyClient) {
        try {
          await this.valkeyClient.set(
            `${VALKEY_PREFIX}${key}`,
            JSON.stringify({ text: entity.text, type: entity.type }),
            'PX', CACHE_TTL_MS
          );
        } catch {
          // Silent fail — memory cache is authoritative fallback
        }
      }
    }

    // Evict oldest entries if memory cache is too large
    if (this.memoryCache.size > MAX_MEMORY_ENTRIES) {
      const entries = Array.from(this.memoryCache.entries())
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const toRemove = entries.slice(0, entries.length - MAX_MEMORY_ENTRIES);
      for (const [key] of toRemove) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Look up known entities in text using cached entries as a fast dictionary
   * Returns matches found via cache (these bypass NER)
   */
  lookup(text: string, enabledTypes: Set<string>): Array<{ text: string; type: string; start: number; end: number }> {
    const results: Array<{ text: string; type: string; start: number; end: number }> = [];
    const lowerText = text.toLowerCase();

    for (const [, entry] of this.memoryCache) {
      if (!enabledTypes.has(entry.type)) continue;

      const lowerEntity = entry.text.toLowerCase();
      let searchFrom = 0;

      while (true) {
        const idx = lowerText.indexOf(lowerEntity, searchFrom);
        if (idx === -1) break;

        // Verify word boundary
        const before = idx > 0 ? text[idx - 1] : ' ';
        const after = idx + entry.text.length < text.length ? text[idx + entry.text.length] : ' ';
        const isBoundary = /\W/.test(before) && /\W/.test(after);

        if (isBoundary) {
          results.push({
            text: text.slice(idx, idx + entry.text.length),
            type: entry.type,
            start: idx,
            end: idx + entry.text.length,
          });
        }

        searchFrom = idx + 1;
      }
    }

    return results;
  }

  /**
   * Get cache statistics
   */
  getStats(): { memorySize: number; valkeyAvailable: boolean } {
    return {
      memorySize: this.memoryCache.size,
      valkeyAvailable: this.valkeyAvailable,
    };
  }
}

// Singleton instance
export const entityCache = new EntityCache();
