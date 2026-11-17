/**
 * The configuration form's account of the global pseudonymization switch: where masking is enforced,
 * which endpoint and model flags the switch overrules, and when enabling a flag must switch it on.
 *
 * Pure and UI5-free. `enforcementState` mirrors the gateway's helper
 * (services/gateway/src/pluginSupport/pseudonymization/enforcementState.ts): the switch is On only for
 * boolean `true`, flags count when truthy, endpoints and models come in object key order. The shared
 * case table services/gateway/test/fixtures/pseudonymization-enforcement-cases.json holds the two together.
 * Texts are bundle keys with English defaults byte-identical to the default bundle (validationTexts pattern).
 */
import { formatPattern } from './validationTexts';
import { applyDescriptor } from './schemaForm';

export type Translator = (key: string, args?: (string | number)[]) => string;

export const GLOBAL_SWITCH_POINTER = '/api_config/observability/pseudonymization/enabled';

export interface EnforcementState {
    globalOn: boolean;
    endpoints: string[];
    models: string[];
}

const EN_TEXTS: Record<string, string> = {
    formPseudoEnforced: 'Enforced for: {0}',
    formPseudoEnforcedNowhere: 'Enforced nowhere: no endpoint or model enables it.',
    formPseudoOffOverruled: 'Switched off. Overruled: {0}',
    formPseudoOff: 'Switched off.',
    formPseudoModel: 'model {0}',
    formPseudoOverruled: 'Overruled: the global switch is off.',
    formPseudoAutoFlip: 'The global pseudonymization switch was switched on. Now enforced for: {0}'
};

const english: Translator = (key, args) => formatPattern(EN_TEXTS[key] ?? key, args);

type Dict = Record<string, any>;

function isObject(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null;
}

function flaggedKeys(group: unknown): string[] {
    if (!isObject(group)) {
        return [];
    }
    return Object.keys(group).filter(key => {
        const entry = group[key];
        return isObject(entry) && isObject(entry.pseudonymization) && !!entry.pseudonymization.enabled;
    });
}

export function enforcementState(apiConfig: unknown): EnforcementState {
    const cfg: Dict = isObject(apiConfig) ? apiConfig : {};
    return {
        globalOn: cfg.observability?.pseudonymization?.enabled === true,
        endpoints: flaggedKeys(cfg.hooks?.defaults),
        models: flaggedKeys(cfg.models?.overrides)
    };
}

const FLAG_POINTER = /^\/api_config\/(?:hooks\/defaults|models\/overrides)\/[^/]+\/pseudonymization\/enabled$/;

export function isFlagPointer(pointer: string): boolean {
    return FLAG_POINTER.test(pointer);
}

/** RFC 6901 escaping, as the form builds its pointers (schemaForm.ts escapeSegment). */
function escapeSegment(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function stateOf(document: unknown): EnforcementState {
    return enforcementState(isObject(document) ? document.api_config : undefined);
}

function enforcedList(state: EnforcementState, t: Translator): string {
    return [...state.endpoints, ...state.models.map(model => t('formPseudoModel', [model]))].join(', ');
}

export function statusLine(document: unknown, t: Translator = english): string {
    const state = stateOf(document);
    const list = enforcedList(state, t);
    if (state.globalOn) {
        return list ? t('formPseudoEnforced', [list]) : t('formPseudoEnforcedNowhere');
    }
    return list ? t('formPseudoOffOverruled', [list]) : t('formPseudoOff');
}

export function fieldNote(document: unknown, pointer: string, t: Translator = english): string | undefined {
    if (pointer === GLOBAL_SWITCH_POINTER) {
        return statusLine(document, t);
    }
    if (!isFlagPointer(pointer)) {
        return undefined;
    }
    const state = stateOf(document);
    const flagged = [...state.endpoints.map(e => `/api_config/hooks/defaults/${escapeSegment(e)}/pseudonymization/enabled`),
        ...state.models.map(m => `/api_config/models/overrides/${escapeSegment(m)}/pseudonymization/enabled`)];
    return !state.globalOn && flagged.includes(pointer) ? t('formPseudoOverruled') : '';
}

export function autoFlip(document: unknown, pointer: string, value: unknown): boolean {
    return isFlagPointer(pointer) && value === true && !stateOf(document).globalOn;
}

export function autoFlipMessage(document: unknown, t: Translator = english): string {
    return t('formPseudoAutoFlip', [enforcedList(stateOf(document), t)]);
}

/**
 * The document after the form writes `value` at `pointer`, with the global switch switched on too
 * when `autoFlip` says so: both writes or neither. Throws when either cannot be written; the input
 * is never modified (`applyDescriptor` works on a clone).
 */
export function applyChange(document: unknown, pointer: string, value: unknown): { document: unknown; flipped: boolean } {
    const flipped = autoFlip(document, pointer, value);
    const edited = applyDescriptor(document, pointer, value);
    return { document: flipped ? applyDescriptor(edited, GLOBAL_SWITCH_POINTER, true) : edited, flipped };
}
