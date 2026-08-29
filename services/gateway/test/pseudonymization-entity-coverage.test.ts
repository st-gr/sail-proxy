import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock logger before any import that can reach it. Unlike the other pseudonymization
// test files (which mint a FRESH `{ warn: jest.fn(), ... }` on every getDefaultLogger()
// call — fine when they only check *that* something warned via utils.logger), this file
// needs to assert on the specific warn() calls index.ts's resolveMaskingLists makes
// directly via getDefaultLogger(). The factory closes over a single `logger` object and
// always returns it, so the same mock instance is visible both to production code and
// to the assertion below (retrieved via jest.requireMock).
jest.mock('@libs/logger', () => {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => logger };
});

// Mutable mock config used by the force-config (per-endpoint) activation path exercised
// below — mirrors the harness in test/pseudonymization-org-location-roundtrip.test.ts.
const mockConfig: any = { api_config: { hooks: { defaults: {} }, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_endpoint: string, model: string) => model,
  },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_endpoint: string, model: string) => model,
}));

import { buildKnownEntityTypes, applyEntityToggles, OPT_IN_ENTITY_TYPES } from '../src/plugins/pseudonymization/entityToggles';
import { DEFAULT_MASKING_CONFIG } from '../src/plugins/pseudonymization/defaultMaskingConfig';
import pluginRules = require('../src/plugins/pseudonymization/index');

const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before')?.handler;

describe('opt-in entity categories', () => {
  const known = buildKnownEntityTypes(DEFAULT_MASKING_CONFIG.entities);

  it('ships profile-org and profile-location OFF by default', () => {
    const types = DEFAULT_MASKING_CONFIG.entities.map(e => e.type);
    expect(types).not.toContain('profile-org');
    expect(types).not.toContain('profile-location');
  });

  // The whole point: absent from the defaults must NOT mean unknown to the toggle
  // validator. If this fails, an operator setting the toggle gets "Ignoring unknown
  // entity toggle" and silently no masking — the defect this change exists to fix.
  it('keeps them toggleable even though they are not defaults', () => {
    expect(known.has('profile-org')).toBe(true);
    expect(known.has('profile-location')).toBe(true);
  });

  it('an operator can turn profile-org on via api_config toggles', () => {
    const result = applyEntityToggles(DEFAULT_MASKING_CONFIG.entities, { 'profile-org': true }, known);
    expect(result.map(e => e.type)).toContain('profile-org');
  });

  it('OPT_IN_ENTITY_TYPES is the source of truth for both', () => {
    expect(OPT_IN_ENTITY_TYPES).toContain('profile-org');
    expect(OPT_IN_ENTITY_TYPES).toContain('profile-location');
  });
});

describe('org/location configuration inputs', () => {
  it('ships generic legal-form suffixes only', () => {
    expect(DEFAULT_MASKING_CONFIG.org_suffixes).toBeDefined();
    expect(DEFAULT_MASKING_CONFIG.org_suffixes).toContain('Inc');
    expect(DEFAULT_MASKING_CONFIG.org_suffixes).toContain('LLC');
    expect(DEFAULT_MASKING_CONFIG.org_suffixes).toContain('GmbH');
  });

  it('ships an EMPTY location gazetteer — the repo is public and must stay generic', () => {
    expect(DEFAULT_MASKING_CONFIG.location_gazetteer).toEqual([]);
  });

  // A deployment-specific place name in a tracked default would leak who runs this.
  it('carries no place names in any shipped default', () => {
    const serialised = JSON.stringify(DEFAULT_MASKING_CONFIG).toLowerCase();
    for (const term of ['san diego', 'california', 'sandiego']) {
      expect(serialised).not.toContain(term);
    }
  });
});

// Spec §4's deliverable: enabling profile-org/profile-location with nothing for them
// to match must not fail silently. resolveMaskingLists (index.ts) warns once per
// category per process — this test proves the warning actually fires, not just that
// the code path exists to fire it (an unverified log line is not evidence).
describe('empty-producer warning (spec §4)', () => {
  beforeEach(() => {
    mockConfig.api_config.observability.pseudonymization = undefined;
    mockConfig.api_config.hooks.defaults = {};
    mockConfig.api_config.models.overrides = {};
  });

  it('warns naming profile-location when force-enabled with an empty gazetteer', async () => {
    const { getDefaultLogger } = jest.requireMock('@libs/logger') as any;
    const warnLogger = getDefaultLogger();
    warnLogger.warn.mockClear();

    // Force-enable via the per-endpoint path (Method 4) with profile-location toggled
    // on and no location_gazetteer override — DEFAULT_MASKING_CONFIG.location_gazetteer
    // stays [] (ships empty by design), so this is exactly the "enabled but nothing to
    // match" case the warning exists for.
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, entities: { 'profile-location': true } } },
    };

    const req: any = {
      __endpoint: 'anthropic',
      body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }] },
    };
    const utilsLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

    await beforeHandler({ req, res: {}, utils: { logger: utilsLogger } });

    const calls = warnLogger.warn.mock.calls.map((args: any[]) => args.join(' '));
    expect(calls.some((s: string) =>
      s.includes('profile-location') && s.toLowerCase().includes('empty')
    )).toBe(true);
  });
});

/**
 * `min_confidence` / `thresholds` (spec 2026-08-25-pseudonymization-precision, task 2) are
 * layered exactly like `entities`: global (observability.pseudonymization) → per-endpoint
 * (hooks.defaults.<endpoint>) → per-model (models.overrides.<model>), later winning. The
 * scalar is replaced outright; the map is merged per category.
 *
 * Measured through the real activation path rather than by calling the resolver, because
 * the resolver being right is worth nothing if the request never reaches it.
 */
describe('layered confidence thresholds', () => {
  // 0.35 (capitalised run) + 0.15 (ordinary prose) = 0.5 — exactly on the default
  // threshold, and below a 0.6 one. Neither word is in the given-name list, so nothing else
  // lifts it; that margin is what makes the layering visible.
  const SENTENCE = 'Ferreira Nakamura signed the filing this morning.';

  const maskedValues = async () => {
    const req: any = {
      __endpoint: 'anthropic',
      body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: SENTENCE }] },
    };
    const utilsLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
    await beforeHandler({ req, res: {}, utils: { logger: utilsLogger } });
    return [...(req.__pseudonymizationMap?.forward.keys() ?? [])];
  };

  beforeEach(() => {
    mockConfig.api_config.observability.pseudonymization = undefined;
    mockConfig.api_config.models.overrides = {};
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true } },
    };
  });

  it('masks the name with no threshold configured anywhere', async () => {
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('a global min_confidence of 0.6 stops masking it', async () => {
    mockConfig.api_config.observability.pseudonymization = { min_confidence: 0.6 };
    expect(await maskedValues()).not.toContain('Ferreira Nakamura');
  });

  it('a per-ENDPOINT min_confidence overrides the global one', async () => {
    mockConfig.api_config.observability.pseudonymization = { min_confidence: 0.6 };
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, min_confidence: 0.4 } },
    };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('a per-ENDPOINT thresholds entry overrides the global one', async () => {
    mockConfig.api_config.observability.pseudonymization = {
      min_confidence: 0.6,
      thresholds: { 'profile-person': 0.7 },
    };
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, thresholds: { 'profile-person': 0.4 } } },
    };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('lets the per-model layer win over the per-endpoint one', async () => {
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, min_confidence: 0.4 } },
    };
    mockConfig.api_config.models.overrides = {
      'claude-sonnet-4-20250514': { pseudonymization: { min_confidence: 0.9 } },
    };
    expect(await maskedValues()).not.toContain('Ferreira Nakamura');
  });

  it('a per-model min_confidence overrides the global one', async () => {
    mockConfig.api_config.observability.pseudonymization = { min_confidence: 0.6 };
    mockConfig.api_config.models.overrides = {
      'claude-sonnet-4-20250514': { pseudonymization: { min_confidence: 0.4 } },
    };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('a per-entity threshold beats min_confidence for that category', async () => {
    mockConfig.api_config.observability.pseudonymization = {
      min_confidence: 0.6,
      thresholds: { 'profile-person': 0.4 },
    };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('merges the thresholds map per category across layers instead of replacing it', async () => {
    mockConfig.api_config.observability.pseudonymization = {
      min_confidence: 0.6,
      thresholds: { 'profile-person': 0.4 },
    };
    // The per-model layer names a DIFFERENT category. A replace-the-whole-map merge would
    // drop the global profile-person entry and the name would stop masking.
    mockConfig.api_config.models.overrides = {
      'claude-sonnet-4-20250514': { pseudonymization: { thresholds: { 'profile-email': 0.9 } } },
    };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });

  it('ignores an out-of-range min_confidence rather than obeying it', async () => {
    mockConfig.api_config.observability.pseudonymization = { min_confidence: 1.5 };
    expect(await maskedValues()).toContain('Ferreira Nakamura');
  });
});
