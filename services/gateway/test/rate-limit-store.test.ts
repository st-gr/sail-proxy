/**
 * ValkeyRateLimitStore against a fake ioredis-shaped client: the `multi()...exec()` reply shape
 * (`[[err, value], ...]`), the WATCH-aborted case (`exec()` resolves `null` — must throw, not
 * throw a TypeError from indexing `null[0]`), a failed INCR step inside the reply, `get`'s 0-for-
 * absent default, and `ready()` mirroring `client.status`.
 */
import { ValkeyRateLimitStore } from '../src/services/rateLimitStore';

function multiClient(execResult: any, status = 'ready'): any {
  return {
    status,
    multi() {
      return {
        incr() { return this; },
        expire() { return this; },
        async exec() { return execResult; }
      };
    }
  };
}

describe('ValkeyRateLimitStore', () => {
  describe('incr', () => {
    it('returns the INCR reply value', async () => {
      const store = new ValkeyRateLimitStore(multiClient([[null, 7], [null, 1]]));
      expect(await store.incr('k', 60)).toBe(7);
    });

    it('throws when exec() resolves null (WATCH-aborted transaction)', async () => {
      const store = new ValkeyRateLimitStore(multiClient(null));
      await expect(store.incr('k', 60)).rejects.toThrow('rate-limit transaction aborted');
    });

    it('throws the reply error when the INCR step itself failed', async () => {
      const boom = new Error('x');
      const store = new ValkeyRateLimitStore(multiClient([[boom, null], [null, 1]]));
      await expect(store.incr('k', 60)).rejects.toBe(boom);
    });
  });

  describe('get', () => {
    it('returns 0 for an absent key and the numeric value otherwise', async () => {
      const client: any = { status: 'ready', get: async (key: string) => (key === 'present' ? '42' : null) };
      const store = new ValkeyRateLimitStore(client);
      expect(await store.get('missing')).toBe(0);
      expect(await store.get('present')).toBe(42);
    });
  });

  describe('ready', () => {
    it('follows client.status', () => {
      expect(new ValkeyRateLimitStore({ status: 'ready' } as any).ready()).toBe(true);
      expect(new ValkeyRateLimitStore({ status: 'connecting' } as any).ready()).toBe(false);
      expect(new ValkeyRateLimitStore({ status: undefined } as any).ready()).toBe(false);
    });
  });
});
