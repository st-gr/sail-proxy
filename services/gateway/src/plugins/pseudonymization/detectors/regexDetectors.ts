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
  // When true, the entity is the first defined CAPTURE GROUP (context-anchored /
  // value-extracting patterns like `token: <value>` or `passport number: <value>`).
  // When absent, the entity is the WHOLE match — required for structural detectors
  // (phone, SSN, credit card, IBAN) whose capture groups are format sub-parts, not
  // the value: extracting a sub-group there would feed e.g. an area code to the
  // validator and drop the match entirely.
  captureValue?: boolean;
}

/**
 * Decide whether a URL is worth masking. We SKIP:
 *  - loopback / private / link-local hosts (localhost, 127.x, ::1, 10.x,
 *    192.168.x, 172.16-31.x, *.local, *.internal) — these are dev/infra
 *    endpoints with ~no privacy value, and masking them breaks agent edit
 *    workflows (the model must reproduce an opaque token to match file text);
 *  - template / non-literal URLs containing <...>, {...}, ${...} or an
 *    unresolved-looking host — masking these fragments one logical endpoint
 *    into many bogus tokens.
 * Real external hosts still get masked.
 */
function isMaskableUrl(fullMatch: string): boolean {
  // Template markers anywhere in the matched URL → not a real value.
  if (/[<>{}]|\$\{/.test(fullMatch)) return false;

  // Trailing colon = incomplete authority, i.e. the port was a template variable
  // (`http://host:{PORT}` matches only up to `http://host:` since `{` is excluded).
  if (/:$/.test(fullMatch)) return false;

  const m = fullMatch.match(/^(?:(?:https?|wss?|ftps?):\/\/)?([^/?#]+)/);
  const authority = (m ? m[1] : fullMatch).toLowerCase();

  // Authority must be a well-formed host[:port] (or [ipv6][:port]). Anything else —
  // e.g. a leftover `http://host:$` from `${PORT}`, or a bare scheme — is a template
  // fragment, not a real endpoint.
  if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9._-]+)(?::\d+)?$/.test(authority)) return false;

  const host = authority.replace(/:\d*$/, '').replace(/^\[|\]$/g, '');

  if (host === '' || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === '::1' || host.startsWith('127.') || host.startsWith('0.')) return false;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return false;
  // 172.16.0.0 – 172.31.255.255
  const m172 = host.match(/^172\.(\d{1,3})\./);
  if (m172) { const o = Number(m172[1]); if (o >= 16 && o <= 31) return false; }
  // 169.254.0.0/16 link-local
  if (host.startsWith('169.254.')) return false;
  return true;
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

// Phone number validation: 7-15 digits AND a real phone SIGNAL (a leading '+',
// parentheses, or a dash separator). Spaces and dots are NOT signals — bare
// space-separated numeric lists (router IDs, ports, PIDs) and dotted IPs use
// them, and the structural pattern would otherwise span across them and mask
// them as phone numbers. A labelled phone with only spaces is still caught by
// the separate context-anchored detector below.
function phoneValidate(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  return /[+()\-]/.test(match);
}

// Credential value validation: reject template placeholders (`<token>`, `${VAR}`,
// `$VAR`) and values too short to be real secrets. Applied to the captured VALUE.
function credentialValueValidate(value: string): boolean {
  if (/[<>{}]|\$\{|^\$/.test(value)) return false;
  return value.length >= 4;
}

const DETECTORS: DetectorDef[] = [
  {
    type: 'profile-email',
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  {
    type: 'profile-phone',
    // Structural phone. Digit boundaries (?<!\d) / (?!\d) keep a match from being
    // a fragment of a longer run. phoneValidate additionally requires a +/()/-
    // signal so space-separated ID/port lists and dotted IPs are not masked.
    pattern: /(?<!\d)(?:\+?(\d{1,3})[\s.\-]?)?(?:\((\d{2,4})\)|(\d{2,4}))[\s.\-]?(\d{3,4})[\s.\-]?(\d{3,4})(?!\d)/g,
    validate: phoneValidate,
  },
  {
    type: 'profile-phone',
    // Context-anchored: an explicitly labelled phone still masks even when it is
    // only space-separated (no +/()/-). Captures the value only (captureValue).
    pattern: /(?:phone|tel(?:ephone)?|mobile|cell(?:phone)?|fax|whatsapp)\b(?:\s*(?:number|no\.?|#))?\s*[:=]?\s*(\+?\d[\d\s().\-]*\d)/gi,
    validate: (v: string) => { const d = v.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; },
    captureValue: true,
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
    pattern: /(?:(?:https?|wss?|ftps?):\/\/|www\.)[^\s<>"{}|\\^`\[\]]+/g,
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
    captureValue: true,
  },
  {
    type: 'profile-passport',
    // Context-anchored
    pattern: /(?:passport\s*(?:number|no\.?|#))\s*[:=]?\s*([A-Z]{0,2}\d{6,9})/gi,
    captureValue: true,
  },
  {
    type: 'profile-driverlicense',
    // Context-anchored generic
    pattern: /(?:driver'?s?\s*licen[sc]e|DL)\s*(?:number|no\.?|#)?\s*[:=]?\s*([A-Z0-9\-]{5,15})/gi,
    captureValue: true,
  },
  {
    type: 'profile-username-password',
    // key=value / key: value credentials. The leading (?<![A-Za-z0-9_]) + greedy
    // identifier prefix make the match consume the WHOLE identifier ending in a
    // credential word — so `$env:SSHPASS="x"` masks only `x` (not `SSHMASKED_…`),
    // and `SSH_ASKPASS_REQUIRE=force` does not match (identifier ends in REQUIRE).
    // Only the value is captured, preserving surrounding script structure.
    pattern: /(?<![A-Za-z0-9_])[A-Za-z0-9_$-]*(?:user(?:name)?|login|pass(?:word|wd)?|pwd|secret|token|api[_\-]?key)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    validate: credentialValueValidate,
    captureValue: true,
  },
  {
    type: 'profile-username-password',
    // JSON-style credentials: "token": "value" — the quoted key defeats the pattern
    // above. Capture ONLY the value so masking preserves the JSON structure.
    pattern: /"(?:user(?:name)?|login|pass(?:word|wd)?|pwd|secret|token|api[_\-]?key|access[_\-]?token|auth[_\-]?token|bearer)"\s*:\s*"([^"]+)"/gi,
    validate: credentialValueValidate,
    captureValue: true,
  },
  {
    type: 'profile-username-password',
    // HTTP auth headers: `Authorization: Bearer <token>` and siblings. This is the
    // gap behind the 28551619 incident — the secret rode through in four Bearer
    // headers unmasked. Capture the opaque credential value only.
    pattern: /(?:Authorization|Proxy-Authorization|X-Auth-Token|X-Api-Key)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token|OAuth)\s+)?([A-Za-z0-9][A-Za-z0-9._~+\/=-]{7,})/gi,
    validate: credentialValueValidate,
    captureValue: true,
  },
  {
    type: 'profile-username-password',
    // Standalone `Bearer <opaque-token>` not preceded by a header name. Min length
    // 12 keeps ordinary prose words after "Bearer" from matching.
    pattern: /\bBearer\s+([A-Za-z0-9][A-Za-z0-9._~+\/=-]{11,})/g,
    validate: credentialValueValidate,
    captureValue: true,
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
    captureValue: true,
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

    // Reset lastIndex for global regex. Ensure the `d` (hasIndices) flag so we can
    // locate a captured group by its true offset instead of a fragile indexOf.
    const pattern = detector.pattern.flags.includes('d')
      ? detector.pattern
      : new RegExp(detector.pattern.source, detector.pattern.flags + 'd');
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[0];
      // Extract a capture group ONLY for value-capturing detectors (captureValue).
      // Structural detectors (phone/SSN/credit-card) have format sub-groups that are
      // NOT the entity — extracting one there feeds e.g. an area code to the validator
      // and drops the match. For value-capturing patterns the value can land in any of
      // several alternation groups, so use the first DEFINED group.
      let groupIdx = -1;
      if (detector.captureValue) {
        for (let g = 1; g < match.length; g++) {
          if (match[g] !== undefined) { groupIdx = g; break; }
        }
      }
      const capturedGroup = groupIdx >= 0 ? match[groupIdx] : undefined;

      // Use captured group if available (for context-anchored / value-only patterns).
      // Locate it via match.indices (the `d` flag) rather than fullMatch.indexOf,
      // which mis-locates a value that also occurs inside the key (e.g. token=token123).
      let entityText = capturedGroup ?? fullMatch;
      const indices = (match as any).indices as Array<[number, number] | undefined> | undefined;
      const start = (capturedGroup !== undefined && indices && indices[groupIdx])
        ? indices[groupIdx]![0]
        : match.index;
      let end = start + entityText.length;

      // Credential values captured by a greedy `\S+` (or the Bearer char class) can
      // swallow trailing sentence punctuation — e.g. `token: <secret>.` grabs the
      // period, minting a DIFFERENT content-derived token than the same secret seen
      // as `Bearer <secret>'`. Trim trailing punctuation so one secret → one token
      // (and the punctuation stays in the surrounding text).
      if (detector.type === 'profile-username-password' && capturedGroup !== undefined) {
        const trimmed = entityText.replace(/[.,;:!?)\]}>'"]+$/, '');
        if (trimmed.length >= 4 && trimmed.length !== entityText.length) {
          end -= entityText.length - trimmed.length;
          entityText = trimmed;
        }
      }

      // URLs: mask only the ORIGIN (scheme://host[:port]), never the path/query.
      // The placeholder is URL-shaped (see ReplacementMap), so the model can still
      // compose variants (append paths, add query params) and the composed URL
      // remains unmaskable — masking the full URL made composition impossible and
      // pushed models into fabricating placeholder ids.
      if (detector.type === 'profile-url') {
        // Skip loopback/private/template URLs entirely (see isMaskableUrl).
        if (!isMaskableUrl(entityText)) {
          continue;
        }
        const originMatch = entityText.match(/^(?:(?:https?|wss?|ftps?):\/\/)?[^/?#]+/);
        if (originMatch) {
          entityText = originMatch[0];
          end = start + entityText.length;
        }
      }

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
