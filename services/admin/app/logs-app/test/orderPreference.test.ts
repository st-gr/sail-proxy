import { ORDER_KEY, readOrder, writeOrder } from '../webapp/model/orderPreference';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
};
const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };

describe('order preference', () => {
  it('opens newest last when nothing is remembered', () => {
    expect(readOrder(memory())).toBe('newestLast');
    expect(readOrder(null)).toBe('newestLast');
  });

  it('remembers newest first for the person', () => {
    const storage = memory();
    writeOrder(storage, 'newestFirst');
    expect(storage.data.get(ORDER_KEY)).toBe('newestFirst');
    expect(readOrder(storage)).toBe('newestFirst');
  });

  it('ignores a value it does not know', () => {
    const storage = memory();
    storage.setItem(ORDER_KEY, 'sideways');
    expect(readOrder(storage)).toBe('newestLast');
  });

  it('works without storage: a refusing browser changes nothing', () => {
    expect(readOrder(throwing)).toBe('newestLast');
    expect(() => writeOrder(throwing, 'newestFirst')).not.toThrow();
    expect(() => writeOrder(null, 'newestFirst')).not.toThrow();
  });
});
