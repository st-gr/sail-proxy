import { criticality, WARN_PERCENT, ERROR_PERCENT } from '../../../src/services/quotaCriticality';

describe('quota criticality (UI.CriticalityType)', () => {
  it('pins the thresholds the shell card uses', () => { expect(WARN_PERCENT).toBe(75); expect(ERROR_PERCENT).toBe(90); });
  it('is neutral without a limit', () => { expect(criticality(400, null)).toBe(0); expect(criticality(400, undefined)).toBe(0); });
  it('is positive below 75 %, critical from 75 %, negative from 90 %', () => {
    expect(criticality(740, 1000)).toBe(3);
    expect(criticality(750, 1000)).toBe(2);
    expect(criticality(899, 1000)).toBe(2);
    expect(criticality(900, 1000)).toBe(1);
    expect(criticality(1300, 1000)).toBe(1);
  });
  it('treats a zero or negative limit as exhausted and a missing used figure as 0', () => {
    expect(criticality(0, 0)).toBe(1);
    expect(criticality(null, 1000)).toBe(3);
  });
});
