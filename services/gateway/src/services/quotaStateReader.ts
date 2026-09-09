/**
 * The per-user state document the admin publishes (userQuotaService.publish): effective limits
 * and the usage sums per calendar window. Read from Valkey with a short local cache, so admission
 * costs one GET per user per ten seconds per pod. Overshoot is bounded by one usage batch of
 * traffic (spec §2). `undefined` = the store could not be read (fail open), `null` = no document.
 */
import { createHash } from 'crypto';

export type WindowName = 'day' | 'week' | 'month';
export interface WindowUsage { requests: number; tokens: number; sapCost: number; }
export interface QuotaStateDocument {
  email: string; status: 'active' | 'deactivated';
  limits: Record<string, number | null>;
  used: Record<WindowName, WindowUsage>;
  windowStart: Record<WindowName, string>;
  quotaResetAt: string | null; updatedAt: string;
}

export const quotaKeyFor = (email: string) => `quota:user:${createHash('sha256').update(email).digest('hex')}`;

export class QuotaStateReader {
  private readonly cache = new Map<string, { at: number; doc: QuotaStateDocument | null }>();
  constructor(private readonly client: any, private readonly clock: () => number = Date.now, private readonly ttlMs = 10_000) {}

  async get(email: string): Promise<QuotaStateDocument | null | undefined> {
    const hit = this.cache.get(email);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.doc;
    if (!this.client || this.client.status !== 'ready') return undefined;
    let raw: string | null;
    try { raw = await this.client.get(quotaKeyFor(email)); } catch { return undefined; }
    let doc: QuotaStateDocument | null = null;
    if (raw) {
      try { const parsed = JSON.parse(raw); doc = parsed && typeof parsed === 'object' && parsed.used ? parsed : null; } catch { doc = null; }
    }
    this.cache.set(email, { at: this.clock(), doc });
    if (this.cache.size > 10_000) this.cache.clear();
    return doc;
  }
}
