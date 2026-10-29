import { modelAccessType } from '../../../src/utils/modelAccessType';

describe('modelAccessType', () => {
  it('takes the Model Library value when the library knows the model', () => {
    expect(modelAccessType('foundation', 'anthropic--claude-4.8-opus')).toBe('foundation');
    expect(modelAccessType('deployment', 'anthropic--claude-4.8-opus--deployed')).toBe('deployment');
  });

  it('trusts the library over the id: a deployment row need not carry the suffix', () => {
    expect(modelAccessType('deployment', 'sap-rpt-1-large--deep-context')).toBe('deployment');
  });

  it('falls back to the --deployed suffix for a model the library has no row for', () => {
    expect(modelAccessType(null, 'retired-model--deployed')).toBe('deployment');
    expect(modelAccessType(undefined, 'retired-model--deployed')).toBe('deployment');
  });

  it('leaves an unknown bare id undecided instead of guessing', () => {
    expect(modelAccessType(null, 'unlisted-model')).toBeNull();
    expect(modelAccessType('something-else', 'unlisted-model')).toBeNull();
    expect(modelAccessType(null, null)).toBeNull();
  });
});
