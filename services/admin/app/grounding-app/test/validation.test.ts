import { storeNameProblem, parseExpiryDays } from '../webapp/model/validation';

describe('storeNameProblem', () => {
  it('flags an empty or blank name', () => {
    expect(storeNameProblem('')).toBe('empty');
    expect(storeNameProblem('   ')).toBe('empty');
    expect(storeNameProblem('\t\n')).toBe('empty');
  });
  it('accepts a name with content, whatever its surrounding space', () => {
    expect(storeNameProblem('Docs')).toBeNull();
    expect(storeNameProblem('  Docs  ')).toBeNull();
  });
});

describe('parseExpiryDays', () => {
  it('reads an empty value as no expiry', () => {
    expect(parseExpiryDays('')).toEqual({ ok: true, days: null });
    expect(parseExpiryDays('  ')).toEqual({ ok: true, days: null });
  });
  it('accepts whole days from 1 to 365', () => {
    expect(parseExpiryDays('1')).toEqual({ ok: true, days: 1 });
    expect(parseExpiryDays(' 30 ')).toEqual({ ok: true, days: 30 });
    expect(parseExpiryDays('365')).toEqual({ ok: true, days: 365 });
  });
  it('refuses zero, more than a year, and anything that is not 1 to 3 digits', () => {
    for (const raw of ['0', '000', '366', '999', '1000', '-5', '1.5', '1e2', 'abc', '12a', '+7']) {
      expect(parseExpiryDays(raw)).toEqual({ ok: false });
    }
  });
});
