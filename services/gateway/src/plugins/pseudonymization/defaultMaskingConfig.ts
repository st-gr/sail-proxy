/**
 * The pseudonymizationPlugin's DEFAULT entity set.
 *
 * Lifted out of `index.ts` unchanged (and re-imported there) for one reason: `index.ts`
 * is a CommonJS `export = pluginRules` module, so nothing else in the codebase can import
 * a named value from it. A second caller now needs this list —
 * `plugins/fileSearch/chunkMasking.ts`, which masks retrieved document chunks on their way
 * to the deployment and must detect the same categories the request body was masked for.
 * The alternative was a second literal copy of the list, which would drift silently: the
 * chunk path would quietly stop masking a category the request path still masks, and
 * nothing would fail.
 *
 * This is the set the plugin starts from for TRIGGERWORD and FORCE-CONFIG activation only.
 * `api_config.json` toggles are layered over it per request (see `resolveDefaultEntities`
 * in index.ts), and an explicit caller-supplied body `masking` config replaces it wholesale.
 *
 * @see index.ts - resolveDefaultEntities, the per-request layering
 * @see ../fileSearch/chunkMasking.ts - the second consumer, and why it can only use the base set
 */
import { MaskingConfig } from './types';

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  method: 'pseudonymization',
  entities: [
    { type: 'profile-person' },
    { type: 'profile-email' },
    { type: 'profile-phone' },
    { type: 'profile-ssn' },
    { type: 'profile-credit-card-number' },
    { type: 'profile-iban' },
    { type: 'profile-url' },
    { type: 'profile-address' },
    { type: 'profile-username-password' },
    { type: 'profile-nationalid' },
    { type: 'profile-passport' },
    { type: 'profile-driverlicense' },
    { type: 'profile-pronouns-gender' },
    { type: 'profile-nationality' },
    { type: 'profile-ethnicity' },
    { type: 'profile-gender' },
    { type: 'profile-religious-group' },
    { type: 'profile-political-group' },
    { type: 'profile-sexual-orientation' },
    { type: 'profile-trade-union' },
    { type: 'profile-org' },
    { type: 'profile-location' },
  ],
};
