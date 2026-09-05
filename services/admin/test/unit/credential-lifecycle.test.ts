/**
 * credentialLifecycle holds the admin-only lifecycle rules for API keys and AWS credentials.
 * api_config.json is mocked per case (module isolation) exactly like sap-cu-factor.test.ts so
 * the configured and fallback paths of credentialExpirationDays() are both exercised.
 */
const REAL_FS = jest.requireActual('fs');

function load(security: any) {
  jest.resetModules();
  jest.doMock('fs', () => ({
    ...REAL_FS,
    readFileSync: (p: string, enc?: any) =>
      String(p).endsWith('api_config.json')
        ? JSON.stringify({ api_config: { platform: { security } } })
        : REAL_FS.readFileSync(p, enc),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/services/credentialLifecycle');
}

const NOW = new Date('2026-09-03T12:00:00Z');

describe('credentialExpirationDays / defaultExpiresAt (platform.security.credentialExpirationDays)', () => {
  afterEach(() => { jest.dontMock('fs'); jest.resetModules(); });

  it('uses the configured integer when >= 1', () => {
    expect(load({ credentialExpirationDays: 7 }).credentialExpirationDays()).toBe(7);
  });

  it('falls back to 90 when absent, zero, negative, fractional or non-numeric', () => {
    expect(load({ trust_forwarded_for: false }).credentialExpirationDays()).toBe(90);
    expect(load({ credentialExpirationDays: 0 }).credentialExpirationDays()).toBe(90);
    expect(load({ credentialExpirationDays: -5 }).credentialExpirationDays()).toBe(90);
    expect(load({ credentialExpirationDays: 2.5 }).credentialExpirationDays()).toBe(90);
    expect(load({ credentialExpirationDays: '10' }).credentialExpirationDays()).toBe(90);
    expect(load({}).DEFAULT_CREDENTIAL_EXPIRATION_DAYS).toBe(90);
  });

  it('the old apiKeyExpirationDays name is no longer honoured', () => {
    expect(load({ apiKeyExpirationDays: 7 }).credentialExpirationDays()).toBe(90);
  });

  it('defaultExpiresAt adds the configured days to now', () => {
    expect(load({ credentialExpirationDays: 30 }).defaultExpiresAt(NOW).toISOString())
      .toBe('2026-10-03T12:00:00.000Z');
    // The shipped default: API keys and AWS credentials share this one period.
    expect(load({}).defaultExpiresAt(NOW).toISOString()).toBe('2026-12-02T12:00:00.000Z');
  });
});

describe('expiresAtInPast', () => {
  const m = load({});
  it('null / undefined / empty is not a past date (never expires)', () => {
    expect(m.expiresAtInPast(null, NOW)).toBe(false);
    expect(m.expiresAtInPast(undefined, NOW)).toBe(false);
    expect(m.expiresAtInPast('', NOW)).toBe(false);
  });
  it('a date before now is in the past', () => {
    expect(m.expiresAtInPast('2026-09-03T11:59:59Z', NOW)).toBe(true);
    expect(m.expiresAtInPast('2020-01-01T00:00:00Z', NOW)).toBe(true);
    expect(m.expiresAtInPast(new Date('2020-01-01'), NOW)).toBe(true);
  });
  it('now or later is not in the past, and an unparseable value is left alone', () => {
    expect(m.expiresAtInPast('2026-09-03T12:00:00Z', NOW)).toBe(false);
    expect(m.expiresAtInPast('2026-09-03T12:00:01Z', NOW)).toBe(false);
    expect(m.expiresAtInPast('not-a-date', NOW)).toBe(false);
  });
});

describe('isExpired', () => {
  const m = load({});
  it('null / undefined / empty means never expires', () => {
    expect(m.isExpired(null, NOW)).toBe(false);
    expect(m.isExpired(undefined, NOW)).toBe(false);
    expect(m.isExpired('', NOW)).toBe(false);
  });
  it('past is expired, future is not, unparseable is not', () => {
    expect(m.isExpired('2026-09-03T11:59:59Z', NOW)).toBe(true);
    expect(m.isExpired('2026-09-03T12:00:01Z', NOW)).toBe(false);
    expect(m.isExpired(new Date('2020-01-01'), NOW)).toBe(true);
    expect(m.isExpired('not-a-date', NOW)).toBe(false);
  });
});

describe('credentialExpired (the never-expires flag wins over the stored date)', () => {
  const m = load({});
  it('a flagged row is never expired, whatever date it carries', () => {
    expect(m.credentialExpired({ neverExpires: true, expiresAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(false);
    expect(m.credentialExpired({ neverExpires: true, expiresAt: null }, NOW)).toBe(false);
  });
  it('an unflagged row falls back to the date', () => {
    expect(m.credentialExpired({ neverExpires: false, expiresAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(true);
    expect(m.credentialExpired({ expiresAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(true);
    expect(m.credentialExpired({ neverExpires: false, expiresAt: '2030-01-01T00:00:00Z' }, NOW)).toBe(false);
    // A legacy row that predates both the column and the backfill: null still means never expires.
    expect(m.credentialExpired({ expiresAt: null }, NOW)).toBe(false);
  });
  it('only a strict true counts as flagged, and a missing row is not expired', () => {
    expect(m.credentialExpired({ neverExpires: 1 as any, expiresAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(true);
    expect(m.credentialExpired(null, NOW)).toBe(false);
    expect(m.credentialExpired(undefined, NOW)).toBe(false);
  });
});

describe('normalizeLifecycle (neverExpires and expiresAt are kept consistent)', () => {
  const m = load({ credentialExpirationDays: 30 });
  const DEFAULT = '2026-10-03T12:00:00.000Z';

  it('the flag clears the date, even one that was supplied alongside it', () => {
    expect(m.normalizeLifecycle({ neverExpires: true, expiresAt: '2030-01-01T00:00:00Z', now: NOW }))
      .toEqual({ neverExpires: true, expiresAt: null });
    expect(m.normalizeLifecycle({ neverExpires: true, now: NOW }))
      .toEqual({ neverExpires: true, expiresAt: null });
  });

  it('clearing the flag without a date assigns the standard period', () => {
    expect(m.normalizeLifecycle({ neverExpires: false, expiresAt: null, now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: DEFAULT });
    expect(m.normalizeLifecycle({ neverExpires: false, expiresAt: '', now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: DEFAULT });
    expect(m.normalizeLifecycle({ now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: DEFAULT });
  });

  it('an explicit date is kept when the flag is off', () => {
    expect(m.normalizeLifecycle({ neverExpires: false, expiresAt: '2030-01-01T00:00:00Z', now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: '2030-01-01T00:00:00Z' });
  });

  it('anything but a strict true is off', () => {
    expect(m.normalizeLifecycle({ neverExpires: null, expiresAt: '2030-01-01T00:00:00Z', now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: '2030-01-01T00:00:00Z' });
  });

  /**
   * The callers in admin-service.ts pass `req.data.neverExpires ?? stored.neverExpires` rather
   * than the raw payload value. These cases pin down why: draft activation resends the whole row,
   * and `undefined` there means "the client said nothing", not "not flagged". Normalizing the raw
   * undefined would unflag a flagged row on any unrelated edit.
   */
  it('an undefined flag must be resolved against the stored value by the caller, not here', () => {
    // What the handler must NOT do - the raw undefined reads as "not flagged" and assigns a date.
    expect(m.normalizeLifecycle({ neverExpires: undefined, expiresAt: null, now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: DEFAULT });
    // What the handler does do: `undefined ?? stored` keeps a flagged row flagged and dateless.
    const reqData: { neverExpires?: boolean } = { neverExpires: undefined };
    const stored = { neverExpires: true, expiresAt: null };
    expect(m.normalizeLifecycle({
      neverExpires: reqData.neverExpires ?? stored.neverExpires,
      expiresAt: stored.expiresAt,
      now: NOW,
    })).toEqual({ neverExpires: true, expiresAt: null });
  });

  /**
   * The legacy row the backfill did not reach: neverExpires = false with no date. Normalizing it
   * hands it an expiration, which is an admin-only change - hence the isAdmin gate on the callers.
   */
  it('a legacy unflagged dateless row gains an expiration, which is why the callers gate on isAdmin', () => {
    expect(m.normalizeLifecycle({ neverExpires: false, expiresAt: null, now: NOW }))
      .toEqual({ neverExpires: false, expiresAt: DEFAULT });
  });
});

describe('creationExpiresAt (only admins may pre-set an expiration on creation)', () => {
  const m = load({});
  const FALLBACK = '2026-10-03T12:00:00.000Z';
  const REQUESTED = '2999-01-01T00:00:00.000Z';

  it('admin keeps a supplied date', () => {
    expect(m.creationExpiresAt({ isAdmin: true, requested: REQUESTED, fallback: FALLBACK })).toBe(REQUESTED);
    const asDate = new Date(REQUESTED);
    expect(m.creationExpiresAt({ isAdmin: true, requested: asDate, fallback: FALLBACK })).toBe(asDate);
  });

  it('admin without a supplied date gets the fallback', () => {
    expect(m.creationExpiresAt({ isAdmin: true, requested: undefined, fallback: FALLBACK })).toBe(FALLBACK);
    expect(m.creationExpiresAt({ isAdmin: true, requested: null, fallback: FALLBACK })).toBe(FALLBACK);
    expect(m.creationExpiresAt({ isAdmin: true, requested: '', fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('non-admin always gets the fallback, even when a date is supplied', () => {
    expect(m.creationExpiresAt({ isAdmin: false, requested: REQUESTED, fallback: FALLBACK })).toBe(FALLBACK);
    expect(m.creationExpiresAt({ isAdmin: false, requested: new Date(REQUESTED), fallback: FALLBACK })).toBe(FALLBACK);
    expect(m.creationExpiresAt({ isAdmin: false, requested: undefined, fallback: FALLBACK })).toBe(FALLBACK);
  });
});

describe('lifecycleChangeViolation (only admins change isActive / expiresAt)', () => {
  const m = load({});
  const stored = { isActive: true, expiresAt: '2026-10-03T12:00:00.000Z' };

  it('admin may change either field', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: true, data: { isActive: false }, stored })).toBeNull();
    expect(m.lifecycleChangeViolation({ isAdmin: true, data: { expiresAt: '2027-01-01T00:00:00Z' }, stored })).toBeNull();
  });

  it('non-admin changing isActive is a violation', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { isActive: false }, stored }))
      .toBe('Only an administrator can change the active state');
  });

  it('non-admin changing expiresAt (including clearing it) is a violation', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { expiresAt: '2027-01-01T00:00:00Z' }, stored }))
      .toBe('Only an administrator can change the expiration date');
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { expiresAt: null }, stored }))
      .toBe('Only an administrator can change the expiration date');
  });

  it('non-admin changing neverExpires is a violation, in either direction', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { neverExpires: true }, stored }))
      .toBe('Only an administrator can change the never-expires flag');
    expect(m.lifecycleChangeViolation({
      isAdmin: false,
      data: { neverExpires: false },
      stored: { isActive: true, expiresAt: null, neverExpires: true },
    })).toBe('Only an administrator can change the never-expires flag');
  });

  it('an admin may set or clear neverExpires', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: true, data: { neverExpires: true }, stored })).toBeNull();
  });

  it('non-admin sending the unchanged values (draft activation sends the full row) passes', () => {
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { neverExpires: false }, stored })).toBeNull();
    expect(m.lifecycleChangeViolation({
      isAdmin: false,
      data: { neverExpires: true, expiresAt: null },
      stored: { isActive: true, expiresAt: null, neverExpires: true },
    })).toBeNull();
    expect(m.lifecycleChangeViolation({
      isAdmin: false,
      data: { name: 'renamed', isActive: true, expiresAt: '2026-10-03T12:00:00Z' },
      stored,
    })).toBeNull();
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { name: 'x' }, stored })).toBeNull();
    expect(m.lifecycleChangeViolation({ isAdmin: false, data: { expiresAt: null }, stored: { isActive: true, expiresAt: null } })).toBeNull();
  });
});

describe('rotationPolicy (a refresh always moves the expiration forward)', () => {
  const m = load({ credentialExpirationDays: 30 });
  const DEFAULT = '2026-10-03T12:00:00.000Z';

  it('admin rotation resets expiresAt to the default', () => {
    expect(m.rotationPolicy({ isAdmin: true, stored: { isActive: true, expiresAt: '2026-09-04T00:00:00Z' }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
  });

  it('owner rotation also resets expiresAt to the default - it never keeps the stored date', () => {
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: true, expiresAt: '2026-09-04T00:00:00Z' }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
    // Including a credential that never expired: refreshing gives it a date.
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: true, expiresAt: null }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
    // And one whose date was further out: the refresh is authoritative, not a max().
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: true, expiresAt: '2030-01-01T00:00:00Z' }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
  });

  it('non-admin cannot rotate an inactive or expired credential', () => {
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: false, expiresAt: null }, now: NOW }))
      .toEqual({ allowed: false, reason: 'inactive' });
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: true, expiresAt: '2026-09-01T00:00:00Z' }, now: NOW }))
      .toEqual({ allowed: false, reason: 'expired' });
  });

  it('an admin may still rotate an inactive or expired credential, and it gets the default', () => {
    expect(m.rotationPolicy({ isAdmin: true, stored: { isActive: false, expiresAt: null }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
    expect(m.rotationPolicy({ isAdmin: true, stored: { isActive: true, expiresAt: '2026-09-01T00:00:00Z' }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: DEFAULT });
  });

  it('a never-expiring credential stays dateless through a refresh, for owner and admin alike', () => {
    expect(m.rotationPolicy({ isAdmin: false, stored: { isActive: true, expiresAt: null, neverExpires: true }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: null });
    expect(m.rotationPolicy({ isAdmin: true, stored: { isActive: true, expiresAt: null, neverExpires: true }, now: NOW }))
      .toEqual({ allowed: true, expiresAt: null });
  });

  it('the flag also lifts the owner expired-refusal on a stale stored date', () => {
    expect(m.rotationPolicy({
      isAdmin: false,
      stored: { isActive: true, expiresAt: '2026-09-01T00:00:00Z', neverExpires: true },
      now: NOW,
    })).toEqual({ allowed: true, expiresAt: null });
    // The inactive refusal is untouched by the flag - only an administrator resurrects a key.
    expect(m.rotationPolicy({
      isAdmin: false,
      stored: { isActive: false, expiresAt: null, neverExpires: true },
      now: NOW,
    })).toEqual({ allowed: false, reason: 'inactive' });
  });
});
