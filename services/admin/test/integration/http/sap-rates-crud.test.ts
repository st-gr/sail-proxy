/**
 * HTTP integration test for the SapCapacityRates / SapCapacityUnitPrice admin
 * maintenance surface (Task 12).
 *
 * Unlike the sibling *-http.test.ts files in this folder, this suite does NOT
 * use describeLive/getAdminServiceUrl: those tests fire HTTP requests at a
 * developer's already-running admin instance (localhost:4004) and only run
 * when ADMIN_SERVICE_URL is set (see @libs/test-utils describeLive) - exactly
 * what we must never do locally (see project practice: never set
 * ADMIN_SERVICE_URL). Instead this suite boots the real AdminService via
 * cds.test() against an in-memory sqlite database, so it is a genuine,
 * self-contained HTTP round-trip that runs under a bare `jest` invocation.
 *
 * Both entities are @odata.draft.enabled, so writes go through the OData V4
 * draft flow: POST creates a draft (IsActiveEntity=false), then
 * .../draftActivate persists it to the active base table via the
 * on('CREATE'/'UPDATE'/'DELETE') redirects in admin-service.ts. Edits reopen
 * the active row with .../draftEdit. The createActive/patchActive helpers below
 * wrap that dance so each test reads as the CRUD operation it exercises.
 */
import path from 'path';

// Makes @sap/cds's service-implementation lookup (lib/srv/factory.js) consider the .ts
// sibling of admin-service.cds, not just .js - without this, CAP silently falls back to
// the generic CRUD service and admin-service.ts's `service.on('CREATE'/'UPDATE'/'DELETE', ...)`
// handlers (including the base-table redirects this suite exercises) never run.
process.env.CDS_TYPESCRIPT = 'true';

const cds = require('@sap/cds');

// Force an isolated in-memory database for this suite. Without this, cds.test()'s
// implicit '--in-memory?' flag is a no-op whenever cds.requires.db is already
// configured (as it is here, pointing at the real db/admin.db file) - so this
// explicit override is what keeps the suite from writing test rows into a
// developer's real admin database.
cds.env.requires.db = {
  kind: 'sqlite',
  impl: '@cap-js/sqlite',
  credentials: { url: ':memory:' }
};

// Deterministic mock users for this suite, independent of the [development]-profile
// mock users in package.json (which don't apply under NODE_ENV=test anyway).
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'sap-rates-admin@test.com': { id: 'sap-rates-admin@test.com', roles: ['admin', 'user'] },
    'sap-rates-user@test.com': { id: 'sap-rates-user@test.com', roles: ['user'] }
  }
};

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN_AUTH = { auth: { username: 'sap-rates-admin@test.com', password: 'x' } };
const USER_AUTH = { auth: { username: 'sap-rates-user@test.com', password: 'x' } };

const PRICES_PATH = '/odata/v4/admin/SapCapacityUnitPrice';

const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

// Create a draft, activate it, and return the now-active row's ID.
async function createActive(basePath: string, body: any, auth: any): Promise<string> {
  const draft = await POST(basePath, body, auth);
  const id = draft.data.ID;
  await POST(`${basePath}(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`, {}, auth);
  return id;
}

// Reopen an active row for edit, PATCH the given fields onto its draft, and activate.
// Returns the activation response so the caller can assert on its status.
async function patchActive(basePath: string, id: string, patch: any, auth: any): Promise<any> {
  await POST(`${basePath}(ID=${id},IsActiveEntity=true)/AdminService.draftEdit`, { PreserveChanges: true }, auth);
  await PATCH(`${basePath}(ID=${id},IsActiveEntity=false)`, patch, auth);
  return POST(`${basePath}(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`, {}, auth);
}

describe('AdminService: SapCapacityUnitPrice CRUD (Task 12)', () => {
  describe('SapCapacityUnitPrice', () => {
    // usageType is now an @assert.range enum { productive | non-productive }, so tests use the
    // real values and isolate by clearing the table between cases (active rows + any leftover
    // never-activated drafts) instead of by unique synthetic usageType keys.
    const usageType = 'productive';

    beforeEach(async () => {
      await cds.db.run(cds.ql.DELETE.from('sap.llm.gateway.admin.SapCapacityUnitPrice'));
      // A failed draftActivate (the 409 case) leaves a never-activated draft; clear it so it
      // can't leak into another test's collection query. Draft table shape can vary by CAP
      // version, so guard it - the active-row clear above is the primary isolation.
      try {
        await cds.db.run(cds.ql.DELETE.from('AdminService.SapCapacityUnitPrice.drafts'));
      } catch {
        /* no separate draft table in this CAP version */
      }
    });

    it('rejects an unauthenticated caller', async () => {
      await expect(GET(PRICES_PATH)).rejects.toMatchObject({
        response: { status: 401 }
      });
    });

    it('rejects a caller without the admin role', async () => {
      await expect(
        POST(PRICES_PATH, {
          usageType,
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: OPEN_ENDED,
          pricePerCu: 10
        }, USER_AUTH)
      ).rejects.toMatchObject({
        response: { status: 403 }
      });
    });

    it('lets an authorized admin create and then list a price row', async () => {
      await createActive(PRICES_PATH, {
        usageType,
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: OPEN_ENDED,
        pricePerCu: 12.5,
        currency: 'USD'
      }, ADMIN_AUTH);

      const listed = await GET(`${PRICES_PATH}?$filter=usageType eq '${usageType}'`, ADMIN_AUTH);

      expect(listed.status).toBe(200);
      expect(listed.data.value).toHaveLength(1);
      expect(listed.data.value[0].pricePerCu).toBeCloseTo(12.5, 6);
    });

    it('auto-delimits the previous open price when a newer one supersedes it', async () => {
      const usage = 'non-productive';
      await createActive(PRICES_PATH, {
        usageType: usage,
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: OPEN_ENDED,
        pricePerCu: 10,
        currency: 'USD'
      }, ADMIN_AUTH);

      // A newer row valid from 2026-03-01: its dateTo is forced to the end of time and the
      // 2026-01-01 row is auto-closed just before it - no overlap, no rejection. The dateTo
      // sent here (2027) must be overridden to end-of-time.
      await createActive(PRICES_PATH, {
        usageType: usage,
        dateFrom: '2026-03-01T00:00:00.000Z',
        dateTo: '2027-01-01T00:00:00.000Z',
        pricePerCu: 11,
        currency: 'USD'
      }, ADMIN_AUTH);

      const after = await GET(`${PRICES_PATH}?$filter=usageType eq '${usage}'&$orderby=dateFrom`, ADMIN_AUTH);
      expect(after.data.value).toHaveLength(2);
      const [older, newer] = after.data.value;
      // The older row is delimited to just before the newer one starts (no overlap, no gap),
      // still after its own start.
      expect(new Date(older.dateTo).getTime()).toBeLessThan(new Date(newer.dateFrom).getTime());
      expect(new Date(older.dateTo).getTime()).toBeGreaterThan(new Date(older.dateFrom).getTime());
      // The newer row always runs to the end of time, regardless of the dateTo sent.
      expect(newer.dateFrom).toContain('2026-03-01');
      expect(newer.dateTo).toContain('9999-12-31');
    });

    it('rejects a create that starts at or before an existing price for the same usage type', async () => {
      const usage = 'productive';
      await createActive(PRICES_PATH, {
        usageType: usage,
        dateFrom: '2026-06-01T00:00:00.000Z',
        dateTo: OPEN_ENDED,
        pricePerCu: 10,
        currency: 'USD'
      }, ADMIN_AUTH);

      // A record starting BEFORE an existing one can't be resolved by supersession -> 409.
      await expect(
        createActive(PRICES_PATH, {
          usageType: usage,
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: OPEN_ENDED,
          pricePerCu: 11,
          currency: 'USD'
        }, ADMIN_AUTH)
      ).rejects.toMatchObject({ response: { status: 409 } });
    });

    it('lets an authorized admin PATCH a non-key field, and the change lands on the base table (not just the view)', async () => {
      const patchUsageType = 'productive';
      const id = await createActive(PRICES_PATH, {
        usageType: patchUsageType,
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: OPEN_ENDED,
        pricePerCu: 10,
        currency: 'USD'
      }, ADMIN_AUTH);

      const patched = await patchActive(PRICES_PATH, id, {
        pricePerCu: 15.75,
        currency: 'EUR'
      }, ADMIN_AUTH);
      expect([200, 201]).toContain(patched.status);

      const after = await GET(`${PRICES_PATH}(ID=${id},IsActiveEntity=true)`, ADMIN_AUTH);
      expect(after.data.pricePerCu).toBeCloseTo(15.75, 6);
      expect(after.data.currency).toBe('EUR');
    });

    it('lets an authorized admin DELETE a row', async () => {
      const deleteUsageType = 'productive';
      const id = await createActive(PRICES_PATH, {
        usageType: deleteUsageType,
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: OPEN_ENDED,
        pricePerCu: 10,
        currency: 'USD'
      }, ADMIN_AUTH);

      const deleted = await DELETE(`${PRICES_PATH}(ID=${id},IsActiveEntity=true)`, ADMIN_AUTH);
      expect([200, 204]).toContain(deleted.status);

      const after = await GET(`${PRICES_PATH}?$filter=usageType eq '${deleteUsageType}'`, ADMIN_AUTH);
      expect(after.data.value).toHaveLength(0);
    });

    it('re-extends the delimited predecessor to end of time when the open row is deleted', async () => {
      const usage = 'productive';
      const olderId = await createActive(PRICES_PATH, {
        usageType: usage, dateFrom: '2026-01-01T00:00:00.000Z', dateTo: OPEN_ENDED, pricePerCu: 10, currency: 'USD'
      }, ADMIN_AUTH);
      const newerId = await createActive(PRICES_PATH, {
        usageType: usage, dateFrom: '2026-03-01T00:00:00.000Z', dateTo: OPEN_ENDED, pricePerCu: 11, currency: 'USD'
      }, ADMIN_AUTH);

      // Creating the newer row delimited the older one to just before 2026-03-01.
      let older = await GET(`${PRICES_PATH}(ID=${olderId},IsActiveEntity=true)`, ADMIN_AUTH);
      expect(older.data.dateTo).not.toContain('9999-12-31');

      // Deleting the newer (open) row re-extends the older one back to the end of time.
      const deleted = await DELETE(`${PRICES_PATH}(ID=${newerId},IsActiveEntity=true)`, ADMIN_AUTH);
      expect([200, 204]).toContain(deleted.status);

      older = await GET(`${PRICES_PATH}(ID=${olderId},IsActiveEntity=true)`, ADMIN_AUTH);
      expect(older.data.dateTo).toContain('9999-12-31');
    });

    it('leaves a historical (non-open) row untouched on delete', async () => {
      const usage = 'non-productive';
      // older historical window, then a current open row
      const olderId = await createActive(PRICES_PATH, {
        usageType: usage, dateFrom: '2026-01-01T00:00:00.000Z', dateTo: OPEN_ENDED, pricePerCu: 10, currency: 'USD'
      }, ADMIN_AUTH);
      await createActive(PRICES_PATH, {
        usageType: usage, dateFrom: '2026-03-01T00:00:00.000Z', dateTo: OPEN_ENDED, pricePerCu: 11, currency: 'USD'
      }, ADMIN_AUTH);

      // Delete the older (now delimited, non-open) row: the open row must NOT be altered.
      await DELETE(`${PRICES_PATH}(ID=${olderId},IsActiveEntity=true)`, ADMIN_AUTH);

      const remaining = await GET(`${PRICES_PATH}?$filter=usageType eq '${usage}'`, ADMIN_AUTH);
      expect(remaining.data.value).toHaveLength(1);
      expect(remaining.data.value[0].dateTo).toContain('9999-12-31'); // the open row is unchanged
      expect(remaining.data.value[0].dateFrom).toContain('2026-03-01');
    });

    it('prefills a new draft Valid To with the end of time (9999-12-31)', async () => {
      // The create form should show Valid To defaulted so the admin need not type it; the NEW
      // draft handler sets it, and CREATE forces the same value on activation.
      const draft = await POST(PRICES_PATH, {
        usageType: 'productive',
        dateFrom: '2026-01-01T00:00:00.000Z',
        pricePerCu: 10,
        currency: 'USD'
      }, ADMIN_AUTH);
      expect(draft.data.dateTo).toContain('9999-12-31');
    });

    it('rejects a usageType outside the allowed enum (productive | non-productive)', async () => {
      // Free-typed values silently break price matching (nothing looks up 'sandbox'); the
      // @assert.range enum makes CAP reject them at activation, closing the direct-OData hole.
      await expect(
        createActive(PRICES_PATH, {
          usageType: 'sandbox',
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: OPEN_ENDED,
          pricePerCu: 10,
          currency: 'USD'
        }, ADMIN_AUTH)
      ).rejects.toMatchObject({ response: { status: 400 } });
    });

    it('rejects a servicePlan outside the allowed enum (standard | extended)', async () => {
      await expect(
        createActive(PRICES_PATH, {
          usageType: 'productive',
          servicePlan: 'premium',
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: OPEN_ENDED,
          pricePerCu: 10,
          currency: 'USD'
        }, ADMIN_AUTH)
      ).rejects.toMatchObject({ response: { status: 400 } });
    });
  });
});
