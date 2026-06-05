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
}

export interface MaskingConfig {
  method: 'pseudonymization' | 'anonymization';
  entities: EntityConfig[];
  allow_list?: string[];
  custom_entities?: CustomEntity[];
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
  'custom': 'MASKED_CUSTOM',
};
