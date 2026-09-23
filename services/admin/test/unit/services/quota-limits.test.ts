export {};
/**
 * Effective limit per field: user value if not null, else the assigned profile's if not null, else
 * platform default if not null, else unlimited; the source is reported beside it. Constraint edits
 * are validated the same way the before-UPDATE handler will (non-negative, integers where typed).
 */
import { effectiveLimits, validateConstraints, defaultText, effectiveLimitText, maintenanceRunAtUtc, UNLIMITED, LIMIT_FIELDS } from '../../../src/services/quotaLimits';

describe('effectiveLimits', () => {
  it('resolves user > platform > unlimited per field and reports the source', () => {
    const platform = { ...UNLIMITED, requestsPerMinute: 60, tokensPerDay: 100000 };
    const { limits, limitSource } = effectiveLimits({ requestsPerMinute: 10, spendPerDay: '1.5000', tokensPerDay: null }, null, platform);
    expect(limits).toMatchObject({ requestsPerMinute: 10, spendPerDay: 1.5, tokensPerDay: 100000, spendPerWeek: null });
    expect(limitSource).toMatchObject({ requestsPerMinute: 'user', spendPerDay: 'user', tokensPerDay: 'platform', spendPerWeek: 'unlimited' });
  });
  it('treats a missing user as all-platform', () => {
    const { limits, limitSource } = effectiveLimits(null, null, { ...UNLIMITED, spendPerMonth: 20 });
    expect(limits.spendPerMonth).toBe(20);
    expect(limitSource.spendPerMonth).toBe('platform');
    for (const f of LIMIT_FIELDS) if (f !== 'spendPerMonth') expect(limitSource[f]).toBe('unlimited');
  });
  it('resolves user > profile > platform > unlimited per field and reports the source', () => {
    const platform = { ...UNLIMITED, requestsPerMinute: 60, tokensPerDay: 100000, spendPerMonth: 20 };
    const profile = { requestsPerMinute: 30, tokensPerDay: 5000000, spendPerDay: 250 };
    const { limits, limitSource } = effectiveLimits({ requestsPerMinute: 200, tokensPerDay: null }, profile, platform);
    expect(limits).toMatchObject({ requestsPerMinute: 200, tokensPerDay: 5000000, spendPerDay: 250, spendPerMonth: 20, spendPerWeek: null });
    expect(limitSource).toMatchObject({ requestsPerMinute: 'user', tokensPerDay: 'profile', spendPerDay: 'profile', spendPerMonth: 'platform', spendPerWeek: 'unlimited' });
  });
  it('a user value may exceed the profile; a profile null falls through to the platform', () => {
    const { limits, limitSource } = effectiveLimits({ spendPerDay: 5000 }, { spendPerDay: 250, spendPerWeek: null }, { ...UNLIMITED, spendPerWeek: 1000 });
    expect(limits.spendPerDay).toBe(5000); expect(limitSource.spendPerDay).toBe('user');
    expect(limits.spendPerWeek).toBe(1000); expect(limitSource.spendPerWeek).toBe('platform');
  });
});

/**
 * The text the users-app prints beside an EMPTY constraint: the figure that applies once the field
 * is cleared, and where it comes from. Resolved per field independently of the user's own value -
 * the profile's figure where the profile carries one, else the platform default, else unlimited -
 * so a profile that leaves one window null still names the platform default for it.
 */
describe('effectiveLimitText', () => {
  // What a credential page shows for its owner's user-level limit: the resolved value and where
  // it comes from, in the same shapes the Default line under a constraint uses.
  const base = { sapCostCurrency: 'USD', quotaProfileName: null as string | null };
  it('names the source of the resolved limit: own constraint, profile, platform', () => {
    expect(effectiveLimitText('requestsPerMinute', { ...base, limits: { ...UNLIMITED, requestsPerMinute: 200 }, limitSource: { ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 'unlimited'])), requestsPerMinute: 'user' } as any })).toBe('200 (own constraint)');
    expect(effectiveLimitText('requestsPerMinute', { ...base, quotaProfileName: 'Standard', limits: { ...UNLIMITED, requestsPerMinute: 60 }, limitSource: { ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 'unlimited'])), requestsPerMinute: 'profile' } as any })).toBe('60 (Standard profile)');
    expect(effectiveLimitText('requestsPerMinute', { ...base, limits: { ...UNLIMITED, requestsPerMinute: 30 }, limitSource: { ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 'unlimited'])), requestsPerMinute: 'platform' } as any })).toBe('30 (platform)');
  });
  it('says unlimited when nothing applies, and formats spend with the currency', () => {
    expect(effectiveLimitText('requestsPerMinute', { ...base, limits: UNLIMITED, limitSource: Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 'unlimited'])) as any })).toBe('unlimited');
    expect(effectiveLimitText('spendPerDay', { ...base, quotaProfileName: 'Light', limits: { ...UNLIMITED, spendPerDay: 25 }, limitSource: { ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 'unlimited'])), spendPerDay: 'profile' } as any })).toBe('25.00 USD (Light profile)');
  });
});

describe('defaultText', () => {
  const status = (over: Record<string, any> = {}) =>
    ({ quotaProfileName: null, sapCostCurrency: 'USD', profileLimits: null, platformLimits: { ...UNLIMITED }, ...over }) as any;

  it('names the profile and groups counts en-US', () => {
    expect(defaultText('tokensPerDay', status({ quotaProfileName: 'Standard', profileLimits: { tokensPerDay: 1000000 } })))
      .toBe('1,000,000 (Standard profile)');
  });

  it('names the platform, with two decimals and the status currency for spend', () => {
    expect(defaultText('spendPerDay', status({ platformLimits: { ...UNLIMITED, spendPerDay: 25 } })))
      .toBe('25.00 USD (platform)');
  });

  it('is "unlimited" when neither the profile nor the platform sets the field', () => {
    expect(defaultText('spendPerWeek', status({ quotaProfileName: 'Standard', profileLimits: { tokensPerDay: 5 } })))
      .toBe('unlimited');
  });

  it('falls through a field the profile leaves null to the platform default', () => {
    expect(defaultText('spendPerDay', status({ quotaProfileName: 'Standard', profileLimits: { spendPerDay: null, tokensPerDay: 5 }, platformLimits: { ...UNLIMITED, spendPerDay: 25 } })))
      .toBe('25.00 USD (platform)');
  });
});

describe('validateConstraints', () => {
  it('accepts nulls, non-negative numbers and integers where typed', () => {
    expect(validateConstraints({ requestsPerMinute: 0, tokensPerDay: 1000, spendPerDay: 0.25, spendPerWeek: null })).toEqual([]);
  });
  it('names each invalid field', () => {
    // errors come out in LIMIT_FIELDS order (requests, spend..., tokens...)
    expect(validateConstraints({ requestsPerMinute: -1, tokensPerDay: 1.5, spendPerDay: 'abc' })).toEqual([
      'requestsPerMinute must be a non-negative integer',
      'spendPerDay must be a non-negative number',
      'tokensPerDay must be a non-negative integer'
    ]);
  });
});

/**
 * A day's allowance cannot exceed a week's, nor a week's a month's: the wider window is the harder
 * ceiling, so `tokensPerDay 100` beside `tokensPerMonth 10` is a pair of numbers the gateway can
 * never honour together, and it was accepted.
 *
 * The check reads the MERGED values - the stored row overlaid by the patch - because a constraint
 * edit is a patch: sending `tokensPerDay 100` alone must be judged against the month already
 * stored, and a patch that fixes an existing violation must be accepted rather than blamed for it.
 * null is unlimited on either side and is never compared: unlimited is not "more" than anything.
 */
describe('validateConstraints - the windows have to be ordered', () => {
  it('rejects a day above the week, a week above the month, and a day above the month', () => {
    expect(validateConstraints({ tokensPerDay: 100, tokensPerWeek: 10 })).toEqual(['tokensPerDay must not exceed tokensPerWeek']);
    expect(validateConstraints({ tokensPerWeek: 100, tokensPerMonth: 10 })).toEqual(['tokensPerWeek must not exceed tokensPerMonth']);
    expect(validateConstraints({ tokensPerDay: 100, tokensPerMonth: 10 })).toEqual(['tokensPerDay must not exceed tokensPerMonth']);
    expect(validateConstraints({ spendPerDay: 1.5, spendPerWeek: 1 })).toEqual(['spendPerDay must not exceed spendPerWeek']);
    expect(validateConstraints({ spendPerWeek: 10, spendPerMonth: 1 })).toEqual(['spendPerWeek must not exceed spendPerMonth']);
    expect(validateConstraints({ spendPerDay: 10, spendPerMonth: 1 })).toEqual(['spendPerDay must not exceed spendPerMonth']);
  });

  it('accepts equal values - a month spendable in one day is a choice, not a mistake', () => {
    expect(validateConstraints({ tokensPerDay: 10, tokensPerWeek: 10, tokensPerMonth: 10 })).toEqual([]);
    expect(validateConstraints({ spendPerDay: 2, spendPerWeek: 2, spendPerMonth: 2 })).toEqual([]);
  });

  it('never compares an unlimited window', () => {
    expect(validateConstraints({ tokensPerDay: 1000, tokensPerMonth: null })).toEqual([]);
    expect(validateConstraints({ tokensPerDay: null, tokensPerMonth: 10 })).toEqual([]);
    expect(validateConstraints({ tokensPerDay: 1000 }, { tokensPerMonth: null })).toEqual([]);
  });

  it('judges a patch against the row it is patching', () => {
    expect(validateConstraints({ tokensPerDay: 100 }, { tokensPerMonth: 10 })).toEqual(['tokensPerDay must not exceed tokensPerMonth']);
    expect(validateConstraints({ tokensPerMonth: 10 }, { tokensPerDay: 100 })).toEqual(['tokensPerDay must not exceed tokensPerMonth']);
    // The stored row is only consulted where the patch is silent.
    expect(validateConstraints({ tokensPerDay: 5 }, { tokensPerDay: 100, tokensPerMonth: 10 })).toEqual([]);
  });

  it('accepts a patch that repairs a violation the row already carries', () => {
    // Both fields sent at once: what the form does when the object page is saved.
    expect(validateConstraints({ tokensPerDay: 1, tokensPerMonth: 30 }, { tokensPerDay: 100, tokensPerMonth: 10 })).toEqual([]);
    // Clearing the day: unlimited beside a month is not an ordering the check has anything to say
    // about, and the pair is no longer contradictory.
    expect(validateConstraints({ tokensPerDay: null }, { tokensPerDay: 100, tokensPerMonth: 10 })).toEqual([]);
  });

  it('reads a cleared field ("" from the form) as unlimited, not as 0', () => {
    expect(validateConstraints({ tokensPerDay: '' as any, tokensPerMonth: 10 })).toEqual([]);
  });

  it('keeps the per-field errors and adds nothing about a field it could not read', () => {
    expect(validateConstraints({ tokensPerDay: 'abc', tokensPerMonth: 10 })).toEqual(['tokensPerDay must be a non-negative integer']);
  });

  it('says nothing about requestsPerMinute, which has one window only', () => {
    expect(validateConstraints({ requestsPerMinute: 1000 }, { tokensPerDay: 1 })).toEqual([]);
  });
});

describe('maintenanceRunAtUtc', () => {
  const dbWith = (maintenance: unknown) => ({
    run: jest.fn(async () => [{ configData: JSON.stringify({ api_config: { platform: { maintenance } } }) }])
  });

  it('reads platform.maintenance.dailyRunAtUtc from the active configuration', async () => {
    expect(await maintenanceRunAtUtc(dbWith({ dailyRunAtUtc: '08:00' }))).toBe('08:00');
  });

  it('is null when the section or the field is absent', async () => {
    expect(await maintenanceRunAtUtc(dbWith(undefined))).toBeNull();
    expect(await maintenanceRunAtUtc(dbWith({ dailyRunAtUtc: null }))).toBeNull();
  });

  // The schema rejects these, but a configuration row is not re-validated when it is read back:
  // an unusable value falls back to today's behaviour rather than arming a nonsense timer.
  it('is null for a value that is not HH:MM', async () => {
    for (const value of ['8:00', '24:00', '0800', '08:00:00', 42]) {
      expect(await maintenanceRunAtUtc(dbWith({ dailyRunAtUtc: value }))).toBeNull();
    }
  });
});
