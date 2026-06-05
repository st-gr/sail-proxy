/**
 * Tier 1: Structural Regex Detectors
 *
 * Detects PII via regex patterns: email, phone, SSN, credit card, IBAN, URL,
 * national ID, passport, driver's license, credentials, and address.
 * Includes post-detection validation (Luhn for credit cards, mod-97 for IBANs).
 */

import { EntityMatch, EntityConfig } from '../types';

interface DetectorDef {
  type: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

// Luhn algorithm for credit card validation
function luhnCheck(digits: string): boolean {
  const nums = digits.split('').map(Number);
  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = nums[i];
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// IBAN mod-97 validation
function ibanCheck(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, '');
  if (cleaned.length < 15 || cleaned.length > 34) return false;
  // Move first 4 chars to end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  // Convert letters to numbers (A=10, B=11, ...)
  let numStr = '';
  for (const char of rearranged) {
    if (char >= 'A' && char <= 'Z') {
      numStr += (char.charCodeAt(0) - 55).toString();
    } else {
      numStr += char;
    }
  }
  // Mod 97 check (handle large numbers via chunking)
  let remainder = 0;
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + parseInt(numStr[i])) % 97;
  }
  return remainder === 1;
}

// Phone number digit count validation
function phoneValidate(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

const DETECTORS: DetectorDef[] = [
  {
    type: 'profile-email',
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  {
    type: 'profile-phone',
    pattern: /(?:\+?(\d{1,3})[\s.\-]?)?(?:\((\d{2,4})\)|(\d{2,4}))[\s.\-]?(\d{3,4})[\s.\-]?(\d{3,4})/g,
    validate: phoneValidate,
  },
  {
    type: 'profile-ssn',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    type: 'profile-ssn',
    // Canada SIN
    pattern: /\b\d{3}\s\d{3}\s\d{3}\b/g,
  },
  {
    type: 'profile-credit-card-number',
    pattern: /\b(?:\d[\s\-]?){13,19}\b/g,
    validate: (match: string) => {
      const digits = match.replace(/[\s\-]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnCheck(digits);
    },
  },
  {
    type: 'profile-iban',
    pattern: /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}(?:[\s]?[\dA-Z]{4}){1,7}(?:[\s]?[\dA-Z]{1,4})?\b/g,
    validate: ibanCheck,
  },
  {
    type: 'profile-url',
    pattern: /(?:https?:\/\/|www\.)[^\s<>"{}|\\^`\[\]]+/g,
  },
  {
    type: 'profile-nationalid',
    // UK National Insurance
    pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/g,
  },
  {
    type: 'profile-nationalid',
    // Mexico CURP
    pattern: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g,
  },
  {
    type: 'profile-nationalid',
    // Generic context-anchored
    pattern: /(?:national\s*id|identification\s*(?:number|no\.?))\s*[:=]?\s*([A-Z0-9\-]{6,20})/gi,
  },
  {
    type: 'profile-passport',
    // Context-anchored
    pattern: /(?:passport\s*(?:number|no\.?|#))\s*[:=]?\s*([A-Z]{0,2}\d{6,9})/gi,
  },
  {
    type: 'profile-driverlicense',
    // Context-anchored generic
    pattern: /(?:driver'?s?\s*licen[sc]e|DL)\s*(?:number|no\.?|#)?\s*[:=]?\s*([A-Z0-9\-]{5,15})/gi,
  },
  {
    type: 'profile-username-password',
    pattern: /(?:user(?:name)?|login|pass(?:word|wd)?|pwd|secret|token|api[_\-]?key)\s*[:=]\s*\S+/gi,
  },
  {
    type: 'profile-address',
    // US street address
    pattern: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s+){1,4}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Rd|Road|Ln|Lane|Ct|Court|Way|Pl(?:ace)?|Cir(?:cle)?|Pkwy|Parkway)\.?\b/g,
  },
  {
    type: 'profile-pronouns-gender',
    // Context-anchored pronoun declarations
    pattern: /(?:pronouns?|goes\s+by)\s*[:=]?\s*((?:he|she|they|ze|xe|ey|fae)(?:\s*\/\s*(?:him|her|them|zir|xem|em|faer))+)/gi,
  },
];

/**
 * Run all regex detectors on the given text
 */
export function detectRegexEntities(text: string, enabledEntities: EntityConfig[]): EntityMatch[] {
  const enabledTypes = new Set(enabledEntities.filter(e => e.enabled !== false).map(e => e.type));

  // Check if profile-sensitive-data is enabled (enables all dictionary + pronoun types)
  const sensitiveDataEnabled = enabledTypes.has('profile-sensitive-data');

  const matches: EntityMatch[] = [];

  for (const detector of DETECTORS) {
    if (!enabledTypes.has(detector.type) && !sensitiveDataEnabled) {
      continue;
    }

    // Reset lastIndex for global regex
    detector.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = detector.pattern.exec(text)) !== null) {
      const fullMatch = match[0];
      const capturedGroup = match[1]; // Some patterns use capture groups

      // Use captured group if available (for context-anchored patterns)
      const entityText = capturedGroup || fullMatch;
      const start = capturedGroup ? match.index + fullMatch.indexOf(capturedGroup) : match.index;
      const end = start + entityText.length;

      // Run post-detection validation if defined
      if (detector.validate && !detector.validate(entityText)) {
        continue;
      }

      matches.push({
        original: entityText,
        type: detector.type,
        start,
        end,
        priority: 1, // Tier 1: structural regex
      });
    }
  }

  return matches;
}
