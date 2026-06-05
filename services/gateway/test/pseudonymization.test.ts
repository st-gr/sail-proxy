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
import { MaskingConfig } from '../src/plugins/pseudonymization/types';

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

    it('should detect URLs', () => {
      const matches = detectRegexEntities(
        'Visit https://example.com/path?q=1 for info',
        [{ type: 'profile-url' }]
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].original).toBe('https://example.com/path?q=1');
    });

    it('should detect credentials', () => {
      const matches = detectRegexEntities(
        'api_key=sk-abc123xyz password: hunter2',
        [{ type: 'profile-username-password' }]
      );
      expect(matches.length).toBeGreaterThanOrEqual(1);
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
    it('should assign incrementing placeholders per type', () => {
      const map = new ReplacementMap('pseudonymization');
      const p1 = map.getPlaceholder('profile-person', 'John Smith');
      const p2 = map.getPlaceholder('profile-person', 'Jane Doe');
      expect(p1).toBe('MASKED_PERSON_1');
      expect(p2).toBe('MASKED_PERSON_2');
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
      map.getPlaceholder('profile-person', 'John Smith');
      expect(map.reverse.get('MASKED_PERSON_1')).toBe('John Smith');
    });

    it('should not maintain reverse map in anonymization mode', () => {
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

      expect(masked).toBe('MASKED_PERSON_1 went home. Later, MASKED_PERSON_1 returned.');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unmasker Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Unmasker', () => {
    it('should replace all placeholders with original values', () => {
      const map = new ReplacementMap('pseudonymization');
      map.getPlaceholder('profile-person', 'John Smith');
      map.getPlaceholder('profile-email', 'john@example.com');

      const text = 'MASKED_PERSON_1 can be reached at MASKED_EMAIL_1';
      const result = unmaskText(text, map);

      expect(result).toBe('John Smith can be reached at john@example.com');
    });

    it('should handle multiple occurrences of same placeholder', () => {
      const map = new ReplacementMap('pseudonymization');
      map.getPlaceholder('profile-person', 'John Smith');

      const text = 'MASKED_PERSON_1 went home. MASKED_PERSON_1 returned.';
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
      map.getPlaceholder('profile-person', 'John Smith');

      const buffer = new StreamUnmaskBuffer(map);

      expect(buffer.append('I recommend ')).toBe('I recommend ');
      expect(buffer.append('MASKED_')).toBe(''); // held in buffer
      expect(buffer.append('PERSON_1')).toBe('John Smith'); // unmasked
      expect(buffer.append(' call back')).toBe(' call back');
      expect(buffer.flush()).toBe('');
    });

    it('should flush remaining text at end of stream', () => {
      const map = new ReplacementMap('pseudonymization');
      map.getPlaceholder('profile-person', 'John Smith');

      const buffer = new StreamUnmaskBuffer(map);
      buffer.append('Hello MASKED_PERSON_1');
      const flushed = buffer.flush();

      // Should have flushed "Hello John Smith" across append+flush
      expect(flushed).toBe(''); // already flushed in append
    });

    it('should unmask complete tokens immediately', () => {
      const map = new ReplacementMap('pseudonymization');
      map.getPlaceholder('profile-person', 'John Smith');
      map.getPlaceholder('profile-email', 'john@example.com');

      const buffer = new StreamUnmaskBuffer(map);
      const result = buffer.append('Contact MASKED_PERSON_1 at MASKED_EMAIL_1 now');

      expect(result).toContain('John Smith');
      expect(result).toContain('john@example.com');
    });

    it('should handle empty map gracefully', () => {
      const map = new ReplacementMap('pseudonymization');
      const buffer = new StreamUnmaskBuffer(map);

      expect(buffer.append('Hello world')).toBe('Hello world');
      expect(buffer.flush()).toBe('');
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
});
