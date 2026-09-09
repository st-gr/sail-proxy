/**
 * The Cost section shows SAP's capacity-unit figure (per 1M tokens: cost per 1K × 1000 × cuFactor,
 * five decimals — 0.00079 → 1.50404 at 1.90385, captured from SAP's page) and, in brackets, the
 * operands, so the admin sees where the number comes from. "Your price" appears only when the
 * current ModelCosts row is manual.
 */
import { capacityUnitsPerMillion, operandsBracket, costRows } from '../webapp/model/costDisplay';

describe('capacityUnitsPerMillion', () => {
  it('reproduces the captured SAP figure', () => { expect(capacityUnitsPerMillion('0.00079', 1.90385)).toBe('1.50404'); });
  it('is null without a cost', () => { expect(capacityUnitsPerMillion(null, 1.9)).toBeNull(); expect(capacityUnitsPerMillion('', 1.9)).toBeNull(); });
});

describe('operandsBracket', () => {
  it('shows the stored per-1K cost and the factor', () => { expect(operandsBracket('0.00079', 1.90385)).toBe('(0.00079 per 1K × 1.90385)'); });
});

describe('costRows', () => {
  const model = { sapInputCost: '0.00079', sapOutputCost: '0.00367', sapCacheReadCost: '0.00008', sapCacheCreationCost: null };
  it('lists the directions that have a SAP price, labelled like SAP AI Launchpad', () => {
    const rows = costRows(model, null, 1.90385);
    expect(rows.map(r => r.label)).toEqual(['Input Token Cost Factor', 'Output Token Cost Factor', 'Cache Read Cost Factor']);
    expect(rows[0]).toEqual({ label: 'Input Token Cost Factor', key: 'input', value: '1.50404', bracket: '(0.00079 per 1K × 1.90385)', factor: '0.00079' });
  });
  it('shows the manual price (and its raw factor) when the current row is manual', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.001', outputCost: '0.002', cacheReadInputCost: null, cacheCreationInputCost: null }, 1.90385);
    expect(rows[0].value).toBe('1.90385');          // 0.001 × 1000 × 1.90385
    expect(rows[0].factor).toBe('0.001');
    expect(rows[2]).toEqual({ label: 'Cache Read Cost Factor', key: 'cacheRead', value: '0.15231', bracket: '(0.00008 per 1K × 1.90385)', factor: '0.00008' });
  });
});
