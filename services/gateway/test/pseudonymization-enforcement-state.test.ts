import cases = require('./fixtures/pseudonymization-enforcement-cases.json');
import { enforcementState, enforcementLine, isGlobalSwitchOn } from '../src/pluginSupport/pseudonymization/enforcementState';

describe('enforcementState', () => {
  it.each(cases.map((c: any) => [c.name, c]))('%s', (_name, c: any) => {
    const state = enforcementState(c.api_config);
    expect(state).toEqual({ globalOn: c.globalOn, endpoints: c.endpoints, models: c.models });
    expect(isGlobalSwitchOn(c.api_config)).toBe(c.globalOn);
    expect(enforcementLine(state)).toBe(c.line);
  });
  it('does not mutate its input', () => {
    const cfg = JSON.parse(JSON.stringify(cases[0].api_config)); const before = JSON.stringify(cfg);
    enforcementState(cfg);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});
