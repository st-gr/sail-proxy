/**
 * Quota profiles: the one-shot starter seed and the lookups the status paths read (spec
 * 2026-09-08 §1/§2). In-memory SQLite through cds.test(); no gateway, no Valkey.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as profiles from '../../../src/services/quotaProfilesService';
import * as users from '../../../src/services/usersService';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => { await db.run(cds.ql.DELETE.from(profiles.PROFILES)); await db.run(cds.ql.DELETE.from(users.USERS)); });

describe('ensureStarterProfiles', () => {
  it('seeds Light, Standard and Power once, with the documented figures, and never again', async () => {
    expect(await profiles.ensureStarterProfiles(db)).toBe(3);
    const rows = await db.run(cds.ql.SELECT.from(profiles.PROFILES).orderBy('name'));
    expect(rows.map((r: any) => r.name)).toEqual(['Light', 'Power', 'Standard']);
    const power = rows.find((r: any) => r.name === 'Power');
    expect(power).toMatchObject({ requestsPerMinute: 200, tokensPerDay: 25000000, tokensPerWeek: 100000000, tokensPerMonth: 300000000 });
    expect(Number(power.spendPerDay)).toBe(1500); expect(Number(power.spendPerWeek)).toBe(6000); expect(Number(power.spendPerMonth)).toBe(12000);
    expect(await profiles.ensureStarterProfiles(db)).toBe(0);
    await db.run(cds.ql.DELETE.from(profiles.PROFILES).where({ name: 'Light' }));
    expect(await profiles.ensureStarterProfiles(db)).toBe(0);   // any profile present: nothing is re-seeded
  });
});

describe('lookups', () => {
  it('getProfilesByIds returns the rows keyed by id; assignedEmails lists the users on a profile', async () => {
    await profiles.ensureStarterProfiles(db);
    const [std] = await db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Standard' }));
    await users.touch(db, 'a@test.com', { roles: ['user'] }); await users.touch(db, 'b@test.com', { roles: ['user'] });
    await db.run(cds.ql.UPDATE(users.USERS).set({ quotaProfile_ID: std.ID }).where({ email: 'a@test.com' }));
    expect((await profiles.getProfilesByIds(db, [std.ID, 'missing'])).get(std.ID)?.name).toBe('Standard');
    expect(await profiles.assignedEmails(db, std.ID)).toEqual(['a@test.com']);
  });

  it('getProfile reads one row and is null for an unknown id', async () => {
    await profiles.ensureStarterProfiles(db);
    const [light] = await db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    expect((await profiles.getProfile(db, light.ID))?.name).toBe('Light');
    expect(await profiles.getProfile(db, 'missing')).toBeNull();
  });
});
