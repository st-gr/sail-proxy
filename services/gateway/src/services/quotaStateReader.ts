/**
 * The per-user state document the admin publishes (userQuotaService.publish): effective limits
 * and the usage sums per calendar window. Read from Valkey with a short local cache, so admission
 * costs one GET per user per ten seconds per pod. Overshoot is bounded by one usage batch of
 * traffic (spec §2). `undefined` = the store could not be read (fail open), `null` = no document.
 */
import { createHash } from 'crypto';

export type WindowName = 'day' | 'week' | 'month';
export interface WindowUsage { requests: number; tokens: number; sapCost: number; }
/** What checkAdmission reads: a user document and a team document share it. */
export interface AdmissionDocument { limits: Record<string, number | null>; used: Record<WindowName, WindowUsage>; windowStart: Record<WindowName, string>; }
export interface QuotaStateDocument extends AdmissionDocument { email: string; status: 'active' | 'deactivated'; quotaResetAt: string | null; updatedAt: string; primaryTeamId?: string | null; }
export interface TeamQuotaStateDocument extends AdmissionDocument { teamId: string; teamName: string; quotaResetAt: string | null; updatedAt: string; }

export const quotaKeyFor = (email: string) => `quota:user:${createHash('sha256').update(email).digest('hex')}`;
export const teamQuotaKeyFor = (teamId: string) => `quota:team:${teamId}`;

export class QuotaStateReader {
  private readonly cache = new Map<string, { at: number; doc: any }>();
  constructor(private readonly client: any, private readonly clock: () => number = Date.now, private readonly ttlMs = 10_000) {}

  async get(email: string): Promise<QuotaStateDocument | null | undefined> { return this.read(quotaKeyFor(email)); }
  async getTeam(teamId: string): Promise<TeamQuotaStateDocument | null | undefined> { return this.read(teamQuotaKeyFor(teamId)); }

  private async read(key: string): Promise<any> {
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.doc;
    if (!this.client || this.client.status !== 'ready') return undefined;
    let raw: string | null;
    try { raw = await this.client.get(key); } catch { return undefined; }
    let doc: any = null;
    if (raw) {
      try { const parsed = JSON.parse(raw); doc = parsed && typeof parsed === 'object' && parsed.used ? parsed : null; } catch { doc = null; }
    }
    this.cache.set(key, { at: this.clock(), doc });
    if (this.cache.size > 10_000) this.cache.clear();
    return doc;
  }
}
