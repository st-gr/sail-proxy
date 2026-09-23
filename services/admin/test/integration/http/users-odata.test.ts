/**
 * The Users & quotas OData surface (spec §4) end to end on cds.test(): admin-only grants, no
 * create/delete, constraint edits through the draft flow with validation, deactivate/reactivate
 * through bound and unbound actions, bulk quota reset, status figures for API consumers and for
 * the caller, and per-credential rate limits with the owner-or-admin rule. Synthetic usage rows
 * only.
 *
 * Note: `effectiveTokensPerDay`/`limitSourceTokensPerDay` (not `...TokensDay`) below — the seven
 * `effective*`/`limitSource*` virtuals on Users/UserQuotaStatus are named after the LIMIT_FIELDS
 * constraint field itself (`tokensPerDay`), same as the CDS declarations in admin-service.cds.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'uq-admin@test.com': { id: 'uq-admin@test.com', roles: ['admin', 'user'] },
  'uq-user@test.com': { id: 'uq-user@test.com', roles: ['user'] },
  'uq-other@test.com': { id: 'uq-other@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), shutdown: jest.fn() } }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
const validationService = require('../../../src/srv/validation-service').instance;
import * as users from '../../../src/services/usersService';
import * as counters from '../../../src/services/usageCounters';

const ADMIN = { auth: { username: 'uq-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'uq-user@test.com', password: 'x' } };
const OTHER = { auth: { username: 'uq-other@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const RL = 'sap.llm.gateway.admin.RateLimits';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const NOTES = 'sap.llm.gateway.admin.SecurityNotifications';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const u = (email: string) => `${S}/Users(email='${encodeURIComponent(email)}',IsActiveEntity=true)`;
const ud = (email: string) => `${S}/Users(email='${encodeURIComponent(email)}',IsActiveEntity=false)`;

beforeEach(async () => {
  const { DELETE: DEL, INSERT } = cds.ql;
  for (const t of [KEY_USAGE, AWS_USAGE, RL, NOTES, AUDIT, USERS, KEYS, AWS, counters.BUCKETS]) await cds.db.run(DEL.from(t));
  try { await cds.db.run(DEL.from('AdminService.Users.drafts')); } catch { /* no draft table */ }
  await cds.db.run(INSERT.into(KEYS).entries([
    { ID: 'k-u1', key: 'sk-u1', name: 'u1', email: 'uq-user@test.com', isActive: true },
    { ID: 'k-o1', key: 'sk-o1', name: 'o1', email: 'uq-other@test.com', isActive: true }
  ]));
  await cds.db.run(INSERT.into(AWS).entries({ ID: 'c-u1', accessKeyId: 'AKIAUQ1', secretHash: 'h', salt: 's', name: 'c', email: 'uq-user@test.com', userId: 'uq-user@test.com', region: 'us-east-1', isActive: true }));
  await users.touch(cds.db, 'uq-user@test.com', { roles: ['user'] });
  await users.touch(cds.db, 'uq-other@test.com', { roles: ['user'] });
  await cds.db.run(INSERT.into(KEY_USAGE).entries({ apiKey_ID: 'k-u1', email: 'uq-user@test.com', validFrom: new Date(), validTo: new Date(), provider: 'anthropic', model: 'm', statusCode: 200, inputTokens: 300, outputTokens: 100, totalTokens: 400, sapCost: 0.25, sapCostCurrency: 'USD', usageSignature: `sig-${Date.now()}` }));
  await counters.rebuild(cds.db);
  validationService.cache?.apiKeys?.clear?.(); validationService.cache?.awsCredentials?.clear?.();
});

describe('grants and shape', () => {
  it('Users, UserCredentials and UserQuotaStatus are admin-only; no create or delete', async () => {
    expect((await ok(GET(`${S}/Users`, USER))).status).toBe(403);
    expect((await ok(GET(`${S}/UserCredentials`, USER))).status).toBe(403);
    expect((await ok(GET(`${S}/UserQuotaStatus`, USER))).status).toBe(403);
    const list = await GET(`${S}/Users?$orderby=email`, ADMIN);
    expect(list.data.value.map((x: any) => x.email)).toEqual(['uq-other@test.com', 'uq-user@test.com']);
    expect((await ok(POST(`${S}/Users`, { email: 'new@test.com' }, ADMIN))).status).toBeGreaterThanOrEqual(400);
    expect((await ok(DELETE(u('uq-other@test.com'), ADMIN))).status).toBeGreaterThanOrEqual(400);
  });

  it('virtual usage and effective-limit fields ride on the row', async () => {
    const row = (await GET(`${u('uq-user@test.com')}`, ADMIN)).data;
    expect(row).toMatchObject({ status: 'active', usedTokensDay: 400, usedTokensMonth: 400, limitSourceTokensPerDay: 'unlimited', effectiveTokensPerDay: null, canDeactivate: true, canReactivate: false });
    expect(Number(row.usedSpendDay)).toBeCloseTo(0.25, 4);
    // the currency the spend figures and limits are denominated in rides along (USD: no SAP
    // capacity-unit price row in this suite, so quotaCurrency falls back)
    expect(row.sapCostCurrency).toBe('USD');
    // no quota profile and no platform default for this field: clearing the constraint means unlimited
    expect(row.quotaProfileName).toBeNull();
    expect(row.tokensPerDayDefaultText).toBe('unlimited');
    const creds = (await GET(`${S}/UserCredentials?$filter=email eq 'uq-user@test.com'&$orderby=type`, ADMIN)).data.value;
    expect(creds.map((c: any) => [c.type, c.credentialId, c.isActive])).toEqual([['api_key', 'k-u1', true], ['aws_credential', 'c-u1', true]]);
  });

  it('UserCredentials evaluates $filter/$orderby/$top/$skip/$count in memory (type/credentialId are not columns on either underlying table)', async () => {
    const byType = (await GET(`${S}/UserCredentials?$filter=type eq 'api_key'`, ADMIN)).data.value;
    expect(byType.map((c: any) => c.credentialId).sort()).toEqual(['k-o1', 'k-u1']);

    const byId = (await GET(`${S}/UserCredentials?$filter=credentialId eq 'c-u1'`, ADMIN)).data.value;
    expect(byId).toEqual([expect.objectContaining({ credentialId: 'c-u1', type: 'aws_credential' })]);

    const both = (await GET(`${S}/UserCredentials?$filter=email eq 'uq-user@test.com' and isActive eq true`, ADMIN)).data.value;
    expect(both.map((c: any) => c.credentialId).sort()).toEqual(['c-u1', 'k-u1']);

    // No $filter: all 3 fixture credentials (k-u1, k-o1, c-u1); ordered by type asc then the
    // implicit credentialId tiebreaker -> [k-o1, k-u1] (api_key) then [c-u1] (aws_credential).
    const page = await GET(`${S}/UserCredentials?$top=1&$skip=1&$orderby=type&$count=true`, ADMIN);
    expect(page.data.value).toEqual([expect.objectContaining({ credentialId: 'k-u1' })]);
    expect(page.data['@odata.count']).toBe(3);

    expect((await ok(GET(`${S}/UserCredentials?$filter=contains(name,'x')`, ADMIN))).status).toBe(400);
  });
});

describe('IEEE754Compatible clients', () => {
  it('serialises the computed Integer64 figures as strings when the client asks for IEEE754Compatible, as numbers otherwise', async () => {
    const plain = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(typeof plain.usedTokensDay).toBe('number');
    const ieee = (await GET(u('uq-user@test.com'), { ...ADMIN, headers: { Accept: 'application/json;odata.metadata=minimal;IEEE754Compatible=true' } })).data;
    // the UI5 V4 model sends this header; its Int64 type throws on a JSON number when it converts
    // for a float control property (the users-app bullet charts' target value)
    expect(ieee.usedTokensDay).toBe('400');
    expect(ieee.usedTokensMonth).toBe('400');
    expect(ieee.effectiveTokensPerDay).toBeNull();
    expect(typeof ieee.usedSpendDay).toBe('number');
  });
});

describe('list fan-out', () => {
  // afterReadUsers hands the whole page to userQuotaService.statusMany (one currency and one
  // platform-defaults resolution for the page, chunked fan-out) instead of one status() per row.
  // That the two resolvers run once per page is asserted in test/unit/services/
  // user-quota-service.test.ts: cds loads the service's TypeScript through its own require
  // (CDS_TYPESCRIPT), so the handlers hold a different module instance than this file imports and
  // a jest.spyOn here would never see their calls. What this suite owns is the row shape - every
  // row of a multi-row page still carries the same virtuals, and nothing beyond them.
  it('a page of three users carries every virtual and nothing more', async () => {
    await users.touch(cds.db, 'uq-third@test.com', { roles: ['user'] });
    let queries = 0;
    cds.db.before('*', () => { queries += 1; });
    const rows = (await GET(`${S}/Users?$orderby=email`, ADMIN)).data.value;
    console.log(`[list fan-out] ${queries} database queries for a ${rows.length}-user page`);

    expect(rows.map((r: any) => r.email)).toEqual(['uq-other@test.com', 'uq-third@test.com', 'uq-user@test.com']);
    for (const row of rows) {
      for (const key of ['usedRequestsMinute', 'sapCostCurrency', 'usedTokensDay', 'usedTokensWeek', 'usedTokensMonth',
        'usedSpendDay', 'usedSpendWeek', 'usedSpendMonth', 'resetsAtDay', 'resetsAtWeek', 'resetsAtMonth',
        'effectiveTokensPerDay', 'limitSourceTokensPerDay', 'effectiveRequestsPerMinute', 'limitSourceRequestsPerMinute',
        'quotaProfile_ID', 'toolPolicy_ID', 'quotaProfileName', 'requestsPerMinuteDefaultText', 'spendPerDayDefaultText', 'spendPerWeekDefaultText',
        'spendPerMonthDefaultText', 'tokensPerDayDefaultText', 'tokensPerWeekDefaultText', 'tokensPerMonthDefaultText',
        'criticalitySpendDay', 'criticalitySpendWeek', 'criticalitySpendMonth', 'criticalityTokensDay', 'criticalityTokensWeek', 'criticalityTokensMonth']) {
        expect(row).toHaveProperty(key);
      }
      expect(row).toMatchObject({ canDeactivate: true, canReactivate: false, statusCriticality: 3 });
      // remaining* stays off the Users row (UserQuotaStatus-only, spec §4)
      expect(row.remainingTokensDay).toBeUndefined();
      expect(row.remainingSpendDay).toBeUndefined();
    }
    expect(rows.find((r: any) => r.email === 'uq-user@test.com')).toMatchObject({ usedTokensDay: 400, usedTokensMonth: 400 });
    expect(rows.find((r: any) => r.email === 'uq-third@test.com')).toMatchObject({ usedTokensDay: 0 });
  });
});

describe('constraints', () => {
  it('an admin edits constraints through the draft flow; invalid values are 400; read-only fields cannot change', async () => {
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    await PATCH(ud('uq-user@test.com'), { tokensPerDay: 1000, spendPerMonth: '2.5' }, ADMIN);
    const activated = await POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN);
    expect(activated.status).toBe(200);
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(row).toMatchObject({ tokensPerDay: 1000, effectiveTokensPerDay: 1000, limitSourceTokensPerDay: 'user', usedTokensDay: 400 });
    expect(Number(row.spendPerMonth)).toBe(2.5);
    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'user.set_constraints', resourceId: 'uq-user@test.com' }));
    expect(audit).toBeTruthy();
    expect(audit.details).toContain('tokensPerDay');

    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const bad = await ok(PATCH(ud('uq-user@test.com'), { tokensPerDay: -5 }, ADMIN));
    expect(bad.status).toBe(400);
    const ro = await ok(PATCH(ud('uq-user@test.com'), { status: 'deactivated' }, ADMIN));
    expect(ro.status).toBe(400);
  });

  it('draftActivate does not reject on server-owned columns moved between draftEdit and activation', async () => {
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    await PATCH(ud('uq-user@test.com'), { tokensPerDay: 250 }, ADMIN);
    // lastSeenAt/rolesSnapshot move on the ACTIVE row between draftEdit and activation (e.g. the
    // user makes an API call); the draft's snapshot is now stale for both, but draftActivate must
    // still succeed and must not revert the active row's rolesSnapshot to the stale draft value.
    await users.touch(cds.db, 'uq-user@test.com', { roles: ['user', 'extra'] });
    const activated = await POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN);
    expect(activated.status).toBe(200);
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(row.tokensPerDay).toBe(250);
    expect(row.rolesSnapshot).toBe('["user","extra"]');
  });

  it('carries a criticality per window: 0 without a limit, 2 at 80 %, from the same 75/90 rule as the card', async () => {
    // the seeded user has 400 tokens today; a 500-token day limit puts the day window at 80 %
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    await ok(PATCH(ud('uq-user@test.com'), { tokensPerDay: 500 }, ADMIN));
    expect((await POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(row).toMatchObject({ criticalityTokensDay: 2, criticalityTokensWeek: 0, criticalityTokensMonth: 0, criticalitySpendDay: 0, criticalitySpendWeek: 0, criticalitySpendMonth: 0 });
  });

  it('a draft PATCH carrying the read-back currency virtual is not refused as read-only', async () => {
    // Fiori Elements resubmits what it read; sapCostCurrency is one of the values the READ pipeline
    // wrote onto the draft row, so the read-only guard must let it through like the other virtuals.
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const patched = await ok(PATCH(ud('uq-user@test.com'), { spendPerDay: '1.5', sapCostCurrency: 'USD', quotaProfileName: null, tokensPerDayDefaultText: 'unlimited', criticalityTokensDay: 2 }, ADMIN));
    expect(patched.status).toBeLessThan(300);
    const activated = await POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN);
    expect(activated.status).toBe(200);
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(Number(row.spendPerDay)).toBe(1.5);
    expect(row.sapCostCurrency).toBe('USD');
    // an effective limit carries the currency only when it exists: the day limit was just set,
    // the week limit is still the platform default (unlimited)
    expect(row.effectiveSpendPerDayCurrency).toBe('USD');
    expect(row.effectiveSpendPerWeek).toBeNull();
    expect(row.effectiveSpendPerWeekCurrency).toBeNull();
  });

  it('the setRateLimits parameters default to the bound credential\'s current limits (Fiori Elements prefills the dialog from these paths)', async () => {
    const edmx = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    for (const entity of ['ApiKeys', 'AwsCredentials']) {
      for (const p of ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay']) {
        const target = `Target="AdminService.setRateLimits(AdminService.${entity})/${p}"`;
        const block = edmx.slice(edmx.indexOf(target), edmx.indexOf(target) + 400);
        expect(block).toMatch(/ParameterDefaultValue/);
        expect(block).toContain(`<Path>in/${p}</Path>`);
      }
      expect(edmx).toMatch(new RegExp(`<Property Name="ownerRequestsPerMinuteText"[^>]*>`));
    }
  });

  it('the users-app metadata measures every spend field in sapCostCurrency', async () => {
    const edmx = (await GET(`${S}/$metadata`, ADMIN)).data as string;
    const measured: Record<string, string> = {
      usedSpendDay: 'sapCostCurrency', usedSpendWeek: 'sapCostCurrency', usedSpendMonth: 'sapCostCurrency',
      effectiveSpendPerDay: 'effectiveSpendPerDayCurrency', effectiveSpendPerWeek: 'effectiveSpendPerWeekCurrency', effectiveSpendPerMonth: 'effectiveSpendPerMonthCurrency'
    };
    for (const [field, currency] of Object.entries(measured)) {
      // cds renders the vocabulary alias ("Measures.ISOCurrency"); the full namespace is accepted too
      const re = new RegExp(`Target="AdminService.Users/${field}"[\\s\\S]{0,400}?Term="(Org.OData.)?Measures(.V1)?.ISOCurrency" Path="${currency}"`);
      expect(edmx).toMatch(re);
    }
    // the editable limits stay plain decimals (see annotations.cds)
    for (const field of ['spendPerDay', 'spendPerWeek', 'spendPerMonth']) {
      expect(edmx).not.toMatch(new RegExp(`Target="AdminService.Users/${field}"[\\s\\S]{0,400}?ISOCurrency`));
    }
  });

  it('the users-app metadata declares a Bullet chart per budget window, bound to a data point with criticality', async () => {
    const edmx = (await GET('/odata/v4/admin/$metadata', ADMIN)).data as string;
    for (const w of ['SpendDay', 'SpendWeek', 'SpendMonth', 'TokensDay', 'TokensWeek', 'TokensMonth']) {
      expect(edmx).toMatch(new RegExp(`Term="(com\\.sap\\.vocabularies\\.)?UI(\\.v1)?\\.Chart" Qualifier="${w}"[\\s\\S]{0,600}?ChartType/Bullet`));
      expect(edmx).toMatch(new RegExp(`Term="(com\\.sap\\.vocabularies\\.)?UI(\\.v1)?\\.DataPoint" Qualifier="${w}"[\\s\\S]{0,600}?Criticality[\\s\\S]{0,60}?criticality${w}`));
    }
  });

  // The charts are an addition, not a replacement: the Usage field group keeps the exact figures
  // (a UI.Chart is not rendered inside a form, and a form is what the Usage section is).
  it('the Usage field group still lists the plain used figures', async () => {
    const edmx = (await GET('/odata/v4/admin/$metadata', ADMIN)).data as string;
    const group = /Term="(?:com\.sap\.vocabularies\.)?UI(?:\.v1)?\.FieldGroup" Qualifier="Usage"[\s\S]*?<\/Annotation>/.exec(edmx);
    expect(group).not.toBeNull();
    for (const field of ['usedTokensDay', 'effectiveTokensPerDay', 'usedSpendDay', 'resetsAtDay']) {
      expect(group![0]).toMatch(new RegExp(`Path="${field}"`));
    }
    // the match really is this one annotation and not the rest of the document
    expect(group![0]).not.toMatch(/quotaProfile_ID/);
  });

  it('setUserConstraints is partial and explicit null falls back to platform', async () => {
    await POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { requestsPerMinute: 12, tokensPerDay: 500 } }, ADMIN);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ requestsPerMinute: 12, tokensPerDay: 500 });
    await POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { tokensPerDay: null } }, ADMIN);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ requestsPerMinute: 12, tokensPerDay: null, limitSourceTokensPerDay: 'unlimited' });
    expect((await ok(POST(`${S}/setUserConstraints`, { email: 'nobody@test.com', constraints: {} }, ADMIN))).status).toBe(404);
    expect((await ok(POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { spendPerDay: -1 } }, ADMIN))).status).toBe(400);
  });

  // `Tokens per Day 100` beside `Tokens per Month 10` is a pair the gateway can never honour, and
  // it used to be stored: only the per-field checks ran. The message names both fields, because
  // which of the two to change is the administrator's decision, not ours.
  const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');

  it('setUserConstraints refuses a window wider than the one above it, and stores nothing', async () => {
    const bad = await ok(POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { tokensPerDay: 100, tokensPerMonth: 10 } }, ADMIN));
    expect(bad.status).toBe(400);
    expect(message(bad)).toContain('tokensPerDay must not exceed tokensPerMonth');
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ tokensPerDay: null, tokensPerMonth: null });
  });

  it('setUserConstraints weighs a one-field edit against the windows already stored', async () => {
    await POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { tokensPerMonth: 10 } }, ADMIN);
    const bad = await ok(POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { tokensPerDay: 100 } }, ADMIN));
    expect(bad.status).toBe(400);
    expect(message(bad)).toContain('tokensPerDay must not exceed tokensPerMonth');
    // The repair is accepted, and so is a day the stored month can carry.
    const okEdit = await POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { tokensPerDay: 5 } }, ADMIN);
    expect(okEdit.status).toBe(200);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ tokensPerDay: 5, tokensPerMonth: 10 });
  });

  it('the draft flow refuses the same pair - in one PATCH, and against the stored row', async () => {
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const both = await ok(PATCH(ud('uq-user@test.com'), { tokensPerDay: 100, tokensPerMonth: 10 }, ADMIN));
    expect(both.status).toBe(400);
    expect(message(both)).toContain('tokensPerDay must not exceed tokensPerMonth');

    // One field at a time, weighed against the active row: the stored month is what the day is
    // measured against.
    await PATCH(ud('uq-user@test.com'), { tokensPerMonth: 10 }, ADMIN);
    await POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN);
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const day = await ok(PATCH(ud('uq-user@test.com'), { tokensPerDay: 100 }, ADMIN));
    expect(day.status).toBe(400);
    expect(message(day)).toContain('tokensPerDay must not exceed tokensPerMonth');
  });

  // The field-by-field PATCHes of one editing session are each weighed against the ACTIVE row, so
  // a pair that only becomes contradictory inside the draft passes them; activation resubmits the
  // whole draft row and is where such a pair is caught. Either way it never reaches the database.
  it('draftActivate refuses a pair the individual PATCHes could not see', async () => {
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    await PATCH(ud('uq-user@test.com'), { tokensPerDay: 100 }, ADMIN);
    await PATCH(ud('uq-user@test.com'), { tokensPerMonth: 10 }, ADMIN);
    const activated = await ok(POST(`${ud('uq-user@test.com')}/AdminService.draftActivate`, {}, ADMIN));
    expect(activated.status).toBe(400);
    expect(message(activated)).toContain('tokensPerDay must not exceed tokensPerMonth');
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ tokensPerDay: null, tokensPerMonth: null });
  });
});

describe('lifecycle and quota reset', () => {
  it('bound deactivate locks credentials and blocks creation; unbound reactivateUser restores', async () => {
    const r = await POST(`${u('uq-user@test.com')}/AdminService.deactivate`, { reason: 'audit finding' }, ADMIN);
    expect(r.data).toMatchObject({ status: 'deactivated', lockedApiKeys: 1, lockedAwsCredentials: 1 });
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ status: 'deactivated', canDeactivate: false, canReactivate: true });
    expect((await ok(POST(`${S}/createApiKey`, { name: 'x', email: 'uq-user@test.com' }, ADMIN))).status).toBe(403);
    expect((await ok(POST(`${S}/deactivateUser`, { email: 'uq-user@test.com', reason: 'again' }, USER))).status).toBe(403);
    const back = await POST(`${S}/reactivateUser`, { email: 'uq-user@test.com' }, ADMIN);
    expect(back.data).toMatchObject({ status: 'active', restoredApiKeys: 1, restoredAwsCredentials: 1 });
    expect((await GET(`${S}/UserCredentials?$filter=email eq 'uq-user@test.com'`, ADMIN)).data.value.every((c: any) => c.isActive && !c.lockedByUserDeactivation)).toBe(true);
  });

  it('resetUserQuotas for two e-mails sets the watermark', async () => {
    const r = await POST(`${S}/resetUserQuotas`, { emails: ['uq-user@test.com', 'nobody@test.com'] }, ADMIN);
    expect(r.data.value ?? r.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'uq-user@test.com', ok: true }),
      expect.objectContaining({ email: 'nobody@test.com', ok: false })
    ]));
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(row.quotaResetAt).toBeTruthy();
    // Immediate zeroing of usage after a reset is a later task's job (the reset deletes the user's
    // buckets); here the watermark lands on the Users row and usage before it still reads until then.
    const bound = await POST(`${u('uq-other@test.com')}/AdminService.resetQuota`, {}, ADMIN);
    expect(bound.data).toMatchObject({ email: 'uq-other@test.com', ok: true });
  });
});

describe('status functions', () => {
  it('userQuotaStatus (admin) and myQuotaStatus (caller) report the same figures; UserQuotaStatus is flat', async () => {
    const admin = (await GET(`${S}/userQuotaStatus(email='uq-user@test.com')`, ADMIN)).data;
    expect(admin).toMatchObject({ email: 'uq-user@test.com', status: 'active', used: { day: { tokens: 400, requests: 1 } }, limitSource: { tokensPerDay: 'unlimited' } });
    const mine = (await GET(`${S}/myQuotaStatus()`, USER)).data;
    expect(mine).toMatchObject({ email: 'uq-user@test.com', used: { day: { tokens: 400 } } });
    expect(mine.toolPolicy).toEqual({ name: 'Default', mode: 'monitor' });
    expect((await ok(GET(`${S}/userQuotaStatus(email='uq-user@test.com')`, USER))).status).toBe(403);
    const flat = (await GET(`${S}/UserQuotaStatus(email='uq-user@test.com')`, ADMIN)).data;
    expect(flat).toMatchObject({ email: 'uq-user@test.com', status: 'active', usedTokensDay: 400, limitSourceTokensPerDay: 'unlimited', sapCostCurrency: 'USD' });
    expect(mine.sapCostCurrency).toBe('USD');
  });

  it('myQuotaStatus carries the caller\'s own figures and their profile NAME, never the platform or profile limits', async () => {
    // profileLimits/platformLimits ride on the internal QuotaStatus for the admin READ path's
    // defaultText only. cds does not prune keys the return type does not model, so a leak here
    // would hand every authenticated user the platform-wide defaults and a shared profile's
    // figures - admin configuration.
    const p = (await POST(`${S}/QuotaProfiles`, { name: `Leak check ${Date.now()}`, tokensPerDay: 1000 }, ADMIN)).data;
    await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, ADMIN);

    const mine = (await GET(`${S}/myQuotaStatus()`, USER)).data;
    expect(mine.quotaProfileName).toBe(p.name);
    expect(mine.limits).toMatchObject({ tokensPerDay: 1000 });
    expect(Object.keys(mine)).not.toContain('profileLimits');
    expect(Object.keys(mine)).not.toContain('platformLimits');
    // the admin-only function still reports the same profile name for that user
    const admin = (await GET(`${S}/userQuotaStatus(email='uq-user@test.com')`, ADMIN)).data;
    expect(admin.quotaProfileName).toBe(p.name);
  });

  it('UserQuotaStatus pages with $top/$skip and reports the total with $count (bounded fan-out, not the silent 500)', async () => {
    const page = await GET(`${S}/UserQuotaStatus?$top=1&$skip=1&$count=true`, ADMIN);
    expect(page.data.value).toHaveLength(1);
    expect(page.data.value[0].email).toBe('uq-user@test.com');
    expect(page.data['@odata.count']).toBe(2);
  });
});

describe('myUsageSummary (the home tiles)', () => {
  it('a user gets this month\'s own figures; an administrator gets every user\'s and the user count', async () => {
    // a second user with usage this month, so the two scopes differ
    await cds.db.run(cds.ql.INSERT.into(KEY_USAGE).entries({ apiKey_ID: 'k-o1', email: 'uq-other@test.com', validFrom: new Date(), validTo: new Date(), provider: 'openai', model: 'm', statusCode: 200, inputTokens: 50, outputTokens: 50, totalTokens: 100, sapCost: 0.05, sapCostCurrency: 'USD', usageSignature: `sig-o-${Date.now()}` }));
    await counters.rebuild(cds.db);

    const mine = (await GET(`${S}/myUsageSummary()`, USER)).data;
    expect(mine).toMatchObject({ scope: 'self', requests: 1, tokens: 400, users: 1, sapCostCurrency: 'USD', otherCurrencies: [] });
    expect(Number(mine.sapCost)).toBeCloseTo(0.25, 4);
    expect(mine.monthStart).toBe(new Date().toISOString().slice(0, 8) + '01');

    const all = (await GET(`${S}/myUsageSummary()`, ADMIN)).data;
    expect(all).toMatchObject({ scope: 'all', requests: 2, tokens: 500, users: 2, sapCostCurrency: 'USD' });
    expect(Number(all.sapCost)).toBeCloseTo(0.3, 4);

    expect((await ok(GET(`${S}/myUsageSummary()`))).status).toBe(401);
  });
});

describe('usageUnits', () => {
  it('lists the models whose usage is counted in cells', async () => {
    await cds.db.run(cds.ql.INSERT.into(KEY_USAGE).entries({ apiKey_ID: 'k-u1', email: 'uq-user@test.com', validFrom: new Date(), validTo: new Date(), provider: 'sap', model: 'sap-rpt-1.6', statusCode: 200, inputTokens: 30, outputTokens: 0, totalTokens: 30, sapCost: 0.01, sapCostCurrency: 'USD', unit: 'cells', usageSignature: `sig-cells-${Date.now()}` }));

    const res = await GET(`${S}/usageUnits()`, USER);
    expect(res.status).toBe(200);
    expect(res.data.value).toEqual([{ model: 'sap-rpt-1.6', unit: 'cells' }]);
  });
});

describe("the owner's user-level limit on a credential", () => {
  it('rides on ApiKeys and AwsCredentials rows as ownerRequestsPerMinuteText, naming its source', async () => {
    // Nothing applies: no own constraint, no profile, no platform default in the test configuration.
    expect((await GET(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)`, USER)).data.ownerRequestsPerMinuteText).toBe('unlimited');
    // An assigned profile is what applies.
    const profile = (await POST(`${S}/QuotaProfiles`, { name: 'RL', requestsPerMinute: 42 }, ADMIN)).data;
    await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: profile.ID }, ADMIN);
    expect((await GET(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)`, USER)).data.ownerRequestsPerMinuteText).toBe('42 (RL profile)');
    expect((await GET(`${S}/AwsCredentials(ID='c-u1',IsActiveEntity=true)`, USER)).data.ownerRequestsPerMinuteText).toBe('42 (RL profile)');
    // The user's own constraint wins over the profile.
    await POST(`${S}/setUserConstraints`, { email: 'uq-user@test.com', constraints: { requestsPerMinute: 12 } }, ADMIN);
    expect((await GET(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)`, USER)).data.ownerRequestsPerMinuteText).toBe('12 (own constraint)');
    // The list carries it for every row of the page, and a key without a Users row says unlimited.
    const page = (await GET(`${S}/ApiKeys?$select=ID,ownerRequestsPerMinuteText`, ADMIN)).data.value;
    expect(page.find((r: any) => r.ID === 'k-u1').ownerRequestsPerMinuteText).toBe('12 (own constraint)');
    expect(page.find((r: any) => r.ID === 'k-o1').ownerRequestsPerMinuteText).toBe('unlimited');
  });
});

describe('setRateLimits', () => {
  it('owner or admin may set; another user may not; validation returns the stored values', async () => {
    const mine = await POST(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 }, USER);
    expect(mine.data).toMatchObject({ requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 });
    expect((await ok(POST(`${S}/ApiKeys(ID='k-o1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 5 }, USER))).status).toBe(403);
    const byAdmin = await POST(`${S}/ApiKeys(ID='k-o1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 9 }, ADMIN);
    expect(byAdmin.data).toMatchObject({ requestsPerMinute: 9, requestsPerHour: null, requestsPerDay: null });
    expect((await ok(POST(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 0 }, USER))).status).toBe(400);
    const aws = await POST(`${S}/AwsCredentials(ID='c-u1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 3 }, USER);
    expect(aws.data).toMatchObject({ requestsPerMinute: 3 });
    expect((await GET(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)`, USER)).data).toMatchObject({ requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 });

    const { token } = await validationService.createUnifiedValidationToken({ data: { authType: 'api_key', identifier: 'sk-u1', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' } });
    const v = await validationService.validateUnifiedAuthByToken({ data: { token } });
    expect(v.data.rateLimits).toEqual({ requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 });
  });

  it('an explicit null clears one limit; the other stored limits and an absent field are left unchanged', async () => {
    await POST(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 }, USER);
    const cleared = await POST(`${S}/ApiKeys(ID='k-u1',IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerHour: null }, USER);
    expect(cleared.data).toMatchObject({ requestsPerMinute: 5, requestsPerHour: null, requestsPerDay: 500 });

    const { token } = await validationService.createUnifiedValidationToken({ data: { authType: 'api_key', identifier: 'sk-u1', clientIp: '127.0.0.1', method: 'POST', endpoint: '/v1/messages' } });
    const v = await validationService.validateUnifiedAuthByToken({ data: { token } });
    expect(v.data.rateLimits).toEqual({ requestsPerMinute: 5, requestsPerHour: null, requestsPerDay: 500 });
  });
});

describe('usage buckets: reset, rebuild action, credential deletion', () => {
  const buckets = (email: string) => cds.db.run(cds.ql.SELECT.from(counters.BUCKETS).where({ email }));

  it('a quota reset deletes the user\'s buckets and the figures read zero', async () => {
    expect(await buckets('uq-user@test.com')).toHaveLength(1);
    const res = await POST(`${S}/resetUserQuotas`, { emails: ['uq-user@test.com'] }, ADMIN);
    expect(res.data.value[0]).toMatchObject({ email: 'uq-user@test.com', ok: true });
    expect(await buckets('uq-user@test.com')).toHaveLength(0);
    const row = (await GET(u('uq-user@test.com'), ADMIN)).data;
    expect(row).toMatchObject({ usedTokensDay: 0, usedTokensMonth: 0 });
  });

  it('rebuildUsageCounters is admin-only, restores buckets from the rows and answers per e-mail', async () => {
    expect((await ok(POST(`${S}/rebuildUsageCounters`, { emails: [] }, USER))).status).toBe(403);
    await cds.db.run(cds.ql.DELETE.from(counters.BUCKETS));
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay).toBe(0);
    const one = await POST(`${S}/rebuildUsageCounters`, { emails: ['uq-user@test.com', 'uq-other@test.com'] }, ADMIN);
    expect(one.data.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'uq-user@test.com', ok: true, buckets: 1 }),
      expect.objectContaining({ email: 'uq-other@test.com', ok: true, buckets: 0 })
    ]));
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay).toBe(400);
    await cds.db.run(cds.ql.DELETE.from(counters.BUCKETS));
    const all = await POST(`${S}/rebuildUsageCounters`, { emails: [] }, ADMIN);
    expect(all.data.value).toEqual([expect.objectContaining({ email: '*', ok: true })]);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay).toBe(400);
  });

  it('deleting an AWS credential keeps its usage rows, detached from the credential', async () => {
    await cds.db.run(cds.ql.INSERT.into(AWS_USAGE).entries({ credential_ID: 'c-u1', userId: 'uq-user@test.com', validFrom: new Date(), validTo: new Date(), provider: 'aws-bedrock', modelId: 'm', statusCode: 200, inputTokens: 5, outputTokens: 0, sapCost: 0.01, sapCostCurrency: 'USD', usageSignature: `sig-aws-${Date.now()}` }));
    await counters.rebuild(cds.db);
    const before = (await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay;
    expect(before).toBe(405);
    const res = await ok(POST(`${S}/AwsCredentials(ID='c-u1',IsActiveEntity=true)/AdminService.deleteAwsCredentials`, {}, ADMIN));
    expect(res.status).toBeLessThan(300);
    const rows = await cds.db.run(cds.ql.SELECT.from(AWS_USAGE).columns('credential_ID', 'userId'));
    expect(rows).toEqual([{ credential_ID: null, userId: 'uq-user@test.com' }]);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay).toBe(405);
  });

  // Regression for the root-transaction deadlock: processUsageEvents' handler reads the
  // credentials in the request's own ambient transaction and only then persists. A cds.tx(fn)
  // there always opens an independent root transaction (lib/srv/srv-tx.js), which deadlocks the
  // admin's single SQLite connection against the one this request already holds — the whole
  // service stays wedged, not just this call. db.run(fn) joins the ambient transaction instead.
  it('processUsageEvents persists through the request transaction and moves the buckets', async () => {
    // The processor only persists when model data is available, and it must find the model's
    // price in ModelCosts: an uncached model sends modelCostService to the gateway, which is not
    // running here (and whose own key lookup opens a root transaction of its own).
    const { modelCostService } = require('../../../src/services/modelCostService');
    modelCostService.hasModelData = true;
    modelCostService.modelProviderMap.set('m', 'anthropic');
    await cds.db.run(cds.ql.DELETE.from(COSTS));
    await cds.db.run(cds.ql.INSERT.into(COSTS).entries({ model: 'm', provider: 'anthropic', inputCost: 0.001, outputCost: 0.002, dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '9999-12-31T23:59:59.999Z' }));
    const before = (await cds.db.run(cds.ql.SELECT.from(KEY_USAGE))).length;
    const r = await POST(`${S}/processUsageEvents`, { events: [{
      requestId: `rq-${Date.now()}`, timestamp: Math.floor(Date.now() / 1000), authType: 'api_key',
      credentialId: 'k-u1', provider: 'anthropic', model: 'm',
      inputTokens: 5, outputTokens: 0, responseTime: 1, statusCode: 200
    }] }, ADMIN);
    expect(r.data).toMatchObject({ processed: 1, status: 'success' });
    expect(await cds.db.run(cds.ql.SELECT.from(KEY_USAGE))).toHaveLength(before + 1);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.usedTokensDay).toBe(405);
  });
});

describe('toolUsageDaily navigation', () => {
  it('GET /Users(email)/toolUsageDaily returns the daily aggregates for that user', async () => {
    const TOOL_USAGE_DAILY = 'sap.llm.gateway.admin.ToolUsageDaily';
    const today = new Date().toISOString().slice(0, 10);
    await cds.db.run(cds.ql.INSERT.into(TOOL_USAGE_DAILY).entries([
      { email: 'uq-user@test.com', day: today, identity: 'function:x', facet: 'declared', requests: 3, allowed: 3, lastSeen: new Date().toISOString() },
      { email: 'uq-other@test.com', day: today, identity: 'function:y', facet: 'declared', requests: 1, allowed: 1, lastSeen: new Date().toISOString() }
    ]));
    const res = await GET(`${u('uq-user@test.com')}/toolUsageDaily`, ADMIN);
    expect(res.status).toBe(200);
    expect(res.data.value).toEqual([expect.objectContaining({ email: 'uq-user@test.com', identity: 'function:x', facet: 'declared', requests: 3, allowed: 3 })]);
  });
});
