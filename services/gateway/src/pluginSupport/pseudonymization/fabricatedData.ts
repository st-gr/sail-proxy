/**
 * Fabricated Data Generator
 *
 * Generates realistic but fake replacement values for the fabricated_data strategy.
 */

import { ReplacementMap } from './replacementMap';

const FIRST_NAMES = [
  'Maria', 'James', 'Aisha', 'Wei', 'Carlos', 'Fatima', 'Kenji', 'Olga',
  'Raj', 'Sofia', 'Ahmed', 'Yuki', 'Igor', 'Amara', 'Liam', 'Priya',
  'Miguel', 'Chen', 'Nadia', 'Dmitri', 'Zara', 'Kofi', 'Elena', 'Hiroshi',
];

const LAST_NAMES = [
  'Garcia', 'Johnson', 'Patel', 'Kim', 'Nguyen', 'Mueller', 'Santos',
  'Ivanova', 'Ali', 'Tanaka', 'Andersson', 'Cohen', 'Okafor', 'Petrov',
  'Reyes', 'Singh', 'Yamamoto', 'Fischer', 'Khan', 'Martinez',
];

const STREET_NAMES = [
  'Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Ash',
  'Spruce', 'Cherry', 'River', 'Lake', 'Hill', 'Park', 'Valley',
];

const STREET_SUFFIXES = ['St', 'Ave', 'Blvd', 'Dr', 'Rd', 'Ln', 'Way', 'Ct'];

const CITIES = [
  'Springfield', 'Fairview', 'Madison', 'Georgetown', 'Salem',
  'Burlington', 'Greenville', 'Bristol', 'Chester', 'Ashland',
];

const ORGS = [
  'Apex Industries', 'Horizon Corp', 'Pinnacle Systems', 'Summit Group',
  'Nova Partners', 'Atlas Solutions', 'Zenith Labs', 'Vanguard Inc',
  'Meridian Services', 'Catalyst Technologies',
];

const UNION_NAMES = ['AWFU', 'MWBA', 'NWSU', 'GPWU', 'SWLA', 'TUWA'];

let counter = 0;

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDigits(count: number): string {
  let result = '';
  for (let i = 0; i < count; i++) {
    result += Math.floor(Math.random() * 10).toString();
  }
  return result;
}

/**
 * Generate a fake value for a given entity type
 */
export function generateFakeValue(
  entityType: string,
  original: string,
  map: ReplacementMap
): string {
  counter++;
  let fake: string;
  let attempts = 0;

  do {
    fake = generateOnce(entityType, original);
    attempts++;
  } while ((fake === original || map.reverse.has(fake)) && attempts < 10);

  return fake;
}

function generateOnce(entityType: string, original: string): string {
  switch (entityType) {
    case 'profile-person':
      return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

    case 'profile-email':
      return `${pick(FIRST_NAMES).toLowerCase()}${randomDigits(3)}@example.com`;

    case 'profile-phone': {
      // Preserve format of original
      const digits = original.replace(/\D/g, '');
      let fake = randomDigits(digits.length);
      // Reconstruct with same separators
      let result = '';
      let di = 0;
      for (const char of original) {
        if (/\d/.test(char)) {
          result += fake[di++] || '0';
        } else {
          result += char;
        }
      }
      return result;
    }

    case 'profile-address':
      return `${Math.floor(Math.random() * 9000) + 100} ${pick(STREET_NAMES)} ${pick(STREET_SUFFIXES)}`;

    case 'profile-ssn':
      return `${randomDigits(3)}-${randomDigits(2)}-${randomDigits(4)}`;

    case 'profile-credit-card-number':
      // Generate Luhn-valid number of same length
      const len = original.replace(/[\s\-]/g, '').length;
      return generateLuhnValid(len);

    case 'profile-url':
      return `https://example.com/${randomDigits(8)}`;

    case 'profile-location':
      return pick(CITIES);

    case 'profile-org':
      return pick(ORGS);

    case 'profile-nationality':
      return '[NATIONALITY]';

    case 'profile-ethnicity':
      return '[ETHNICITY]';

    case 'profile-gender':
      return '[GENDER]';

    case 'profile-religious-group':
      return '[RELIGION]';

    case 'profile-political-group':
      return '[POLITICAL_GROUP]';

    case 'profile-sexual-orientation':
      return '[SEXUAL_ORIENTATION]';

    case 'profile-trade-union':
      return pick(UNION_NAMES);

    case 'profile-username-password':
    case 'profile-iban':
    case 'profile-passport':
    case 'profile-driverlicense':
    case 'profile-nationalid':
      return `REDACTED_${randomDigits(8)}`;

    default:
      return `REDACTED_${randomDigits(8)}`;
  }
}

function generateLuhnValid(length: number): string {
  const digits: number[] = [];
  for (let i = 0; i < length - 1; i++) {
    digits.push(Math.floor(Math.random() * 10));
  }
  // Calculate check digit
  let sum = 0;
  let alternate = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits[i];
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  digits.push(checkDigit);
  return digits.join('');
}
