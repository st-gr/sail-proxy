export {}; // make this a TS module so top-level consts don't share global scope (avoids TS2451 across test files)
const rep = require('../../../../cli-tools/sail-recon-report.js');

describe('sail-recon-report core', () => {
  it('impliedFactor guards divide-by-zero', () => {
    expect(rep.impliedFactor(200, 100)).toBe(2);
    expect(rep.impliedFactor(5, 0)).toBeNull();
  });

  it('buildReconTable pairs captured vs billed and computes factor + delta', () => {
    const captured = { totalInputTokens: 1000, totalCacheReadInputTokens: 300000000, totalImageInputTokens: 2420000 };
    const billed = { input: 1000, cacheRead: 600000000, image: 0 };
    const table = rep.buildReconTable(captured, billed);
    const input = table.find((r: any) => r.metric === 'input');
    expect(input).toMatchObject({ captured: 1000, billed: 1000, impliedFactor: 1, expected: 1, delta: 0 });
    const cacheRead = table.find((r: any) => r.metric === 'cacheRead');
    expect(cacheRead).toMatchObject({ impliedFactor: 2, expected: 2, delta: 0 }); // the ~2x confirmed
    const image = table.find((r: any) => r.metric === 'image');
    expect(image.impliedFactor).toBe(0); // captured>0, billed 0 -> factor 0 (or gap if captured 0)
  });

  it('buildReconTable yields null factor when captured is 0 (image capture gap)', () => {
    const table = rep.buildReconTable({ totalImageInputTokens: 0 }, { image: 2420000 });
    const image = table.find((r: any) => r.metric === 'image');
    expect(image.impliedFactor).toBeNull(); // captured 0 -> factor undefined -> null; the reporter flags the gap
    expect(image.delta).toBeNull();
  });
});
