/**
 * The admin's Valkey client for quota state: one JSON document per user (quota:user:<hash>, read
 * by the gateway's quotaEnforcement) and read access to the gateway's per-minute counters
 * (rl:user:<hash>:<minute>) for the "requests this minute" figure. Optional: without VALKEY_URL
 * every write reports false and reads answer empty — the gateway then fails open (spec §2).
 */
import { createHash } from 'crypto';
import { getDefaultLogger } from '@libs/logger';

let Valkey: any;
try { Valkey = require('iovalkey'); } catch { Valkey = null; }
const logger = getDefaultLogger();

const SCAN_COUNT = 1000;
const SCAN_MAX_CALLS = 200;
const SCAN_MAX_KEYS = 1000;
export const QUOTA_DOCUMENT_TTL_SECONDS = 86_400;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const quotaKeyFor = (email: string) => `quota:user:${sha(email)}`;
export const userMinuteKey = (email: string, minuteEpoch: number) => `rl:user:${sha(email)}:${minuteEpoch}`;
export const teamQuotaKeyFor = (teamId: string) => `quota:team:${teamId}`;
export const teamMinuteKey = (teamId: string, minuteEpoch: number) => `rl:team:${teamId}:${minuteEpoch}`;

class QuotaStateStore {
  private client: any = null;
  async initialize(): Promise<void> {
    const url = process.env.VALKEY_URL;
    if (!url || !Valkey) { logger.info('QuotaStateStore', 'VALKEY_URL not set - quota documents are not published'); return; }
    this.client = new Valkey(url, { enableOfflineQueue: false, commandTimeout: 1000, maxRetriesPerRequest: 1 });
    this.client.on('error', (err: Error) => logger.warn('QuotaStateStore', `Valkey error: ${err.message}`));
    this.client.on('connect', () => logger.info('QuotaStateStore', 'Connected to Valkey'));
  }
  available(): boolean { return !!this.client && this.client.status === 'ready'; }
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if (!this.available()) return false;
    try { await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds); return true; }
    catch (error) { logger.warn('QuotaStateStore', `SET ${key} failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  async getJson(key: string): Promise<any | null> {
    if (!this.available()) return null;
    try { const raw = await this.client.get(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  async getNumber(key: string): Promise<number> {
    if (!this.available()) return 0;
    try { const raw = await this.client.get(key); return raw ? Number(raw) || 0 : 0; } catch { return 0; }
  }
  async del(key: string): Promise<boolean> {
    if (!this.available()) return false;
    try { await this.client.del(key); return true; }
    catch (error) { logger.warn('QuotaStateStore', `DEL ${key} failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  /** Valkey pub/sub on the same client (the Connections change marker). false when unavailable; never throws. */
  async publish(channel: string, message: string): Promise<boolean> {
    if (!this.available()) return false;
    try { await this.client.publish(channel, message); return true; }
    catch (error) { logger.warn('QuotaStateStore', `PUBLISH ${channel} failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  /**
   * Every key matching `pattern` with its parsed JSON value (a key that vanishes or holds
   * no JSON is skipped). null when Valkey is unavailable or the scan fails, so a caller can
   * tell "nothing there" from "cannot look". Used for the gateways' plugin status keys.
   */
  async scanJson(pattern: string): Promise<Array<{ key: string; value: any }> | null> {
    if (!this.available()) return null;
    try {
      const keys = new Set<string>();
      let cursor = '0';
      let calls = 0;
      // Bounded by calls as well as by matches: a keyspace with few matches must not be walked without end.
      do {
        const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
        cursor = String(next);
        calls += 1;
        batch.forEach((k: string) => keys.add(k));
      } while (cursor !== '0' && keys.size < SCAN_MAX_KEYS && calls < SCAN_MAX_CALLS);
      const found: Array<{ key: string; value: any }> = [];
      for (const key of keys) {
        try {
          const raw = await this.client.get(key);
          if (raw) found.push({ key, value: JSON.parse(raw) });
        } catch { /* expired between scan and get, or not JSON */ }
      }
      return found;
    } catch (error) {
      logger.warn('QuotaStateStore', `SCAN ${pattern} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  async shutdown(): Promise<void> {
    if (this.client) { try { await this.client.quit(); } catch { /* closing */ } this.client = null; }
  }
}
export const quotaStateStore = new QuotaStateStore();
