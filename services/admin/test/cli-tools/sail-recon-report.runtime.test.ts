export {}; // make this a TS module so top-level consts don't share global scope (avoids TS2451 across test files)
const rep = require('../../../../cli-tools/sail-recon-report.js');

describe('sail-recon-report runtime (pure)', () => {
  it('sumQuery filters by key name and month and aliases every captured field', () => {
    const q = rep.sumQuery('reconciliation', '2026-09');
    expect(q).toContain("keyName = 'reconciliation'");
    expect(q).toContain("strftime('%Y-%m', validFrom) = '2026-09'");
    expect(q).toContain('totalCacheReadInputTokens');
    expect(q).toContain('sap_llm_gateway_admin_ApiKeyUsage');
  });

  it('parseArgs applies defaults and reads flags', () => {
    const a = rep.parseArgs(['--key-name', 'reconciliation', '--month', '2026-09', '--bill', 'bill.json']);
    expect(a).toMatchObject({ db: 'services/admin/db/admin.db', keyName: 'reconciliation', month: '2026-09', bill: 'bill.json' });
    expect(a.runId).toBeTruthy();
  });

  it('renderTable includes a row per metric with the factor', () => {
    const rows = rep.buildReconTable({ totalCacheReadInputTokens: 100 }, { cacheRead: 200 });
    const text = rep.renderTable(rows);
    expect(text).toContain('cacheRead');
    expect(text).toContain('2'); // impliedFactor
  });
});
