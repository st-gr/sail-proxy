/**
 * The Cost section shows SAP's capacity-unit figure (per 1M tokens: cost per 1K × 1000 × cuFactor,
 * five decimals — 0.00079 → 1.50404 at 1.90385, captured from SAP's page) and, in brackets, the
 * operands, so the admin sees where the number comes from. "Your price" appears only when the
 * current ModelCosts row is manual.
 */
import { capacityUnitsPerMillion, operandsBracket, costRows, costUnitLabel } from '../webapp/model/costDisplay';

describe('capacityUnitsPerMillion', () => {
  it('reproduces the captured SAP figure', () => { expect(capacityUnitsPerMillion('0.00079', 1.90385)).toBe('1.50404'); });
  it('is null without a cost', () => { expect(capacityUnitsPerMillion(null, 1.9)).toBeNull(); expect(capacityUnitsPerMillion('', 1.9)).toBeNull(); });
});

describe('operandsBracket', () => {
  it('shows the stored per-1K cost and the factor', () => { expect(operandsBracket('0.00079', 1.90385)).toBe('(0.00079 per 1K × 1.90385)'); });
});

describe('costUnitLabel', () => {
  it('labels SAP-RPT cost per 1K cells and everything else per 1K tokens', () => {
    expect(costUnitLabel('sap-rpt-1.6')).toBe('cells');
    expect(costUnitLabel('sap-rpt-1.6-large--deep-context')).toBe('cells');
    expect(costUnitLabel('gpt-4.1-nano')).toBe('tokens');
  });
});

describe('costRows', () => {
  const model = { sapInputCost: '0.00079', sapOutputCost: '0.00367', sapCacheReadCost: '0.00008', sapCacheCreationCost: null };
  it('lists the directions that have a SAP price, labelled like SAP AI Launchpad', () => {
    const rows = costRows(model, null, 1.90385);
    expect(rows.map(r => r.label)).toEqual(['Input Token Cost Factor', 'Output Token Cost Factor', 'Cache Read Cost Factor']);
    expect(rows[0]).toEqual({ label: 'Input Token Cost Factor', key: 'input', value: '1.50404', bracket: '(0.00079 per 1K × 1.90385)', factor: '0.00079' });
  });
  it('shows the manual price (and its raw factor) when the current row is manual', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.001', outputCost: '0.002', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: null, audioInputCost: null, audioOutputCost: null }, 1.90385);
    expect(rows[0].value).toBe('1.90385');          // 0.001 × 1000 × 1.90385
    expect(rows[0].factor).toBe('0.001');
    expect(rows[2]).toEqual({ label: 'Cache Read Cost Factor', key: 'cacheRead', value: '0.15231', bracket: '(0.00008 per 1K × 1.90385)', factor: '0.00008' });
  });

  it('shows an Image Output Cost Factor row when the manual price carries one', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.001', outputCost: '0.002', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: '0.06', audioInputCost: null, audioOutputCost: null }, 1.90385);
    const row = rows.find(r => r.key === 'imageOutput');
    expect(row).toEqual({ label: 'Image Output Cost Factor', key: 'imageOutput', value: '114.23100', bracket: '(0.06 per 1K × 1.90385)', factor: '0.06' });
  });

  it('has no Image Output Cost Factor row without one', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.001', outputCost: '0.002', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: null, audioInputCost: null, audioOutputCost: null }, 1.90385);
    expect(rows.find(r => r.key === 'imageOutput')).toBeUndefined();
  });

  it('shows the two audio cost factor rows when the manual price carries them', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.00251', outputCost: '0.00981', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: null, audioInputCost: '0.01954', audioOutputCost: '0.03901' }, 1.90385);
    expect(rows.find(r => r.key === 'audioInput')).toMatchObject({ label: 'Audio Input Cost Factor', factor: '0.01954' });
    expect(rows.find(r => r.key === 'audioOutput')).toMatchObject({ label: 'Audio Output Cost Factor', factor: '0.03901' });
  });
  it('has no audio rows without them', () => {
    const rows = costRows(model, { source: 'manual', inputCost: '0.001', outputCost: '0.002', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: null, audioInputCost: null, audioOutputCost: null }, 1.90385);
    expect(rows.find(r => r.key === 'audioInput')).toBeUndefined();
    expect(rows.find(r => r.key === 'audioOutput')).toBeUndefined();
  });
});
