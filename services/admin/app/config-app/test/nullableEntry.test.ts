import { nullableNumberEntry } from '../webapp/model/nullableEntry';

/**
 * What a nullable number field makes of the text typed into it.
 *
 * The rule lives apart from the control that applies it (`descriptorControls.buildField`'s
 * `number` case) for the reason every other pure rule in `webapp/model` does: that file imports
 * `sap/*`, which this repo's jest cannot resolve, so nothing inside it can be unit-tested - see
 * `test/configFormTabs.test.ts`'s own header.
 *
 * The field exists because a `StepInput` has no empty state: its value is a float that defaults to
 * 0, and 0 is a QUOTA, not the absence of one. `platform.quotas.*` is `null` for unlimited, so the
 * control has to be an Input and something has to say what its text means.
 */
describe('nullableNumberEntry - the text a nullable number field holds', () => {
  const tokens = { integer: true, minimum: 0 };
  const spend = { integer: false, minimum: 0 };

  it('reads an empty field as null - the schema\'s own "unlimited"', () => {
    expect(nullableNumberEntry('', tokens)).toEqual({ value: null });
    expect(nullableNumberEntry('   ', tokens)).toEqual({ value: null });
  });

  it('reads a number as that number', () => {
    expect(nullableNumberEntry('42', tokens)).toEqual({ value: 42 });
    expect(nullableNumberEntry(' 42 ', tokens)).toEqual({ value: 42 });
    // Zero is a value the schema allows and means "no requests at all", not "unlimited": only an
    // empty field is null.
    expect(nullableNumberEntry('0', tokens)).toEqual({ value: 0 });
  });

  it('keeps decimals for a float field and rejects them for an integer one', () => {
    expect(nullableNumberEntry('4.5', spend)).toEqual({ value: 4.5 });
    expect(nullableNumberEntry('4.5', tokens)).toEqual({ error: 'formNotAWholeNumber' });
  });

  it('rejects text that is not a number at all', () => {
    expect(nullableNumberEntry('abc', tokens)).toEqual({ error: 'formNotANumber' });
    expect(nullableNumberEntry('1/2', spend)).toEqual({ error: 'formNotANumber' });
    expect(nullableNumberEntry('Infinity', spend)).toEqual({ error: 'formNotANumber' });
  });

  it('enforces the schema\'s own bounds, and names the bound it enforced', () => {
    expect(nullableNumberEntry('-1', tokens)).toEqual({ error: 'formBelowMinimum', bound: 0 });
    expect(nullableNumberEntry('11', { integer: true, minimum: 1, maximum: 10 }))
      .toEqual({ error: 'formAboveMaximum', bound: 10 });
    // A bound the schema does not declare is not invented.
    expect(nullableNumberEntry('-1', { integer: false })).toEqual({ value: -1 });
  });

  it('lets an empty field through whatever the bounds are - empty is not below the minimum', () => {
    expect(nullableNumberEntry('', { integer: true, minimum: 1, maximum: 10 })).toEqual({ value: null });
  });
});
