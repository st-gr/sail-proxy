/** scanJson against a fake Valkey client: the real loop, not a mocked scanJson. */
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
import { quotaStateStore } from '../../../src/services/quotaStateStore';

const withClient = (client: any) => { (quotaStateStore as any).client = client; };
afterEach(() => withClient(null));

describe('scanJson', () => {
  it('is null without a ready client', async () => {
    withClient(null);
    expect(await quotaStateStore.scanJson('p:*')).toBeNull();
  });

  it('follows the cursor to its end and parses each value, skipping what is not JSON', async () => {
    const pages: Record<string, [string, string[]]> = { '0': ['7', ['p:a']], '7': ['0', ['p:b', 'p:bad']] };
    const values: Record<string, string> = { 'p:a': '{"n":1}', 'p:b': '{"n":2}', 'p:bad': 'nope' };
    withClient({ status: 'ready', scan: jest.fn(async (c: string) => pages[c]), get: jest.fn(async (k: string) => values[k]) });
    expect(await quotaStateStore.scanJson('p:*')).toEqual([{ key: 'p:a', value: { n: 1 } }, { key: 'p:b', value: { n: 2 } }]);
  });

  it('stops after a bounded number of calls when the cursor never returns to 0 and nothing matches', async () => {
    const scan = jest.fn(async () => ['5', []]);
    withClient({ status: 'ready', scan, get: jest.fn() });
    expect(await quotaStateStore.scanJson('p:*')).toEqual([]);
    expect(scan.mock.calls.length).toBe(200);
  });

  it('is null when the scan fails', async () => {
    withClient({ status: 'ready', scan: jest.fn(async () => { throw new Error('down'); }), get: jest.fn() });
    expect(await quotaStateStore.scanJson('p:*')).toBeNull();
  });
});
