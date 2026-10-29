/**
 * The cockpit theme as a per-user preference: updateUserPreference accepts exactly the shell's
 * theme choices (Light, Dark, System) and refuses anything else with 400, like the language;
 * getCurrentUserPreferences returns the stored value (sap_horizon for a new user). Boots the real
 * AdminService via cds.test() on in-memory SQLite with mocked users. Runs bare — never touches
 * db/admin.db or :4004.
 */
import path from 'path';
import { SUPPORTED } from '../../../app/shell/webapp/model/theme';
import { COCKPIT_THEMES } from '../../../src/srv/cockpit-themes';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'theme-user@test.com': { id: 'theme-user@test.com', roles: ['user'] },
    'theme-fresh@test.com': { id: 'theme-fresh@test.com', roles: ['user'] }
  }
};

const { POST } = cds.test(path.resolve(__dirname, '../../..'));

const USER = { auth: { username: 'theme-user@test.com', password: 'x' } };
const FRESH = { auth: { username: 'theme-fresh@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);

const getPrefs = async (who: any) => (await POST('/odata/v4/admin/getCurrentUserPreferences', {}, who)).data;
const setTheme = (value: any, who: any = USER) =>
  ok(POST('/odata/v4/admin/updateUserPreference', { key: 'theme', value }, who));

beforeAll(async () => {
  await getPrefs(USER);   // creates the preferences row
});

describe('theme preference', () => {
  it('is Light (sap_horizon) for a new user', async () => {
    expect((await getPrefs(FRESH)).theme).toBe('sap_horizon');
  });

  it.each(['sap_horizon_dark', 'system', 'sap_horizon'])('accepts %p and returns it', async (choice) => {
    const res = await setTheme(choice);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect((await getPrefs(USER)).theme).toBe(choice);
  });

  it.each(['sap_fiori_3', 'sap_quartz_light', 'sap_quartz_dark', 'dark', 'SYSTEM', '', 'sap_horizon '])(
    'refuses %p with 400 and keeps the stored value', async (value) => {
      expect((await setTheme('sap_horizon_dark')).status).toBe(200);
      const res = await setTheme(value);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.data)).toContain('Unsupported theme');
      expect((await getPrefs(USER)).theme).toBe('sap_horizon_dark');
    });

  it('refuses a missing value with 400', async () => {
    const res = await ok(POST('/odata/v4/admin/updateUserPreference', { key: 'theme' }, USER));
    expect(res.status).toBe(400);
  });
});

describe('the server and the shell offer the same themes', () => {
  it('COCKPIT_THEMES equals the shell SUPPORTED list', () => {
    expect([...COCKPIT_THEMES].sort()).toEqual([...SUPPORTED].sort());
  });
});
