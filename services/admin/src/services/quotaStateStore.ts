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

export const QUOTA_DOCUMENT_TTL_SECONDS = 86_400;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const quotaKeyFor = (email: string) => `quota:user:${sha(email)}`;
export const userMinuteKey = (email: string, minuteEpoch: number) => `rl:user:${sha(email)}:${minuteEpoch}`;

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
  async shutdown(): Promise<void> {
    if (this.client) { try { await this.client.quit(); } catch { /* closing */ } this.client = null; }
  }
}
export const quotaStateStore = new QuotaStateStore();
