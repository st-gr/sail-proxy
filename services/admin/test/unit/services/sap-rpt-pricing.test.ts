/**
 * SAP-RPT usage arrives as cells in the token fields with unit 'cells'. Pricing goes through
 * the existing per-1,000 rate in ModelCosts - SAP publishes RPT prices per 1,000 cells, the same
 * unit - and the Deep Context tier of the large model is a separate price row addressed by the
 * `--deep-context` suffix the gateway puts on the accounted model id. The suffix resolves like
 * `--deployed`: the exact id first, then the bare model, so a deep-context call is never priced
 * at nothing when only the base rate is maintained.
 */
import { pricingTwins, DEEP_CONTEXT_SUFFIX } from '../../../src/services/pricingTwins';
import { deriveDeepContextRows } from '../../../src/services/librarySnapshot';

describe('pricingTwins', () => {
  it('tries the exact id, then the bare model of a deep-context id, then the deployed twins', () => {
    expect(pricingTwins('sap-rpt-1.6-large' + DEEP_CONTEXT_SUFFIX)).toEqual([
      'sap-rpt-1.6-large--deep-context', 'sap-rpt-1.6-large', 'sap-rpt-1.6-large--deep-context--deployed', 'sap-rpt-1.6-large--deployed'
    ]);
    expect(pricingTwins('gpt-4.1-nano')).toEqual(['gpt-4.1-nano', 'gpt-4.1-nano--deployed']);
    expect(pricingTwins('x--deployed')).toEqual(['x--deployed', 'x']);
  });
});

describe('deriveDeepContextRows', () => {
  // The parent is 'foundation' (the bare sap-rpt-*-large orchestration entry, as it arrives from
  // the gateway before any deployment is resolved onto it) - this is exactly the shape that once
  // leaked 'foundation' onto the derived row and let Model Library Detail offer Deploy on a
  // pricing-only row (Detail.controller.ts gates canDeploy on accessType === 'foundation').
  const large = { modelId: 'sap-rpt-1.6-large', displayName: 'SAP-RPT-1.6 Large', provider: 'SAP', executableId: 'aicore-sap', accessType: 'foundation', absent: false, deployment: '{"configurationId":"c"}' };
  const small = { modelId: 'sap-rpt-1.6', displayName: 'SAP-RPT-1.6', provider: 'SAP', executableId: 'aicore-sap', accessType: 'deployment', absent: false, deployment: null };
  it('adds one pricing-only row per large RPT model and none for the small ones, never inheriting the parent\'s accessType', () => {
    const derived = deriveDeepContextRows([large, small, { modelId: 'gpt-4.1-nano', provider: 'OpenAI', absent: false }]);
    expect(derived).toEqual([{
      modelId: 'sap-rpt-1.6-large--deep-context', displayName: 'SAP-RPT-1.6 Large (Deep Context)', provider: 'SAP', executableId: 'aicore-sap',
      accessType: 'deployment', absent: false, deployment: null,
      description: 'Pricing entry for the Deep Context tier of sap-rpt-1.6-large; not callable'
    }]);
  });
  it('mirrors the parent\'s absence so a withdrawn model takes its tier with it', () => {
    expect(deriveDeepContextRows([{ ...large, absent: true }])[0].absent).toBe(true);
  });
  it('clamps the derived displayName to 100 characters like mapModelToLibraryRow does', () => {
    const longName = 'S'.repeat(95); // + ' (Deep Context)' (16 chars) = 111, over the 100-char column
    const derived = deriveDeepContextRows([{ ...large, displayName: longName }]);
    expect(derived[0].displayName).toHaveLength(100);
    expect(derived[0].displayName).toBe(`${longName} (Deep Context)`.slice(0, 100));
  });
});
