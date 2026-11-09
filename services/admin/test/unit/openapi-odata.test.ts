/**
 * openapi/admin-odata.json is generated from the CDS model (pnpm --filter admin openapi).
 * These tests fail when the committed copy is stale or invalid.
 */
import * as fs from 'fs';
import { loadOpenApi } from '@sap-llm-gateway/test-utils';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateAdminOpenApi, OUTPUT } = require('../../scripts/generate-openapi');

describe('admin OData OpenAPI document', () => {
  it('committed admin-odata.json equals a fresh generation', async () => {
    const committed = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    const fresh = JSON.parse(JSON.stringify(await generateAdminOpenApi()));
    if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
      throw new Error('openapi/admin-odata.json is stale: run `pnpm --filter admin openapi` and commit the result');
    }
    expect(committed).toEqual(fresh);
  });

  it('the document validates', async () => {
    const doc = await loadOpenApi(OUTPUT);
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(100);
    expect(doc.servers?.[0]?.url).toBe('/admin/odata/v4/admin');
  });

  it('ValidationService paths are absent', async () => {
    const doc = await loadOpenApi(OUTPUT);
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).not.toContain('/createUnifiedValidationToken');
    expect(paths).not.toContain('/validateUnifiedAuthByToken');
    expect(JSON.stringify(doc)).not.toContain('ValidationService');
  });

  it('AdminService actions are present', async () => {
    const doc = await loadOpenApi(OUTPUT);
    expect(doc.paths).toHaveProperty(['/validateApiKey', 'post']);
  });
});
