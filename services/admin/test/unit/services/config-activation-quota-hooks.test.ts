/**
 * A successful configuration activation must invalidate every user quota state document AND the
 * gateway's cached validations — platform.quotas can change with the rest of the config, and a
 * cached validation answer still carries the old limits for up to an hour otherwise (spec §3 /
 * §7.2 item 3). republishAll()/invalidateQuotaDefaults() were already wired to activation;
 * invalidateForEmails(cds, 'everyone', 'platform_quotas') is the addition under test here.
 * cds.test() boots the real ConfigurationService (config-service.ts's module.exports wires it into
 * AdminService), so activateConfiguration runs for real against an in-memory DB; only the three
 * quota/cache hooks are mocked, so this stays a unit test of the wiring rather than of any of
 * those services' own behaviour (each has its own test file).
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'cah-admin@test.com': { id: 'cah-admin@test.com', roles: ['admin', 'user'] } } };

jest.mock('../../../src/services/quotaLimits', () => ({
  ...jest.requireActual('../../../src/services/quotaLimits'),
  invalidateQuotaDefaults: jest.fn()
}));
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  republishAll: jest.fn(async () => 0)
}));
jest.mock('../../../src/services/credentialInvalidation', () => ({
  ...jest.requireActual('../../../src/services/credentialInvalidation'),
  invalidateForEmails: jest.fn(async () => true)
}));

const { POST } = cds.test(path.resolve(__dirname, '../../..'));
import { invalidateQuotaDefaults } from '../../../src/services/quotaLimits';
import { republishAll } from '../../../src/services/userQuotaService';
import { invalidateForEmails } from '../../../src/services/credentialInvalidation';
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';

const ADMIN = { auth: { username: 'cah-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';

beforeEach(() => {
  (invalidateQuotaDefaults as jest.Mock).mockClear();
  (republishAll as jest.Mock).mockClear();
  (invalidateForEmails as jest.Mock).mockClear();
});

describe('activateConfiguration invalidates quota state and the gateway cache', () => {
  it('a successful activation calls invalidateQuotaDefaults, republishAll and invalidateForEmails(cds, "everyone", "platform_quotas")', async () => {
    const created = await POST(`${S}/createConfiguration`, {
      name: 'quota-hooks-test', configData: JSON.stringify(MINIMAL_DEFAULT_CONFIG), description: 'test'
    }, ADMIN);
    expect(created.data.success).toBe(true);

    const activated = await POST(`${S}/activateConfiguration`, { configId: created.data.configId }, ADMIN);
    expect(activated.data.success).toBe(true);

    expect(invalidateQuotaDefaults).toHaveBeenCalled();
    expect(republishAll).toHaveBeenCalled();
    expect(invalidateForEmails).toHaveBeenCalledWith(expect.anything(), 'everyone', 'platform_quotas');
  });
});
