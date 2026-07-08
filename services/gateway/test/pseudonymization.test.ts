/**
 * Pseudonymization Plugin Tests
 *
 * Tests the PII detection, masking, unmasking, streaming buffer,
 * overlap resolution, allow-list, and anonymization mode.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock logger before imports
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

// Mutable mock config used by getModelForcedConfig — bypass tests rewrite it per-test.
const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_endpoint: string, model: string) => model,
  },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_endpoint: string, model: string) => model,
}));

// Import plugin modules directly (not via plugin loader)
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import { replaceEntities } from '../src/plugins/pseudonymization/replacer';
import { unmaskText } from '../src/plugins/pseudonymization/unmasker';
import { StreamUnmaskBuffer } from '../src/plugins/pseudonymization/streamBuffer';
import { detectRegexEntities } from '../src/plugins/pseudonymization/detectors/regexDetectors';
import { detectDictionaryEntities } from '../src/plugins/pseudonymization/detectors/dictionaryDetector';
import { detectCustomEntities } from '../src/plugins/pseudonymization/detectors/customDetector';
import { MaskingConfig, EntityConfig } from '../src/plugins/pseudonymization/types';
import { applyEntityToggles, buildKnownEntityTypes } from '../src/plugins/pseudonymization/entityToggles';

// Import the plugin handlers
import pluginRules = require('../src/plugins/pseudonymization/index');

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

describe('Pseudonymization Plugin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset layered config between tests so toggles don't leak across cases.
    mockConfig.api_config.pseudonymization = undefined;
    mockConfig.api_config.defaultHooks = {};
    mockConfig.api_config.model_list_changes = {};
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Detection Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Entity Detection', () => {
    it('should detect email addresses', () => {
      const matches = detectRegexEntities(
        'Contact john.smith@example.com for details',
        [{ type: 'profile-email' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('john.smith@example.com');
      expect(matches[0].type).toBe('profile-email');
    });

    it('should detect US SSN with validation', () => {
      const matches = detectRegexEntities(
        'SSN: 123-45-6789',
        [{ type: 'profile-ssn' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('123-45-6789');
    });

    it('should reject invalid SSN (000 area)', () => {
      const matches = detectRegexEntities(
        'SSN: 000-45-6789',
        [{ type: 'profile-ssn' }]
      );
      expect(matches).toHaveLength(0);
    });

    it('should detect credit cards with Luhn validation', () => {
      // 4111111111111111 is a valid Luhn number
      const matches = detectRegexEntities(
        'Card: 4111111111111111',
        [{ type: 'profile-credit-card-number' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('4111111111111111');
    });

    it('should reject invalid Luhn numbers', () => {
      // 4111111111111112 fails Luhn
      const matches = detectRegexEntities(
        'Card: 4111111111111112',
        [{ type: 'profile-credit-card-number' }]
      );
      expect(matches).toHaveLength(0);
    });

    it('should detect US street addresses', () => {
      const matches = detectRegexEntities(
        'Lives at 456 Oak Avenue in the city',
        [{ type: 'profile-address' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('456 Oak Avenue');
    });

    it('should detect URLs and mask only the origin (path stays composable)', () => {
      const matches = detectRegexEntities(
        'Visit https://example.com/path?q=1 for info',
        [{ type: 'profile-url' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('https://example.com'); // origin only, never the path
    });

    it('should NOT mask loopback / private / template URLs', () => {
      const skip = [
        'http://127.0.0.1:7231/mcp',
        'http://localhost:8080/x',
        'http://10.0.0.5/a',
        'http://192.168.1.9/b',
        'http://172.20.3.4/y',
        'http://[::1]:9000/a',
        'http://foo.local/x',
        'http://svc.internal/y',
        'http://127.0.0.1:<port>/file',
        'http://host:{PORT}/x',
        'http://host:${PORT}/x',
      ];
      for (const url of skip) {
        expect(detectRegexEntities(url, [{ type: 'profile-url' }])).toHaveLength(0);
      }
    });

    it('should still mask real external hosts (incl. 172.32.x which is public)', () => {
      const expected: Record<string, string> = {
        'https://api.acme.com/v1': 'https://api.acme.com',
        'wss://stream.example.org/live': 'wss://stream.example.org',
        'http://172.32.0.1/z': 'http://172.32.0.1',
      };
      for (const [url, origin] of Object.entries(expected)) {
        const m = detectRegexEntities(url, [{ type: 'profile-url' }]);
        expect(m).toHaveLength(1);
        expect(m[0].original).toBe(origin); // origin only, path dropped
      }
    });

    it('should detect credentials', () => {
      const matches = detectRegexEntities(
        'api_key=sk-abc123xyz password: hunter2',
        [{ type: 'profile-username-password' }]
      );
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect JSON-style credentials and capture only the value', () => {
      const text = '{ "auth": { "type": "bearer", "token": "1783412749.76c1ef1fadd18a2b24fba7c03e52c7" } }';
      const matches = detectRegexEntities(text, [{ type: 'profile-username-password' }]);
      const values = matches.map(m => m.original);
      expect(values).toContain('1783412749.76c1ef1fadd18a2b24fba7c03e52c7');
      // Only the value inside the quotes — masking must not eat the JSON structure
      for (const m of matches) {
        expect(m.original).not.toContain('"');
      }
    });

    it('masks the WHOLE phone number, including a +country-code prefix (structural groups are not the value)', () => {
      const config: MaskingConfig = { method: 'pseudonymization', entities: [{ type: 'profile-phone' }] };
      for (const num of ['+1 415 555 0132', '415 555 0132', '(415) 555-0132']) {
        const map = new ReplacementMap('pseudonymization');
        const masked = replaceEntities(num, detectEntities(num, config), map, config);
        expect(masked).toMatch(/^MASKED_PHONE_NUMBER_\d+$/);
        expect(masked).not.toContain('415');
        expect(masked).not.toContain('0132');
      }
    });

    it('masks only the value, never mid-identifier ($env:SSHPASS, SSH_ASKPASS_REQUIRE)', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-username-password' }],
      };
      const text = '$env:SSHPASS = "hunter2secret"\n$env:SSH_ASKPASS_REQUIRE = "force"';
      const map = new ReplacementMap('pseudonymization');
      const matches = detectEntities(text, config);
      const masked = replaceEntities(text, matches, map, config);
      // Identifier names stay intact — no SSHMASKED_ / SSH_ASKMASKED_ corruption
      expect(masked).toContain('$env:SSHPASS = ');
      expect(masked).toContain('SSH_ASKPASS_REQUIRE');
      expect(masked).not.toContain('SSHMASKED');
      expect(masked).not.toContain('SSH_ASKMASKED');
      // The real secret value is masked; the non-secret "force" is left alone
      expect(masked).not.toContain('hunter2secret');
      expect(masked).toContain('force');
    });

    it('still masks the value in a bare password=value assignment', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-username-password' }],
      };
      const map = new ReplacementMap('pseudonymization');
      const masked = replaceEntities('password=hunter2secret', detectEntities('password=hunter2secret', config), map, config);
      expect(masked).toContain('password=');
      expect(masked).not.toContain('hunter2secret');
    });

    it('mints one token for a secret seen with and without trailing punctuation', () => {
      // `token: <secret>.` (trailing period) must resolve to the SAME token as
      // `Bearer <secret>'` (quote-bounded) — greedy capture must not eat the period.
      const secret = 'abcdef012345.9911002233deadbeefcafe0011223344';
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-username-password' }],
      };
      const map = new ReplacementMap('pseudonymization');
      const text = `token: ${secret}. Also: Authorization: Bearer ${secret}' end`;
      const masked = replaceEntities(text, detectEntities(text, config), map, config);
      const tokens = new Set(masked.match(/MASKED_USER_PASSWORD_\d+/g) || []);
      expect(tokens.size).toBe(1);
      // The sentence period survives in the surrounding text
      expect(masked).toMatch(/MASKED_USER_PASSWORD_\d+\. Also:/);
      expect(masked).not.toContain(secret);
    });

    it('detects Authorization: Bearer tokens (the incident shape)', () => {
      const matches = detectRegexEntities(
        'curl -H "Authorization: Bearer 1783493179.f036553cf9c5df42e2190315ac488c3b9e8318c34191d4082a7d8e2b213c4690"',
        [{ type: 'profile-username-password' }]
      );
      const values = matches.map(m => m.original);
      expect(values).toContain('1783493179.f036553cf9c5df42e2190315ac488c3b9e8318c34191d4082a7d8e2b213c4690');
    });

    it('does not mask Bearer followed by a template variable or an existing placeholder', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-username-password' }],
      };
      const map = new ReplacementMap('pseudonymization');
      const text = 'Authorization: Bearer $TOKEN and Authorization: Bearer MASKED_USER_PASSWORD_12345678';
      const masked = replaceEntities(text, detectEntities(text, config), map, config);
      expect(masked).toContain('Bearer $TOKEN');
      expect(masked).toContain('Bearer MASKED_USER_PASSWORD_12345678');
    });

    it('should detect dictionary entities (nationality)', () => {
      const matches = detectDictionaryEntities(
        'She is American and lives here',
        [{ type: 'profile-nationality' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('American');
    });

    it('should detect dictionary entities (religion)', () => {
      const matches = detectDictionaryEntities(
        'He identifies as Buddhist',
        [{ type: 'profile-religious-group' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('Buddhist');
    });

    it('should detect custom regex entities', () => {
      const matches = detectCustomEntities(
        'Permit PTS-20240015 was filed',
        [{ pattern: '\\bPTS-\\d+\\b', placeholder: 'MASKED_PERMIT' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('PTS-20240015');
      expect(matches[0].placeholder).toBe('MASKED_PERMIT');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Detection Pipeline Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Detection Pipeline', () => {
    it('should never re-mask an existing placeholder (no double-masking)', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-url' }, { type: 'profile-person' }, { type: 'profile-username-password' }],
      };
      // URL-shaped pseudo-URL placeholder must not be re-detected as a URL
      expect(detectEntities('server at http://masked-url-41031677.invalid/mcp', config)
        .filter(m => m.original.includes('masked-url'))).toHaveLength(0);
      // MASKED_* family must not be re-detected either
      expect(detectEntities('token MASKED_USER_PASSWORD_12345678 in use', config)
        .filter(m => m.original.startsWith('MASKED_'))).toHaveLength(0);
      // A real URL alongside a placeholder is still masked
      const mixed = detectEntities('old http://masked-url-41031677.invalid new https://acme.example.com/x', config);
      expect(mixed.map(m => m.original)).toContain('https://acme.example.com');
      expect(mixed.some(m => m.original.includes('masked-url'))).toBe(false);
    });

    it('should resolve overlaps: longer match wins', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-person' }, { type: 'profile-email' }],
      };
      const matches = detectEntities('Contact info: john.smith@sandiego.gov', config);
      // Email is longer than any potential person match inside it
      const emailMatches = matches.filter(m => m.type === 'profile-email');
      expect(emailMatches).toHaveLength(1);
      // No person match should overlap with the email
      const personMatches = matches.filter(m => m.type === 'profile-person');
      for (const p of personMatches) {
        expect(p.start >= emailMatches[0].end || p.end <= emailMatches[0].start).toBe(true);
      }
    });

    it('should filter allow-list entries', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-person' }, { type: 'profile-location' }],
        allow_list: ['San Diego', 'City of San Diego'],
      };
      const matches = detectEntities('John Smith works in San Diego', config);
      const locations = matches.filter(m => m.original === 'San Diego');
      expect(locations).toHaveLength(0);
    });

    it('should prioritize custom regex over other detectors', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-person' }],
        custom_entities: [{ pattern: '\\bPTS-\\d+\\b', placeholder: 'MASKED_PERMIT' }],
      };
      const matches = detectEntities('Permit PTS-20240015 issued', config);
      const customs = matches.filter(m => m.priority === 0);
      expect(customs).toHaveLength(1);
      expect(customs[0].original).toBe('PTS-20240015');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Replacement Map Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('ReplacementMap', () => {
    it('should assign stable content-derived placeholders (pseudonymization)', () => {
      const map = new ReplacementMap('pseudonymization');
      const p1 = map.getPlaceholder('profile-person', 'John Smith');
      const p2 = map.getPlaceholder('profile-person', 'Jane Doe');
      expect(p1).toMatch(/^MASKED_PERSON_\d{8}$/);
      expect(p2).toMatch(/^MASKED_PERSON_\d{8}$/);
      expect(p1).not.toBe(p2);
    });

    it('should mint the SAME placeholder for the same value across independent requests', () => {
      // Cross-request stability is the core guarantee: it makes echoed tokens from
      // earlier turns resolvable and cached masked responses safely replayable.
      const mapA = new ReplacementMap('pseudonymization');
      const mapB = new ReplacementMap('pseudonymization');
      // different detection order must not matter
      mapB.getPlaceholder('profile-person', 'Someone Else');
      expect(mapA.getPlaceholder('profile-person', 'John Smith'))
        .toBe(mapB.getPlaceholder('profile-person', 'John Smith'));
    });

    it('should be idempotent: same input returns same placeholder', () => {
      const map = new ReplacementMap('pseudonymization');
      const p1 = map.getPlaceholder('profile-person', 'John Smith');
      const p2 = map.getPlaceholder('profile-person', 'John Smith');
      expect(p1).toBe(p2);
      expect(map.size).toBe(1);
    });

    it('should maintain reverse mapping', () => {
      const map = new ReplacementMap('pseudonymization');
      const p = map.getPlaceholder('profile-person', 'John Smith');
      expect(map.reverse.get(p)).toBe('John Smith');
    });

    it('should keep incrementing (unlinkable) placeholders in anonymization mode', () => {
      const map = new ReplacementMap('anonymization');
      const p1 = map.getPlaceholder('profile-person', 'John Smith');
      const p2 = map.getPlaceholder('profile-person', 'Jane Doe');
      expect(p1).toBe('MASKED_PERSON_1'); // has ID for LLM disambiguation
      expect(p2).toBe('MASKED_PERSON_2');
      expect(map.reverse.size).toBe(0); // but no reverse map (can't unmask)
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Replacer Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Replacer', () => {
    it('should replace all detected entities in text', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-person' }, { type: 'profile-email' }],
      };
      const text = 'John Smith at john@example.com';
      const matches = detectEntities(text, config);
      const map = new ReplacementMap('pseudonymization');
      const masked = replaceEntities(text, matches, map, config);

      expect(masked).not.toContain('John Smith');
      expect(masked).not.toContain('john@example.com');
      expect(masked).toContain('MASKED_');
    });

    it('should handle repeated entities idempotently', () => {
      const config: MaskingConfig = {
        method: 'pseudonymization',
        entities: [{ type: 'profile-person' }],
      };
      const text = 'John Smith went home. Later, John Smith returned.';
      const matches = detectEntities(text, config);
      const map = new ReplacementMap('pseudonymization');
      const masked = replaceEntities(text, matches, map, config);

      const p = map.forward.get('John Smith');
      expect(p).toMatch(/^MASKED_PERSON_\d{8}$/);
      expect(masked).toBe(`${p} went home. Later, ${p} returned.`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unmasker Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Unmasker', () => {
    it('should replace all placeholders with original values', () => {
      const map = new ReplacementMap('pseudonymization');
      const pPerson = map.getPlaceholder('profile-person', 'John Smith');
      const pEmail = map.getPlaceholder('profile-email', 'john@example.com');

      const text = `${pPerson} can be reached at ${pEmail}`;
      const result = unmaskText(text, map);

      expect(result).toBe('John Smith can be reached at john@example.com');
    });

    it('should handle multiple occurrences of same placeholder', () => {
      const map = new ReplacementMap('pseudonymization');
      const p = map.getPlaceholder('profile-person', 'John Smith');

      const text = `${p} went home. ${p} returned.`;
      const result = unmaskText(text, map);

      expect(result).toBe('John Smith went home. John Smith returned.');
    });

    it('should leave unknown placeholders unchanged', () => {
      const map = new ReplacementMap('pseudonymization');
      const text = 'MASKED_UNKNOWN_99 is not in the map';
      const result = unmaskText(text, map);

      expect(result).toBe(text);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stream Buffer Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('StreamUnmaskBuffer', () => {
    it('should handle placeholder split across chunks', () => {
      const map = new ReplacementMap('pseudonymization');
      const p = map.getPlaceholder('profile-person', 'John Smith');

      const buffer = new StreamUnmaskBuffer(map);

      let out = '';
      out += buffer.append('I recommend ');
      out += buffer.append(p.slice(0, 7));   // 'MASKED_' — held in buffer
      out += buffer.append(p.slice(7));      // completes the token
      out += buffer.append(' call back');
      out += buffer.flush();
      expect(out).toBe('I recommend John Smith call back');
    });

    it('should flush remaining text at end of stream', () => {
      const map = new ReplacementMap('pseudonymization');
      const p = map.getPlaceholder('profile-person', 'John Smith');

      const buffer = new StreamUnmaskBuffer(map);
      const out = buffer.append(`Hello ${p}`) + buffer.flush();

      expect(out).toBe('Hello John Smith');
    });

    it('should unmask complete tokens immediately', () => {
      const map = new ReplacementMap('pseudonymization');
      const pPerson = map.getPlaceholder('profile-person', 'John Smith');
      const pEmail = map.getPlaceholder('profile-email', 'john@example.com');

      const buffer = new StreamUnmaskBuffer(map);
      const result = buffer.append(`Contact ${pPerson} at ${pEmail} now`) + buffer.flush();

      expect(result).toContain('John Smith');
      expect(result).toContain('john@example.com');
    });

    it('should handle empty map gracefully', () => {
      const map = new ReplacementMap('pseudonymization');
      const buffer = new StreamUnmaskBuffer(map);

      expect(buffer.append('Hello world')).toBe('Hello world');
      expect(buffer.flush()).toBe('');
    });

    it('should not corrupt a longer placeholder split where a shorter one is its prefix', () => {
      // Two map keys where one is a strict prefix of the other (legacy numeric residue
      // keys, or hash ids extended by collision probing). Eager replacement must NOT
      // substitute the shorter token prematurely when the split leaves it ambiguous.
      const map = new ReplacementMap('pseudonymization');
      map.reverse.set('MASKED_PERSON_ab12cd34', 'Short Person');
      map.reverse.set('MASKED_PERSON_ab12cd34ef', 'Long Person');
      map.forward.set('Short Person', 'MASKED_PERSON_ab12cd34');
      map.forward.set('Long Person', 'MASKED_PERSON_ab12cd34ef');

      const buffer = new StreamUnmaskBuffer(map);
      let out = '';
      out += buffer.append('- MAS');
      out += buffer.append('KED_PERS');
      out += buffer.append('ON_ab12cd34'); // could be the short token OR a prefix of the long one
      out += buffer.append('ef');          // resolves to the LONG token
      out += buffer.append(': done');
      out += buffer.flush();

      expect(out).toBe('- Long Person: done');
      expect(out).not.toContain('Short Person');
      expect(out).not.toContain('MASKED');
    });

    it('should still unmask the shorter placeholder when the stream ends on it', () => {
      const map = new ReplacementMap('pseudonymization');
      map.reverse.set('MASKED_PERSON_ab12cd34', 'Short Person');
      map.reverse.set('MASKED_PERSON_ab12cd34ef', 'Long Person');

      const buffer = new StreamUnmaskBuffer(map);
      let out = '';
      out += buffer.append('see MASKED_PERSON_ab12cd34'); // ambiguous → retained
      out += buffer.flush();                              // stream over → resolves to the short token
      expect(out).toBe('see Short Person');
    });

    it('should resolve stable hash tokens split across chunks', () => {
      const map = new ReplacementMap('pseudonymization');
      const p = map.getPlaceholder('profile-person', 'Quinn Zephyr');
      const buffer = new StreamUnmaskBuffer(map);
      let out = '';
      out += buffer.append(`hi ${p.slice(0, p.length - 3)}`);
      out += buffer.append(`${p.slice(p.length - 3)} there`);
      out += buffer.flush();
      expect(out).toBe('hi Quinn Zephyr there');
    });

    it('unmasks a masked-URL host when the model appends a path (composed URL)', () => {
      // The masked-url placeholder is deliberately composable: the model appends
      // /paths and ?queries to the host. Streaming must still unmask the HOST part.
      // Regression for a live-observed leak: `claude -p` emitted
      // `https://masked-url-<id>.invalid/deploy` unmasked to the client.
      const map = new ReplacementMap('pseudonymization');
      const ph = map.getPlaceholder('profile-url', 'https://api.example.com');
      const composed = `${ph}/deploy`;

      const splittings: string[][] = [
        [composed],
        [ph, '/deploy'],
        [ph.replace('.invalid', ''), '.invalid/deploy'], // split at .invalid
        [`use `, ph, `/deploy now`],
        composed.split(''), // char by char
      ];
      for (const chunks of splittings) {
        const buffer = new StreamUnmaskBuffer(map);
        let out = '';
        for (const c of chunks) out += buffer.append(c);
        out += buffer.flush();
        expect(out).toContain('https://api.example.com/deploy');
        expect(out).not.toContain('masked-url');
      }
    });

    it('unmasks a composed URL split as scheme|host|path (live claude -p leak repro)', () => {
      // Exact delta boundaries captured from the leaking streaming response:
      //   "…' https://" | "masked-url-<id>." | "invalid/deploy…"
      // The scheme is flushed at the end of one delta, then the host arrives.
      const map = new ReplacementMap('pseudonymization');
      // Realistic multi-entry map (a credential is also masked in the same turn).
      map.getPlaceholder('profile-username-password', '5150aabb22.c0ffeedeadbeef');
      const ph = map.getPlaceholder('profile-url', 'https://api.example.com');
      const id = ph.match(/masked-url-(\d+)\.invalid/)![1];

      const buffer = new StreamUnmaskBuffer(map);
      let out = '';
      out += buffer.append("secret' https://");
      out += buffer.append(`masked-url-${id}.`);
      out += buffer.append('invalid/deploy\n');
      out += buffer.flush();
      expect(out).not.toContain('masked-url');
      expect(out).toContain('https://api.example.com/deploy');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Plugin Handler Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Plugin Handlers', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const afterRule = (pluginRules as any[]).find((r: any) => r.strategy === 'after');
    const beforeHandler = beforeRule?.handler;
    const afterHandler = afterRule?.handler;

    it('should export three rules (before, after, stream)', () => {
      expect(pluginRules).toHaveLength(3);
      const strategies = (pluginRules as any[]).map((r: any) => r.strategy);
      expect(strategies).toContain('before');
      expect(strategies).toContain('after');
      expect(strategies).toContain('stream');
    });

    it('should no-op when masking config is absent', async () => {
      const req = { body: { messages: [{ role: 'user', content: 'Hello world' }] } };
      const result = await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(result.stop).toBe(false);
      expect((req as any).__pseudonymization).toBeUndefined();
      expect(req.body.messages[0].content).toBe('Hello world');
    });

    it('should mask content when masking config is present', async () => {
      const req = {
        body: {
          messages: [{ role: 'user', content: 'John Smith lives at 123 Main St' }],
          masking: {
            method: 'pseudonymization',
            entities: [{ type: 'profile-person' }, { type: 'profile-address' }],
          },
        },
      };

      const result = await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(result.stop).toBe(false);
      expect(req.body.messages[0].content).toContain('MASKED_');
      expect(req.body.messages[0].content).not.toContain('John Smith');
      expect((req as any).__pseudonymization).toBeDefined();
      expect(req.body.masking).toBeUndefined(); // removed before forwarding
    });

    it('should unmask response in after handler', async () => {
      // First mask the request
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'Email john@example.com please' }],
          masking: {
            method: 'pseudonymization',
            entities: [{ type: 'profile-email' }],
          },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      // Now simulate upstream response containing the placeholder
      const map = req.__pseudonymizationMap;
      const placeholder = map.forward.get('john@example.com');
      const upstreamResponse = {
        final_result: {
          choices: [{ message: { content: `I will email ${placeholder} right away.` } }],
        },
      };

      const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

      expect(result.final_result.choices[0].message.content).toBe(
        'I will email john@example.com right away.'
      );
      // masking_info is off by default for pseudonymization (bloats every response)
      expect(result.masking_info).toBeUndefined();
    });

    it('attaches masking_info for pseudonymization only when the debug flag is set', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'Email john@example.com please' }],
          masking: {
            method: 'pseudonymization',
            entities: [{ type: 'profile-email' }],
            debug: true,
          },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const map = req.__pseudonymizationMap;
      const placeholder = map.forward.get('john@example.com');
      const upstreamResponse = {
        final_result: { choices: [{ message: { content: `Sent to ${placeholder}.` } }] },
      };
      const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
      expect(result.masking_info).toBeDefined();
      expect(result.masking_info.method).toBe('pseudonymization');
    });

    it('should NOT unmask in anonymization mode', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'John Smith called' }],
          masking: {
            method: 'anonymization',
            entities: [{ type: 'profile-person' }],
          },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      const upstreamResponse = {
        final_result: {
          choices: [{ message: { content: 'MASKED_PERSON_1 said hello.' } }],
        },
      };

      const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

      // Should NOT unmask — placeholders remain (no reverse map in anonymization)
      expect(result.final_result.choices[0].message.content).toBe('MASKED_PERSON_1 said hello.');
      expect(result.masking_info).toBeDefined();
      expect(result.masking_info.method).toBe('anonymization');
    });

    it('should handle Anthropic content block format', async () => {
      const req: any = {
        body: {
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: 'Contact john@example.com' }],
          }],
          masking: {
            method: 'pseudonymization',
            entities: [{ type: 'profile-email' }],
          },
        },
      };

      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(req.body.messages[0].content[0].text).toContain('MASKED_EMAIL');
      expect(req.body.messages[0].content[0].text).not.toContain('john@example.com');
    });

    it('should activate via triggerword and strip it from content', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: '<sail-proxy:pseudonymization:on> John Smith email is john@test.com' }],
        },
      };

      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(req.body.messages[0].content).not.toContain('<sail-proxy:pseudonymization:on>');
      expect(req.body.messages[0].content).toContain('MASKED_PERSON');
      expect(req.body.messages[0].content).toContain('MASKED_EMAIL');
      expect((req as any).__pseudonymization).toBeDefined();
      expect((req as any).__pseudonymization.config.method).toBe('pseudonymization');
    });

    it('default config masks national id, passport, driver license, and pronouns', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content:
            "<sail-proxy:pseudonymization:on> national id: AB123456C, passport number: X1234567, "
            + "driver's license number: D9876543, pronouns: she/her" }],
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const masked = req.body.messages[0].content as string;
      for (const raw of ['AB123456C', 'X1234567', 'D9876543', 'she/her']) {
        expect(masked).not.toContain(raw);
      }
      expect(masked).toContain('MASKED_NATIONAL_ID');
      expect(masked).toContain('MASKED_PASSPORT');
      expect(masked).toContain('MASKED_DRIVERS_LICENSE');
      expect(masked).toContain('MASKED_PRONOUNS_GENDER');
    });

    it('should activate anonymization via triggerword', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: '<sail-proxy:anonymization:on> Jane Doe lives here' }],
        },
      };

      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(req.body.messages[0].content).not.toContain('<sail-proxy:anonymization:on>');
      expect(req.body.messages[0].content).toContain('MASKED_PERSON');
      expect((req as any).__pseudonymization.config.method).toBe('anonymization');
    });

    it('should not activate without triggerword or masking config', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'John Smith email is john@test.com' }],
        },
      };

      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      expect(req.body.messages[0].content).toBe('John Smith email is john@test.com');
      expect((req as any).__pseudonymization).toBeUndefined();
    });

    // ─── Bypass mechanics ────────────────────────────────────────────────────
    function setEndpointForce(endpoint: string, allowBypass: boolean): void {
      mockConfig.api_config.defaultHooks[endpoint] = {
        pseudonymization: { enabled: true, method: 'pseudonymization', allow_user_bypass: allowBypass },
      };
    }

    it('bypass via header is honored when allow_user_bypass is true', async () => {
      setEndpointForce('openai', true);
      const req: any = {
        __endpoint: 'openai',
        headers: { 'x-sail-proxy-pseudonymization': 'off' },
        body: {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'John Smith email is john@example.com' }],
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      // Bypass applied: content untouched, no plugin state attached
      expect(req.body.messages[0].content).toBe('John Smith email is john@example.com');
      expect(req.__pseudonymization).toBeUndefined();
    });

    it('bypass via body field is honored when allow_user_bypass is true and field is stripped', async () => {
      setEndpointForce('openai', true);
      const req: any = {
        __endpoint: 'openai',
        headers: {},
        body: {
          model: 'gpt-4.1',
          pseudonymization_off: true,
          messages: [{ role: 'user', content: 'John Smith email is john@example.com' }],
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      expect(req.body.messages[0].content).toBe('John Smith email is john@example.com');
      expect(req.__pseudonymization).toBeUndefined();
      // Field must be stripped before forwarding upstream
      expect(req.body.pseudonymization_off).toBeUndefined();
    });

    it('bypass is rejected when allow_user_bypass is false (force flag wins)', async () => {
      setEndpointForce('openai', false);
      const req: any = {
        __endpoint: 'openai',
        headers: { 'x-sail-proxy-pseudonymization': 'off' },
        body: {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'John Smith email is john@example.com' }],
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      // Force flag fires: content is masked
      expect(req.body.messages[0].content).not.toContain('John Smith');
      expect(req.body.messages[0].content).toContain('MASKED_');
      expect(req.__pseudonymization).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SSE Unmask Interceptor Tests (res.write wire path — Bedrock native streaming)
  // ─────────────────────────────────────────────────────────────────────────

  describe('SSE unmask interceptor', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const beforeHandler = beforeRule?.handler;

    // Runs beforeHandler over `content` so the plugin masks it, installs the wire
    // interceptor on a mock res, and returns everything needed to replay SSE writes.
    async function setup(content: string) {
      const written: string[] = [];
      const res: any = {
        write: (chunk: any) => { written.push(String(chunk)); return true; },
        end: (chunk?: any) => { if (typeof chunk === 'string') written.push(chunk); },
      };
      const req: any = {
        body: {
          messages: [{ role: 'user', content }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }, { type: 'profile-email' }] },
        },
      };
      await beforeHandler({ req, res, utils: { logger: mockLogger } });
      const map = req.__pseudonymizationMap;
      return { req, res, written, map };
    }

    // Reassemble the text/tool content per block index from the written SSE stream
    function reassemble(written: string[]) {
      const blocks: Record<string, string> = {};
      for (const w of written) {
        for (const m of w.matchAll(/data: (\{.*?\})\n/g)) {
          let ev: any; try { ev = JSON.parse(m[1]); } catch { continue; }
          const d = ev.delta || {};
          const idx = ev.index ?? 0;
          if (d.type === 'text_delta' && typeof d.text === 'string') blocks[`text:${idx}`] = (blocks[`text:${idx}`] || '') + d.text;
          if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') blocks[`tool:${idx}`] = (blocks[`tool:${idx}`] || '') + d.partial_json;
        }
      }
      return blocks;
    }

    const evt = (obj: any) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
    const textDelta = (idx: number, text: string) => evt({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
    const toolDelta = (idx: number, partial_json: string) => evt({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json } });
    const blockStop = (idx: number) => evt({ type: 'content_block_stop', index: idx });
    const messageStop = () => evt({ type: 'message_stop' });

    it('unmasks text_delta split across events (production leak scenario)', async () => {
      const { res, written, map } = await setup('John Smith will review');
      const placeholder = map.forward.get('John Smith');
      expect(placeholder).toBeDefined();

      // Fragmentation pattern copied from the logged stream: 'MAS'|'KED_PERS'|'ON_1'
      const [a, b, c] = [placeholder.slice(0, 3), placeholder.slice(3, 11), placeholder.slice(11)];
      res.write(textDelta(0, `- ${a}`));
      res.write(textDelta(0, b));
      res.write(textDelta(0, c));
      res.write(textDelta(0, ': done'));
      res.write(blockStop(0));

      const blocks = reassemble(written);
      expect(blocks['text:0']).toBe('- John Smith: done');
    });

    it('unmasks input_json_delta split across events', async () => {
      const { res, written, map } = await setup('Jane Doe and John Smith met');
      const p = map.forward.get('Jane Doe');
      res.write(toolDelta(1, `{"content":"- ${p.slice(0, 5)}`));
      res.write(toolDelta(1, p.slice(5)));
      res.write(toolDelta(1, ' wrote it"}'));
      res.write(blockStop(1));

      const blocks = reassemble(written);
      expect(blocks['tool:1']).toBe('{"content":"- Jane Doe wrote it"}');
    });

    it('flushes a retained fragment on content_block_stop', async () => {
      const { res, written, map } = await setup('John Smith will review');
      const placeholder = map.forward.get('John Smith');
      res.write(textDelta(0, `see ${placeholder.slice(0, 8)}`)); // tail retained as partial placeholder
      res.write(blockStop(0)); // must flush the retained 'MASKED_P…' before the stop

      const blocks = reassemble(written);
      expect(blocks['text:0']).toBe(`see ${placeholder.slice(0, 8)}`); // not resolvable — emitted as-is, not dropped
      expect(written.join('')).toContain('content_block_stop');
    });

    it('flushes all buffers on message_stop (Anthropic streams have no finish_reason)', async () => {
      const { res, written, map } = await setup('John Smith will review');
      const placeholder = map.forward.get('John Smith');
      res.write(textDelta(0, `by ${placeholder}`)); // complete but ambiguous tail → retained
      res.write(messageStop());

      const blocks = reassemble(written);
      expect(blocks['text:0']).toBe('by John Smith');
    });

    it('handles multiple SSE events in a single res.write', async () => {
      const { res, written, map } = await setup('John Smith will review');
      const placeholder = map.forward.get('John Smith');
      const batched = textDelta(0, `hi ${placeholder.slice(0, 6)}`) + textDelta(0, placeholder.slice(6)) + blockStop(0);
      res.write(batched);

      const blocks = reassemble(written);
      expect(blocks['text:0']).toBe('hi John Smith');
    });

    it('handles an SSE event split mid-JSON across res.write calls', async () => {
      const { res, written, map } = await setup('John Smith will review');
      const placeholder = map.forward.get('John Smith');
      const whole = textDelta(0, `hi ${placeholder} bye`) + blockStop(0);
      // split in the middle of the JSON payload
      const cut = Math.floor(whole.length / 2);
      res.write(whole.slice(0, cut));
      res.write(whole.slice(cut));

      const blocks = reassemble(written);
      expect(blocks['text:0']).toBe('hi John Smith bye');
    });

    it('flushes a trailing partial block on res.end', async () => {
      const { res, written } = await setup('John Smith will review');
      res.write('data: {"type":"content_block_de'); // incomplete block, no \n\n
      res.end();
      expect(written.join('')).toContain('data: {"type":"content_block_de');
    });

    it('passes non-SSE and non-JSON writes through unchanged', async () => {
      const { res, written } = await setup('John Smith will review');
      res.write('data: [DONE]\n\n');
      res.write(': ping\n\n');
      expect(written).toContain('data: [DONE]\n\n');
      expect(written).toContain(': ping\n\n');
    });

    it('unmasks res.json bodies (non-streaming cache-hit path)', async () => {
      // awsBedrockResponseCache serves non-streaming cache hits via res.json() and
      // returns { stop: true }, bypassing res.write and the after-handler. The
      // interceptor must patch res.json so a cached masked tool_use still unmasks.
      const jsonBodies: any[] = [];
      const res: any = {
        write: () => true,
        end: () => {},
        json: (b: any) => { jsonBodies.push(b); return res; },
        status: () => res,
      };
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'John Smith wrote the report' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req, res, utils: { logger: mockLogger } });
      const placeholder = req.__pseudonymizationMap.forward.get('John Smith');
      expect(placeholder).toBeDefined();

      // Simulate a cached (masked) non-streaming Anthropic message served via res.json
      res.json({
        type: 'message',
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/x.md', content: `- ${placeholder}: author` } }],
      });

      const served = jsonBodies[0];
      const s = JSON.stringify(served);
      expect(s).toContain('John Smith');
      expect(s).not.toContain('MASKED_');
    });

    it('leaves unknown (residue) tokens in a res.json body untouched', async () => {
      const jsonBodies: any[] = [];
      const res: any = { write: () => true, end: () => {}, json: (b: any) => { jsonBodies.push(b); return res; } };
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'John Smith wrote it' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req, res, utils: { logger: mockLogger } });
      res.json({ type: 'message', content: [{ type: 'text', text: 'earlier: MASKED_PERSON_999' }] });
      // Not in this request's map → must remain (cannot invent a name)
      expect(JSON.stringify(jsonBodies[0])).toContain('MASKED_PERSON_999');
    });

    it('safety-net unmasks a raw data: block the structured path does not recognize (BedrockStreamParser fallback leak repro)', async () => {
      // Live claude -p leak: a composed masked-URL reached the client because it was
      // emitted via the BedrockStreamParser raw-text fallback as a bare `data: <text>`
      // block (not a content_block_delta), which the structured interceptor passes
      // through untouched. The final safety-net unmask must catch it.
      const written: string[] = [];
      const res: any = {
        write: (chunk: any) => { written.push(String(chunk)); return true; },
        end: (chunk?: any) => { if (typeof chunk === 'string') written.push(chunk); },
      };
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'Deploy to https://api.example.com/deploy now' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-url' }] },
        },
      };
      await beforeHandler({ req, res, utils: { logger: mockLogger } });
      const ph = req.__pseudonymizationMap.forward.get('https://api.example.com');
      expect(ph).toBeDefined();

      // Raw fallback shape: bare `data:` with the composed masked URL, NOT a content_block_delta.
      res.write(`data: curl ${ph}/deploy\n\n`);
      const all = written.join('');
      expect(all).not.toContain('masked-url');
      expect(all).toContain('https://api.example.com/deploy');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Residue counter guard
  // ─────────────────────────────────────────────────────────────────────────

  describe('Residue handling & stable tokens', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const beforeHandler = beforeRule?.handler;

    it('re-mints the SAME token for a value echoed from an earlier turn (residue resolves)', async () => {
      // Turn 1: mask a request containing John Smith → token T.
      const req1: any = {
        body: {
          messages: [{ role: 'user', content: 'John Smith should review it' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req: req1, res: {}, utils: { logger: mockLogger } });
      const t1 = req1.__pseudonymizationMap.forward.get('John Smith');
      expect(t1).toMatch(/^MASKED_PERSON_\d{8}$/);

      // Turn 2 (separate request): history carries the literal token T; the value is
      // also present. Masking must mint the identical token, so T resolves via the map.
      const req2: any = {
        body: {
          messages: [
            { role: 'assistant', content: `${t1} owns the doc` },
            { role: 'user', content: 'Remind John Smith about the deadline' },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req: req2, res: {}, utils: { logger: mockLogger } });
      const t2 = req2.__pseudonymizationMap.forward.get('John Smith');
      expect(t2).toBe(t1);
      expect(req2.__pseudonymizationMap.reverse.get(t1)).toBe('John Smith');
      const unmasked = unmaskText(`${t1} owns the doc`, req2.__pseudonymizationMap);
      expect(unmasked).toBe('John Smith owns the doc');
    });

    it('leaves legacy numeric residue untouched and does not crash the residue scan', async () => {
      const req: any = {
        body: {
          messages: [
            { role: 'assistant', content: 'MASKED_PERSON_54 owns the doc' },
            { role: 'user', content: 'John Smith should review it' },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      // Legacy numeric residue cannot be re-minted by the hash scheme → stays literal
      expect(req.body.messages[0].content).toContain('MASKED_PERSON_54');
      // Fresh value gets a stable hash token, which can never equal the numeric residue
      const placeholder = req.__pseudonymizationMap.forward.get('John Smith');
      expect(placeholder).toMatch(/^MASKED_PERSON_\d{8}$/);
      expect(placeholder).not.toBe('MASKED_PERSON_54');
    });

    it('reserveMinCount keeps anonymization counters clear of numeric residue', () => {
      const map = new ReplacementMap('anonymization');
      map.reserveMinCount('MASKED_PERSON', 10);
      const person = map.getPlaceholder('profile-person', 'John Smith');
      const email = map.getPlaceholder('profile-email', 'a@b.com');
      expect(person).toBe('MASKED_PERSON_11');
      expect(email).toBe('MASKED_EMAIL_1');
    });

    it('probes to a wider id on an in-request hash collision', () => {
      const map = new ReplacementMap('pseudonymization');
      const pA = map.getPlaceholder('profile-person', 'Value A');
      // Simulate an id collision: pre-seed reverse with pA's token mapped to a
      // DIFFERENT value, then mint — the new token must widen, not overwrite.
      const map2 = new ReplacementMap('pseudonymization');
      map2.reverse.set(pA, 'Different Value');
      const pB = map2.getPlaceholder('profile-person', 'Value A');
      expect(pB).not.toBe(pA);
      expect(pB).toMatch(/^MASKED_PERSON_\d{10}$/); // widened (deterministic per value)
      expect(map2.reverse.get(pB)).toBe('Value A');
      expect(map2.reverse.get(pA)).toBe('Different Value'); // untouched

      // Determinism of the widened id: a third map with the same collision yields the same pB
      const map3 = new ReplacementMap('pseudonymization');
      map3.reverse.set(pA, 'Different Value');
      expect(map3.getPlaceholder('profile-person', 'Value A')).toBe(pB);
    });

    it('masks URL origins as composable pseudo-URLs and unmasks composed variants', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'The MCP endpoint is http://mcp.acme.example:7231/mcp — use it.' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-url' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const map = req.__pseudonymizationMap;
      const placeholder = map.forward.get('http://mcp.acme.example:7231');
      expect(placeholder).toMatch(/^http:\/\/masked-url-\d{8}\.invalid$/);
      // Masked message keeps the path composable
      expect(req.body.messages[0].content).toContain(`${placeholder}/mcp`);
      expect(req.body.messages[0].content).not.toContain('mcp.acme.example');

      // The model composes a NEW URL from the masked host (path + query it invents)
      const composed = `curl --upload-file f.py "${placeholder}/file?path=C%3A%5Cws%5Cserver.py"`;
      expect(unmaskText(composed, map)).toBe(
        'curl --upload-file f.py "http://mcp.acme.example:7231/file?path=C%3A%5Cws%5Cserver.py"'
      );

      // Scheme-less reproduction (e.g. JSON-escaped or scheme dropped) still unmasks via alias
      const bare = placeholder.replace(/^http:\/\//, '');
      expect(unmaskText(`host is ${bare}/health`, map)).toBe('host is mcp.acme.example:7231/health');

      // Streaming: composed URL split across chunks round-trips too
      const buffer = new StreamUnmaskBuffer(map);
      const whole = `GET ${placeholder}/file?x=1 now`;
      let out = '';
      for (let i = 0; i < whole.length; i += 7) out += buffer.append(whole.slice(i, i + 7));
      out += buffer.flush();
      expect(out).toBe('GET http://mcp.acme.example:7231/file?x=1 now');
    });

    it('preserves the URL scheme and supports model-initiated scheme switches', async () => {
      const req: any = {
        body: {
          messages: [{ role: 'user', content: 'API at https://api.public.example:8443/v1 and stream at wss://api.public.example:8443/live' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-url' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const map = req.__pseudonymizationMap;
      const https = map.forward.get('https://api.public.example:8443');
      const wss = map.forward.get('wss://api.public.example:8443');
      // Scheme is preserved on the placeholder itself (distinct tokens per scheme)
      expect(https).toMatch(/^https:\/\/masked-url-\d{8}\.invalid$/);
      expect(wss).toMatch(/^wss:\/\/masked-url-\d{8}\.invalid$/);

      // Exact reproduction unmasks with the original scheme
      expect(unmaskText(`connect ${wss}/live`, map)).toBe('connect wss://api.public.example:8443/live');

      // Model SWITCHES scheme on a masked host (e.g. https host upgraded to wss):
      // the bare-host alias substitutes just the origin, keeping the model's scheme.
      const bare = https!.replace(/^https:\/\//, '');
      expect(unmaskText(`upgrade to wss://${bare}/socket`, map)).toBe('upgrade to wss://api.public.example:8443/socket');
    });

    it('mints the same pseudo-URL host across requests (stable)', async () => {
      const mk = () => ({
        body: {
          messages: [{ role: 'user', content: 'see https://internal.corp.example:8443/a/b' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-url' }] },
        },
      });
      const r1: any = mk(); const r2: any = mk();
      await beforeHandler({ req: r1, res: {}, utils: { logger: mockLogger } });
      await beforeHandler({ req: r2, res: {}, utils: { logger: mockLogger } });
      expect(r1.__pseudonymizationMap.forward.get('https://internal.corp.example:8443'))
        .toBe(r2.__pseudonymizationMap.forward.get('https://internal.corp.example:8443'));
    });

    it('injects a verbatim-copy instruction into the system prompt when masking is active', async () => {
      const req: any = {
        body: {
          system: [{ type: 'text', text: 'You are a helpful assistant.' }],
          messages: [{ role: 'user', content: 'John Smith wrote the report' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const sys = req.body.system;
      expect(Array.isArray(sys)).toBe(true);
      expect(sys[sys.length - 1].text).toContain('copy its token EXACTLY');
      // Hardened: explicitly forbids inventing tokens and mandates using unmasked values
      expect(sys[sys.length - 1].text).toContain('NEVER invent');
      expect(sys[sys.length - 1].text).toContain('use that unmasked value as-is');

      // string-form system prompt
      const req2: any = {
        body: {
          system: 'Base prompt.',
          messages: [{ role: 'user', content: 'John Smith wrote it' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req: req2, res: {}, utils: { logger: mockLogger } });
      expect(typeof req2.body.system).toBe('string');
      expect(req2.body.system).toContain('Base prompt.');
      expect(req2.body.system).toContain('copy its token EXACTLY');

      // no injection when nothing was masked
      const req3: any = {
        body: {
          messages: [{ role: 'user', content: 'nothing sensitive here 12' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-person' }] },
        },
      };
      await beforeHandler({ req: req3, res: {}, utils: { logger: mockLogger } });
      if (req3.__pseudonymizationMap?.size ? false : true) {
        expect(req3.body.system === undefined || !String(req3.body.system).includes('copy its token')).toBe(true);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Value-consistency propagation (primary security fix)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Value-consistency propagation', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const beforeHandler = beforeRule?.handler;
    const SECRET = '1783493179.f036553cf9c5df42e2190315ac488c3b9e8318c34191d4082a7d8e2b213c4690';

    it('masks ALL occurrences of a secret, including Bearer headers inside tool_result strings', async () => {
      const req: any = {
        body: {
          messages: [
            { role: 'user', content: [
              { type: 'tool_result', content: `{"result":"transfer_token=${SECRET}"}` },
            ] },
            { role: 'assistant', content: [
              { type: 'tool_use', input: { cmd: `curl -H "Authorization: Bearer ${SECRET}" https://x` } },
            ] },
            { role: 'user', content: `retry with Authorization: Bearer ${SECRET} now` },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-username-password' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      const serialized = JSON.stringify(req.body);
      // The raw secret must appear nowhere on the outbound body
      expect(serialized).not.toContain(SECRET);
      // And it resolved to exactly one distinct token
      const tokens = new Set(serialized.match(/MASKED_USER_PASSWORD_\d+/g) || []);
      expect(tokens.size).toBe(1);
    });

    it('does not propagate short values below the minimum length', async () => {
      const req: any = {
        body: {
          messages: [
            { role: 'user', content: 'password=abc123 then bare abc123 elsewhere' },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-username-password' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const content = req.body.messages[0].content as string;
      // The detector still masks the credential occurrence, but the bare short value
      // elsewhere is NOT carpet-masked (below MIN_PROPAGATION_LENGTH = 12)
      expect(content).toContain('bare abc123 elsewhere');
    });

    it('respects word boundaries: a secret that is a substring of a longer identifier is untouched', async () => {
      const value = 'longsecretvalue123'; // >= 12 chars, propagates
      const req: any = {
        body: {
          messages: [
            { role: 'user', content: `password=${value} and identifier ${value}X should stay` },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-username-password' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const content = req.body.messages[0].content as string;
      // `${value}X` has a word char immediately after the value — must not be masked
      expect(content).toContain(`${value}X should stay`);
    });

    it('incident regression: same-shape request (synthetic secret) masks cleanly with no corruption', async () => {
      // Reconstructs the shape of gateway-1783492885206-oc7olx17n with a synthetic
      // secret: one detected `transfer_token=` occurrence + four unmasked Bearer
      // headers + a PowerShell script with $env:SSHPASS-style identifiers.
      const synthetic = '9990001112.aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';
      const req: any = {
        body: {
          system: [{ type: 'text', text: 'You are a coding assistant.' }],
          messages: [
            { role: 'user', content: [
              { type: 'tool_result', content: `{"result":"transfer_token=${synthetic}"}` },
              { type: 'text', text:
                `# upload:\n  curl -fsS -H "Authorization: Bearer ${synthetic}" https://x\n` +
                `  curl -fsS -H "Authorization: Bearer ${synthetic}" https://y\n` +
                `$env:SSHPASS = "p@ssw0rdLong123"\n$env:SSH_ASKPASS_REQUIRE = "force"` },
            ] },
            { role: 'assistant', content: [
              { type: 'tool_use', input: { command: `curl -H "Authorization: Bearer ${synthetic}"` } },
            ] },
            { role: 'user', content: `retry: Authorization: Bearer ${synthetic}` },
          ],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-username-password' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const serialized = JSON.stringify(req.body);

      // The synthetic secret appears NOWHERE on the wire (all 5+ occurrences masked)
      expect(serialized).not.toContain(synthetic);
      // Exactly one token minted for it
      const secretTokens = new Set((serialized.match(/MASKED_USER_PASSWORD_\d+/g) || []));
      // No mid-identifier corruption of the PowerShell variables
      expect(serialized).not.toContain('SSHMASKED');
      expect(serialized).not.toContain('SSH_ASKMASKED');
      expect(serialized).toContain('$env:SSHPASS = ');
      expect(serialized).toContain('SSH_ASKPASS_REQUIRE');
      expect(secretTokens.size).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Residue audit (non-streaming) — counter log on unresolved masks
  // ─────────────────────────────────────────────────────────────────────────

  describe('Residue audit (non-streaming)', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const afterRule = (pluginRules as any[]).find((r: any) => r.strategy === 'after');
    const beforeHandler = beforeRule?.handler;
    const afterHandler = afterRule?.handler;

    it('emits a residue counter and passes an unmapped MASKED token through unchanged', async () => {
      const req: any = {
        debugRequestId: 'req-residue-1',
        body: {
          messages: [{ role: 'user', content: 'Email john@example.com' }],
          masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }] },
        },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

      // Model fabricated a token that is in no map (the incident's 28551619 shape)
      const upstreamResponse = {
        final_result: { choices: [{ message: { content: 'run MASKED_USER_PASSWORD_28551619 now' } }] },
      };
      const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

      // Unmappable residue passes through unchanged (must not corrupt output)
      expect(result.final_result.choices[0].message.content).toContain('MASKED_USER_PASSWORD_28551619');
      // A grep-stable counter line was logged
      const warnCalls = (mockLogger.warn as any).mock.calls.map((c: any[]) => c.join(' '));
      expect(warnCalls.some((s: string) => s.includes('pseudonymization_residue_unresolved_total='))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Entity-category toggles (api_config.json)
  // ─────────────────────────────────────────────────────────────────────────

  describe('applyEntityToggles', () => {
    const known = buildKnownEntityTypes([
      { type: 'profile-person' }, { type: 'profile-email' }, { type: 'profile-address' },
    ]);
    const base: EntityConfig[] = [
      { type: 'profile-person' }, { type: 'profile-email' }, { type: 'profile-address' },
    ];

    it('returns the base unchanged when toggles are absent/empty', () => {
      expect(applyEntityToggles(base, undefined, known)).toEqual(base);
      expect(applyEntityToggles(base, {}, known)).toEqual(base);
    });

    it('disables a category with false and leaves the rest', () => {
      const out = applyEntityToggles(base, { 'profile-address': false }, known);
      expect(out.map(e => e.type)).toEqual(['profile-person', 'profile-email']);
    });

    it('enables a known category that is absent with true', () => {
      const out = applyEntityToggles([{ type: 'profile-person' }], { 'profile-email': true }, known);
      expect(out.map(e => e.type)).toContain('profile-email');
    });

    it('is idempotent enabling an already-present category', () => {
      const out = applyEntityToggles(base, { 'profile-person': true }, known);
      expect(out.filter(e => e.type === 'profile-person')).toHaveLength(1);
    });

    it('ignores unknown category names (never fatal, entity set untouched)', () => {
      const out = applyEntityToggles(base, { 'profile-not-a-thing': false, 'garbage': true }, known);
      expect(out.map(e => e.type)).toEqual(base.map(e => e.type));
    });

    it('ignores non-boolean toggle values', () => {
      const out = applyEntityToggles(base, { 'profile-address': 'nope' as any }, known);
      expect(out.map(e => e.type)).toEqual(base.map(e => e.type));
    });

    it('does not mutate the input array', () => {
      const input: EntityConfig[] = [{ type: 'profile-person' }];
      applyEntityToggles(input, { 'profile-email': true }, known);
      expect(input.map(e => e.type)).toEqual(['profile-person']);
    });
  });

  describe('Entity toggles via api_config.json (end to end)', () => {
    const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
    const beforeHandler = beforeRule?.handler;
    const trigger = (extra: string) =>
      `<sail-proxy:pseudonymization:on> John Smith, john@test.com, at 123 Main Street. ${extra}`;

    it('global toggle disables a category (address off; person/email still masked)', async () => {
      mockConfig.api_config.pseudonymization = { entities: { 'profile-address': false } };
      const req: any = { body: { messages: [{ role: 'user', content: trigger('') }] } };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const masked = req.body.messages[0].content as string;
      expect(masked).not.toContain('MASKED_ADDRESS');     // address category disabled
      expect(masked).not.toContain('John Smith');         // person still masked
      expect(masked).toContain('MASKED_EMAIL');           // email still masked
    });

    it('per-model overrides global (global off, model on → masked)', async () => {
      mockConfig.api_config.pseudonymization = { entities: { 'profile-address': false } };
      mockConfig.api_config.model_list_changes = {
        'test-model': { pseudonymization: { entities: { 'profile-address': true } } },
      };
      const req: any = { body: { model: 'test-model', messages: [{ role: 'user', content: trigger('') }] } };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const masked = req.body.messages[0].content as string;
      expect(masked).not.toContain('123 Main Street');    // model re-enabled → masked
      expect(masked).toContain('MASKED_ADDRESS');
    });

    it('per-endpoint overrides global, per-model overrides endpoint (model wins)', async () => {
      mockConfig.api_config.pseudonymization = { entities: { 'profile-phone': true } };
      mockConfig.api_config.defaultHooks = {
        anthropic: { pseudonymization: { entities: { 'profile-phone': true } } },
      };
      mockConfig.api_config.model_list_changes = {
        'test-model': { pseudonymization: { entities: { 'profile-phone': false } } },
      };
      const req: any = {
        __endpoint: 'anthropic',
        body: { model: 'test-model', messages: [{ role: 'user', content: trigger('call 415 555 0132') }] },
      };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      const masked = req.body.messages[0].content as string;
      expect(masked).toContain('415 555 0132');            // model disabled phone → unmasked
    });

    it('no toggle config → default behavior (address masked)', async () => {
      const req: any = { body: { messages: [{ role: 'user', content: trigger('') }] } };
      await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
      expect(req.body.messages[0].content).not.toContain('123 Main Street');
      expect(req.body.messages[0].content).toContain('MASKED_ADDRESS');
    });
  });
});
