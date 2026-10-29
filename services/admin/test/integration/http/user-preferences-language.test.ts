/**
 * The cockpit language as a per-user preference: updateUserPreference accepts only the cockpit
 * languages ('' = browser default) and getCurrentUserPreferences returns the stored value (null
 * when the user never chose one). Boots the real AdminService via cds.test() on in-memory SQLite
 * with mocked users (same pattern as model-library-odata.test.ts). Runs bare — never touches
 * db/admin.db or :4004.
 */
import path from 'path';
import { SUPPORTED } from '../../../app/shell/webapp/model/language';
import { COCKPIT_LANGUAGES } from '../../../src/srv/cockpit-languages';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'lang-user@test.com': { id: 'lang-user@test.com', roles: ['user'] },
    'lang-fresh@test.com': { id: 'lang-fresh@test.com', roles: ['user'] },
    'lang-norow@test.com': { id: 'lang-norow@test.com', roles: ['user'] }
  }
};

const { POST } = cds.test(path.resolve(__dirname, '../../..'));

const USER = { auth: { username: 'lang-user@test.com', password: 'x' } };
const FRESH = { auth: { username: 'lang-fresh@test.com', password: 'x' } };
const NOROW = { auth: { username: 'lang-norow@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);

const getPrefs = async (who: any) => (await POST('/odata/v4/admin/getCurrentUserPreferences', {}, who)).data;
const setLanguage = (value: any, who: any = USER) =>
  ok(POST('/odata/v4/admin/updateUserPreference', { key: 'language', value }, who));

beforeAll(async () => {
  await getPrefs(USER);   // creates the preferences row
});

describe('language preference', () => {
  it('is null for a user who never chose one', async () => {
    const prefs = await getPrefs(FRESH);
    expect(prefs.language).toBeNull();
  });

  it.each(['', 'en', 'de', 'es', 'fr', 'it', 'nl', 'pt'])('accepts %p and returns it', async (code) => {
    const res = await setLanguage(code);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const prefs = await getPrefs(USER);
    expect(prefs.language).toBe(code);
  });

  it.each(['xx', 'DE ', 'en-US', 'DE', 'ja'])('refuses %p with 400 and keeps the stored value', async (code) => {
    expect((await setLanguage('de')).status).toBe(200);
    const res = await setLanguage(code);
    expect(res.status).toBe(400);
    expect((await getPrefs(USER)).language).toBe('de');
  });

  it('refuses a missing value with 400', async () => {
    const res = await ok(POST('/odata/v4/admin/updateUserPreference', { key: 'language' }, USER));
    expect(res.status).toBe(400);
  });

  it('leaves the other preferences working', async () => {
    const res = await ok(POST('/odata/v4/admin/updateUserPreference', { key: 'sidePanelCollapsed', value: 'true' }, USER));
    expect(res.status).toBe(200);
    expect((await getPrefs(USER)).sidePanelCollapsed).toBe(true);
  });
});

describe('updateUserPreference keeps its error statuses', () => {
  const update = (key: any, value: any, who: any = USER) =>
    ok(POST('/odata/v4/admin/updateUserPreference', { key, value }, who));

  it('an unknown preference key is a 400, not a 500', async () => {
    const res = await update('noSuchPreference', 'x');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain('Invalid preference key');
  });

  it('a user without a preferences row gets 404, not 500', async () => {
    const res = await update('sidePanelCollapsed', 'true', NOROW);
    expect(res.status).toBe(404);
  });

  it('a genuine database failure is still a 500', async () => {
    const original = cds.run.bind(cds);
    const spy = jest.spyOn(cds, 'run').mockImplementation((q: any, ...rest: any[]) => {
      if (q && q.UPDATE) return Promise.reject(new Error('disk full'));
      return original(q, ...rest);
    });
    try {
      const res = await update('sidePanelCollapsed', 'false');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.data)).toContain('Failed to update user preference');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the server and the shell offer the same languages', () => {
  it('COCKPIT_LANGUAGES equals the shell SUPPORTED list', () => {
    expect([...COCKPIT_LANGUAGES].sort()).toEqual([...SUPPORTED].sort());
  });
});
