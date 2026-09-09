/**
 * Counters behind quotaEnforcement. Valkey is the shared store (every pod sees the same buckets);
 * the memory store carries standalone mode and the fail-open path. Both expose the same two
 * operations so the middleware runs one algorithm.
 */
export interface RateLimitStore {
  /** INCR key and (re)arm its expiry; returns the value after the increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Current value, 0 when absent or expired. */
  get(key: string): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly m = new Map<string, { n: number; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async incr(key: string, ttlSeconds: number): Promise<number> {
    this.sweep();
    const e = this.m.get(key);
    if (e && e.exp > this.now()) { e.n += 1; return e.n; }
    this.m.set(key, { n: 1, exp: this.now() + ttlSeconds * 1000 });
    return 1;
  }
  async get(key: string): Promise<number> {
    const e = this.m.get(key);
    return e && e.exp > this.now() ? e.n : 0;
  }
  private sweep(): void {
    if (this.m.size < 10_000) return;
    for (const [k, e] of this.m) if (e.exp <= this.now()) this.m.delete(k);
  }
}

export class ValkeyRateLimitStore implements RateLimitStore {
  constructor(private readonly client: any) {}
  ready(): boolean { return this.client?.status === 'ready'; }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const replies = await this.client.multi().incr(key).expire(key, ttlSeconds).exec();
    if (!replies) throw new Error('rate-limit transaction aborted');
    const [err, value] = replies[0];
    if (err) throw err;
    return Number(value);
  }
  async get(key: string): Promise<number> {
    const v = await this.client.get(key);
    return v ? Number(v) : 0;
  }
}
