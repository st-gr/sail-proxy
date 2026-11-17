import cases = require('../../../../gateway/test/fixtures/pseudonymization-enforcement-cases.json');
import { GLOBAL_SWITCH_POINTER, enforcementState, isFlagPointer, statusLine, fieldNote, autoFlip, autoFlipMessage, applyChange } from '../webapp/model/pseudonymizationSwitch';
import { applyDescriptor } from '../webapp/model/schemaForm';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import apiConfigSchema from '../webapp/model/apiConfigSchema';

const flag = () => ({ pseudonymization: { enabled: true } });
const doc = (global: unknown, endpoints: string[], models: string[] = []) => {
    const observability: any = { pseudonymization: {} };
    if (global !== undefined) observability.pseudonymization.enabled = global;
    return {
        api_config: {
            hooks: { defaults: Object.fromEntries(endpoints.map(e => [e, flag()])) },
            models: { overrides: Object.fromEntries(models.map(m => [m, flag()])) },
            observability
        }
    };
};
const EP = (e: string) => `/api_config/hooks/defaults/${e}/pseudonymization/enabled`;
const MODEL = (m: string) => `/api_config/models/overrides/${m}/pseudonymization/enabled`;

it.each((cases as any[]).map(c => [c.name, c]))('agrees with the gateway on: %s', (_n, c: any) => {
    expect(enforcementState(c.api_config)).toEqual({ globalOn: c.globalOn, endpoints: c.endpoints, models: c.models });
});

it('isFlagPointer accepts exactly the two flag shapes', () => {
    expect(isFlagPointer(EP('openai'))).toBe(true);
    expect(isFlagPointer(MODEL('m1--deployed'))).toBe(true);
    expect(isFlagPointer('/api_config/hooks/defaults/a/b/pseudonymization/enabled')).toBe(false);
    expect(isFlagPointer(GLOBAL_SWITCH_POINTER)).toBe(false);
});

describe('statusLine', () => {
    it('on with flags', () => expect(statusLine(doc(true, ['openai', 'anthropic'], ['m1--deployed']))).toBe('Enforced for: openai, anthropic, model m1--deployed'));
    it('on without flags', () => expect(statusLine(doc(true, []))).toBe('Enforced nowhere: no endpoint or model enables it.'));
    it('off with flags', () => expect(statusLine(doc(false, ['openai'], ['m1--deployed']))).toBe('Switched off. Overruled: openai, model m1--deployed'));
    it('absent without flags', () => expect(statusLine(doc(undefined, []))).toBe('Switched off.'));
    it('uses the injected translator', () => expect(statusLine(doc(undefined, []), k => `<${k}>`)).toBe('<formPseudoOff>'));
});

describe('fieldNote', () => {
    it('global pointer: the status line', () => expect(fieldNote(doc(true, []), GLOBAL_SWITCH_POINTER)).toBe('Enforced nowhere: no endpoint or model enables it.'));
    it('an enabled flag under Off is overruled', () => expect(fieldNote(doc(false, ['openai']), EP('openai'))).toBe('Overruled: the global switch is off.'));
    it('a model flag under Off is overruled', () => expect(fieldNote(doc(undefined, [], ['m1--deployed']), MODEL('m1--deployed'))).toBe('Overruled: the global switch is off.'));
    it('an enabled flag under On carries an empty note', () => expect(fieldNote(doc(true, ['openai']), EP('openai'))).toBe(''));
    it('a disabled flag under Off carries an empty note', () => expect(fieldNote(doc(false, []), EP('openai'))).toBe(''));
    it('any other field has no note', () => expect(fieldNote(doc(false, []), '/api_config/platform/security/enabled')).toBeUndefined());
    it('another boolean of the same block has no note', () => expect(fieldNote(doc(false, ['openai']), '/api_config/hooks/defaults/openai/pseudonymization/allow_user_bypass')).toBeUndefined());
});

describe('autoFlip', () => {
    it.each([[false], [undefined], ['true']])('global %p: enabling an endpoint flag flips', g => expect(autoFlip(doc(g, []), EP('openai'), true)).toBe(true));
    it('enabling a model flag flips', () => expect(autoFlip(doc(false, []), MODEL('m1--deployed'), true)).toBe(true));
    it('no block at all: flips', () => expect(autoFlip({ api_config: {} }, EP('openai'), true)).toBe(true));
    it('global already on: no flip', () => expect(autoFlip(doc(true, []), EP('openai'), true)).toBe(false));
    it('switching a flag off: no flip', () => expect(autoFlip(doc(false, ['openai']), EP('openai'), false)).toBe(false));
    it('the global switch itself: no flip', () => expect(autoFlip(doc(false, ['openai']), GLOBAL_SWITCH_POINTER, false)).toBe(false));
    it('another field: no flip', () => expect(autoFlip(doc(false, []), '/api_config/hooks/defaults/openai/pseudonymization/allow_user_bypass', true)).toBe(false));
});

describe('a model id containing a slash', () => {
    const SLASHED = '/api_config/models/overrides/vendor~1model-x/pseudonymization/enabled';
    it('fieldNote finds the escaped pointer under Off', () => expect(fieldNote(doc(false, [], ['vendor/model-x']), SLASHED)).toBe('Overruled: the global switch is off.'));
    it('autoFlip flips for the escaped pointer under Off', () => expect(autoFlip(doc(false, []), SLASHED, true)).toBe(true));
    it('statusLine names the model unescaped', () => expect(statusLine(doc(false, [], ['vendor/model-x']))).toBe('Switched off. Overruled: model vendor/model-x'));
});

describe('applyChange', () => {
    it('enabling a flag under Off writes the flag and the global switch, and says so', () => {
        const before = doc(false, []);
        const result = applyChange(before, EP('openai'), true) as any;
        expect(result.flipped).toBe(true);
        expect(result.document.api_config.hooks.defaults.openai.pseudonymization.enabled).toBe(true);
        expect(result.document.api_config.observability.pseudonymization.enabled).toBe(true);
        expect(before.api_config.observability.pseudonymization.enabled).toBe(false);
    });
    it('any other edit writes only itself', () => {
        const result = applyChange(doc(false, ['openai']), EP('openai'), false) as any;
        expect(result.flipped).toBe(false);
        expect(result.document.api_config.hooks.defaults.openai.pseudonymization.enabled).toBe(false);
        expect(result.document.api_config.observability.pseudonymization.enabled).toBe(false);
    });
    it('a flip that cannot be written throws and leaves the document untouched', () => {
        const before: any = doc(false, []);
        before.api_config.observability.pseudonymization = 'off';
        const snapshot = JSON.stringify(before);
        expect(() => applyChange(before, EP('openai'), true)).toThrow();
        expect(JSON.stringify(before)).toBe(snapshot);
    });
});

it('autoFlipMessage names everything that is enforced after the flip', () => {
    expect(autoFlipMessage(doc(true, ['openai', 'google'], ['m1--deployed'])))
        .toBe('The global pseudonymization switch was switched on. Now enforced for: openai, google, model m1--deployed');
});

it('a flipped document without the block still passes the schema gate', () => {
    const bare = JSON.parse(JSON.stringify(require('../../../api_config.json')));
    delete bare.api_config.observability.pseudonymization;
    const flipped = applyDescriptor(bare, GLOBAL_SWITCH_POINTER, true) as any;
    expect(flipped.api_config.observability.pseudonymization).toEqual({ enabled: true });
    const result = evaluateApiConfigDocument(apiConfigSchema, flipped);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
});
