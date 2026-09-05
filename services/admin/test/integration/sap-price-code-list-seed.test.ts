/**
 * The Prices app Usage Type / Service Plan dropdowns are backed by two code-list entities
 * (SapUsageTypeCodes / SapServicePlanCodes) whose rows load from CSV under src/db/data. This
 * boots the REAL AdminService via cds.test() against in-memory sqlite - the same serve/deploy
 * path dev:ts:mock uses - and asserts the CSV initial data landed WITHOUT any programmatic
 * seed. The values must mirror the usageType/servicePlan @assert.range enums in api-keys.cds.
 */
import path from 'path';

const cds = require('@sap/cds');

cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };

cds.test(path.resolve(__dirname, '../..'));

const USAGE = 'sap.llm.gateway.admin.SapUsageTypeCodes';
const PLAN = 'sap.llm.gateway.admin.SapServicePlanCodes';

describe('SapCapacityUnitPrice value-help code lists (loaded from CSV on deploy)', () => {
  it('populates both code lists from CSV, mirroring the enum values', async () => {
    const { SELECT } = cds.ql;
    const usage = await cds.db.run(SELECT.from(USAGE));
    const plan = await cds.db.run(SELECT.from(PLAN));

    expect(usage.map((r: any) => r.code).sort()).toEqual(['non-productive', 'productive']);
    expect(plan.map((r: any) => r.code).sort()).toEqual(['extended', 'standard']);
    // every entry carries a display name for the dropdown
    expect(usage.every((r: any) => typeof r.name === 'string' && r.name.length > 0)).toBe(true);
    expect(plan.every((r: any) => typeof r.name === 'string' && r.name.length > 0)).toBe(true);
  });
});
