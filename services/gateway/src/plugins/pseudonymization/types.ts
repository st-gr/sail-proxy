/**
 * Shared type definitions for the pseudonymization plugin
 */

export interface EntityMatch {
  original: string;
  type: string;
  start: number;
  end: number;
  placeholder?: string;
  priority: number; // 0=custom, 1=regex, 2=NER, 3=dictionary
  /**
   * How much evidence this candidate carries, 0–1. Every detector sets a base value for
   * its own tier (detectors/confidence.ts, DETECTOR_CONFIDENCE); `detectEntities` then
   * applies the context adjustments and drops anything below the configured threshold.
   *
   * REQUIRED, deliberately: a detector that forgets to score its matches would otherwise
   * ship them as `undefined` and silently bypass the threshold gate. The compiler catches
   * that instead.
   */
  confidence: number;
}

export interface MaskingConfig {
  method: 'pseudonymization' | 'anonymization';
  entities: EntityConfig[];
  allow_list?: string[];
  custom_entities?: CustomEntity[];
  /**
   * Legal-form suffixes that make a preceding capitalised run an organisation
   * ("Acme Industries Inc"). Generic forms only — never a specific company name.
   */
  org_suffixes?: string[];
  /**
   * Literal location terms to mask. Ships EMPTY: place names are deployment-specific
   * and this repository is public. Operators populate it through the admin config app.
   * Nothing is inferred — a term not listed here is never treated as a location.
   */
  location_gazetteer?: string[];
  /**
   * The confidence a candidate must reach to be masked, for every category that has no
   * entry in `thresholds`. Absent → 0.5 (DEFAULT_MIN_CONFIDENCE). See
   * detectors/confidence.ts for the per-detector base scores and the adjustments.
   */
  min_confidence?: number;
  /**
   * Per-category confidence thresholds, overriding `min_confidence` for the categories
   * named. A category absent from the map uses `min_confidence`.
   */
  thresholds?: Record<string, number>;
  /**
   * Values this deployment never masks: case-sensitive literals and anchored regex sources.
   * Applied after the technical veto and before scoring — see detectors/allowlist.ts.
   *
   * Not to be confused with `allow_list` above, which is the older flat, case-insensitive
   * list applied before the veto. Both are honoured; neither replaces the other.
   */
  allowlist?: AllowlistConfig;
  /**
   * Distinct masked values a request may carry before it is REPORTED as saturated. Read
   * only by the reporter (saturationReport.ts) — never by a detector and never by the
   * scorer. Absent → 40 (DEFAULT_SATURATION_WARN).
   */
  saturation_warn?: number;
}

/**
 * The operator allow-list. `terms` are case-SENSITIVE literals; `patterns` are regex
 * SOURCES, anchored to the whole span (`^(?:…)$`) before compiling. A span matching either
 * is never masked. See detectors/allowlist.ts for why each form is shaped that way and what
 * happens to a pattern that does not compile.
 */
export interface AllowlistConfig {
  patterns?: string[];
  terms?: string[];
}

export interface EntityConfig {
  type: string;
  replacement_strategy?: 'constant' | 'fabricated_data';
  replacement_value?: string;
  enabled?: boolean;
}

export interface CustomEntity {
  pattern: string;
  placeholder: string;
  flags?: string;
}

export interface MaskingInfo {
  masked_input: string;
  entities_detected: Array<{
    placeholder: string;
    type: string;
    start: number;
    end: number;
  }>;
  method: string;
}

export interface PseudonymizationState {
  map: ReplacementMapData;
  config: MaskingConfig;
  maskedInputs: string[];
  entities: EntityMatch[];
  streamBuffer?: any;
}

export interface ReplacementMapData {
  forward: Map<string, string>;
  reverse: Map<string, string>;
}

/**
 * Default placeholder prefixes per entity type.
 * These match SAP AI Core's sap_data_privacy_integration masking module output exactly.
 */
export const DEFAULT_PREFIXES: Record<string, string> = {
  'profile-email': 'MASKED_EMAIL',
  'profile-phone': 'MASKED_PHONE_NUMBER',
  'profile-ssn': 'MASKED_SOCIAL_SECURITY_NUMBER',
  'profile-credit-card-number': 'MASKED_CREDIT_CARD_NUMBER',
  'profile-iban': 'MASKED_IBAN',
  'profile-url': 'MASKED_URL',
  'profile-nationalid': 'MASKED_NATIONAL_ID',
  'profile-passport': 'MASKED_PASSPORT',
  'profile-driverlicense': 'MASKED_DRIVERS_LICENSE',
  'profile-username-password': 'MASKED_USER_PASSWORD',
  'profile-address': 'MASKED_ADDRESS',
  'profile-person': 'MASKED_PERSON',
  'profile-org': 'MASKED_ORG',
  'profile-location': 'MASKED_LOCATION',
  'profile-nationality': 'MASKED_NATIONALITY',
  'profile-ethnicity': 'MASKED_ETHNICITY_OR_RACE',
  'profile-gender': 'MASKED_GENDER',
  'profile-pronouns-gender': 'MASKED_PRONOUNS_GENDER',
  'profile-religious-group': 'MASKED_RELIGIOUS_GROUP',
  'profile-political-group': 'MASKED_POLITICAL_GROUP',
  'profile-sexual-orientation': 'MASKED_SEXUAL_ORIENTATION',
  'profile-trade-union': 'MASKED_TRADE_UNION',
  'profile-sensitive-data': 'MASKED_SENSITIVE_DATA',
  // Not part of SAP's sap_data_privacy_integration vocabulary (see the note above) —
  // these categories are detected by this gateway, not by SAP's masking module. The
  // MASKED_<TYPE> shape is required: detectors/index.ts recognises existing
  // placeholders via /MASKED_[A-Z_]+_[0-9a-f]+/ and would otherwise re-mask them.
  'profile-itin': 'MASKED_ITIN',
  'profile-bank-account': 'MASKED_BANK_ACCOUNT_NUMBER',
  'profile-medical-license': 'MASKED_MEDICAL_LICENSE',
  'profile-ip-address': 'MASKED_IP_ADDRESS',
  'custom': 'MASKED_CUSTOM',
};
