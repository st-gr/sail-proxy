/**
 * External models are opt-in (spec 2026-10-23 §4.3): the default catalog's effective set - all
 * non-absent Library rows minus exclusions - leaves out rows of origin 'external', while an admin
 * catalog may list them.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as ent from '../../../src/services/modelEntitlementService';

const LIB = 'sap.llm.gateway.admin.LibraryModels';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';
const row = (modelId: string, extra: any = {}) => ({ modelId, baseModel: modelId, accessType: 'foundation', absent: false, lastSeenAt: new Date(), ...extra });

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [MEM, EXC, CAT, LIB]) await db.run(DELETE.from(t));
  await db.run(INSERT.into(LIB).entries([
    row('gpt-4o'), row('legacy-null-origin', { origin: null }),
    row('gpt-4o--oa', { origin: 'external', connection: 'oa', accessType: 'external' }),
  ]));
});

describe('the default catalog and external models', () => {
  it('leaves external rows out of the effective set', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    expect([...await ent.effectiveModelIds(db, def)].sort()).toEqual(['gpt-4o', 'legacy-null-origin']);
  });

  it('lets an admin catalog list an external model', async () => {
    const ID = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(CAT).entries({ ID, name: 'Overflow', isDefault: false }));
    await db.run(cds.ql.INSERT.into(MEM).entries({ catalog_ID: ID, modelId: 'gpt-4o--oa' }));
    const catalog = await ent.getCatalog(db, ID);
    expect([...await ent.effectiveModelIds(db, catalog!)]).toEqual(['gpt-4o--oa']);
  });
});
