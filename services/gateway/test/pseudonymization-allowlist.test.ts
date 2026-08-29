/**
 * Operator allow-list and the saturation report
 * (spec 2026-08-25-pseudonymization-precision, task 3).
 *
 * Two independent features, tested together because they are the two halves of one idea:
 * giving an operator control over what this deployment masks, and visibility into how much
 * it masked.
 *
 *   - The ALLOW-LIST decides. It is applied after the technical veto and before scoring, so
 *     a hit is final — no adjustment, threshold or detector tier can bring the span back.
 *   - The SATURATION REPORT only reports. The load-bearing assertion in the second half is
 *     the one that proves it changed NOTHING: a 60-name roster with the bar at 40 masks all
 *     sixty. Task 2's fix round 3 removed a saturation rule that did the opposite, and this
 *     file is where that stays removed.
 *
 * Every name, identifier and mail address here is synthetic; nothing is copied from a
 * payload log.
 */

// A single logger instance shared with production code, so the invalid-pattern warning
// `detectors/allowlist.ts` emits through getDefaultLogger() can be asserted on. Same shape
// as the harness in pseudonymization-entity-coverage.test.ts.
jest.mock('@libs/logger', () => {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => logger };
});

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

import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { compileAllowlist, isAllowlisted } from '../src/plugins/pseudonymization/detectors/allowlist';
import { DEFAULT_MASKING_CONFIG } from '../src/plugins/pseudonymization/defaultMaskingConfig';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';
import {
  DEFAULT_SATURATION_WARN,
  buildSaturationReport,
  formatSaturationWarning,
  identifierShape,
  resolveSaturationWarn,
  topShapes,
} from '../src/plugins/pseudonymization/saturationReport';
import pluginRules = require('../src/plugins/pseudonymization/index');

const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;

const config = (over: Partial<MaskingConfig> = {}): MaskingConfig => ({
  ...DEFAULT_MASKING_CONFIG,
  method: 'pseudonymization',
  ...over,
});

const masked = (text: string, over: Partial<MaskingConfig> = {}): string[] =>
  detectEntities(text, config(over)).map(m => m.original);

/**
 * Two spans the pipeline masks as people at 0.5 — one a real person, one a product name the
 * capitalised-run heuristic cannot tell from one. That is exactly the operator's problem the
 * allow-list exists for, and it is why both halves of this sentence matter: exempting the
 * product must not exempt the person beside it.
 */
const SENTENCE = 'The report was prepared by Watson Studio for Ferreira Nakamura.';

describe('the allow-list decides what is never masked', () => {
  it('masks both spans of the fixture with no allow-list at all', () => {
    // The baseline every assertion below is a delta against. Without it a passing test
    // proves only that nothing was detected in the first place.
    expect(masked(SENTENCE).sort()).toEqual(['Ferreira Nakamura', 'Watson Studio']);
  });

  it('never masks a term, and leaves everything else alone', () => {
    expect(masked(SENTENCE, { allowlist: { terms: ['Watson Studio'] } }))
      .toEqual(['Ferreira Nakamura']);
  });

  it('compares terms case-SENSITIVELY', () => {
    // "watson studio" in prose is not the product the operator exempted, and a
    // case-insensitive list would also exempt a surname that shares the spelling.
    expect(masked(SENTENCE, { allowlist: { terms: ['watson studio'] } }))
      .toContain('Watson Studio');
  });

  it('never masks a span a pattern matches', () => {
    expect(masked(SENTENCE, { allowlist: { patterns: ['Watson [A-Z][a-z]+'] } }))
      .toEqual(['Ferreira Nakamura']);
  });

  it('anchors a pattern to the WHOLE span, so a substring match exempts nothing', () => {
    // `Studio` appears inside the span but is not the span. An unanchored list would let
    // `[A-Z]` exempt every capitalised value in the deployment.
    expect(masked(SENTENCE, { allowlist: { patterns: ['Studio'] } }))
      .toContain('Watson Studio');
    expect(masked(SENTENCE, { allowlist: { patterns: ['\\w+ Studio'] } }))
      .not.toContain('Watson Studio');
  });

  it('outranks every piece of evidence FOR masking — a 0.95 salutation name included', () => {
    // The allow-list runs before scoring, so the score is never consulted. `Dear Anna
    // Karenina` is 0.95: honorific evidence on top of the run base, far above any threshold.
    expect(masked('Dear Anna Karenina, welcome aboard.')).toEqual(['Anna Karenina']);
    expect(masked('Dear Anna Karenina, welcome aboard.', { allowlist: { terms: ['Anna Karenina'] } }))
      .toEqual([]);
  });

  it('an empty or whitespace-only entry exempts nothing', () => {
    // `^(?:)$` would otherwise be a pattern that matches the empty string, and a blank term
    // arrives from a config form far more often than anyone intends it to.
    expect(masked(SENTENCE, { allowlist: { terms: ['', '  '], patterns: ['', ' '] } }).sort())
      .toEqual(['Ferreira Nakamura', 'Watson Studio']);
  });

  it('skips an invalid pattern with ONE warning naming it, and still applies the rest', () => {
    const { getDefaultLogger } = jest.requireMock('@libs/logger') as any;
    const logger = getDefaultLogger();
    logger.warn.mockClear();

    const broken = 'Watson ([A-Z';   // unclosed group: never compiles
    const cfg = config({ allowlist: { patterns: [broken, '\\w+ Studio'] } });

    // The good pattern still applies...
    expect(detectEntities(SENTENCE, cfg).map(m => m.original)).toEqual(['Ferreira Nakamura']);

    // ...and the bad one was reported, by name, exactly once.
    const naming = logger.warn.mock.calls
      .map((args: any[]) => args.join(' '))
      .filter((line: string) => line.includes(broken));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toContain('allowlist');

    // Once per process, not once per request: a second detection over the same list is silent.
    logger.warn.mockClear();
    detectEntities(SENTENCE, cfg);
    expect(logger.warn.mock.calls.filter((args: any[]) => args.join(' ').includes(broken))).toHaveLength(0);
  });

  /**
   * The allow-list is a masking OFF switch, and its failure mode is quiet. A pattern that also
   * matches ordinary personal data is reported — never rejected, because an operator may have a
   * reason and refusing a valid entry would be the worse surprise.
   */
  it('warns about a pattern that also matches ordinary personal data, and applies it anyway', () => {
    const { getDefaultLogger } = jest.requireMock('@libs/logger') as any;
    const logger = getDefaultLogger();
    logger.warn.mockClear();

    const broad = '[A-Z].*';
    // Still applied: the warning is a report, not a veto.
    expect(masked(SENTENCE, { allowlist: { patterns: [broad] } })).toEqual([]);

    const naming = logger.warn.mock.calls
      .map((args: any[]) => args.join(' '))
      .filter((line: string) => line.includes(broad));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toContain('ordinary personal data');

    // Once per process, not once per request.
    logger.warn.mockClear();
    masked(SENTENCE, { allowlist: { patterns: [broad] } });
    expect(logger.warn.mock.calls.filter((args: any[]) => args.join(' ').includes(broad))).toHaveLength(0);
  });

  it('says nothing about a pattern that only matches machinery', () => {
    const { getDefaultLogger } = jest.requireMock('@libs/logger') as any;
    const logger = getDefaultLogger();
    logger.warn.mockClear();

    // The operator's realistic entry: object names, and nothing a person is called.
    compileAllowlist({ patterns: ['Z[A-Z0-9_]+'] });
    expect(logger.warn.mock.calls).toEqual([]);
  });

  it('measures the pattern against a person, a mail address, a phone number and an IBAN', () => {
    const { getDefaultLogger } = jest.requireMock('@libs/logger') as any;
    const logger = getDefaultLogger();
    // One canary family each, so a pattern broad in only one direction is still caught.
    const cases: Array<[string, boolean]> = [
      ['[A-Z][a-z]+ [A-Z][a-z]+', true],      // a person
      ['\\S+@\\S+', true],                     // a mail address
      ['\\+\\d[\\d ]+', true],                 // a phone number
      ['[A-Z]{2}\\d{2}[\\d ]+', true],         // an IBAN
      ['REQ-\\d{6}', false],                   // a ticket id, and nothing else
      ['Watson Studio', false],                // one exact product name
    ];
    for (const [source, shouldWarn] of cases) {
      logger.warn.mockClear();
      compileAllowlist({ patterns: [source] });
      // Matched on the message rather than on the source: the line names the pattern in its
      // JSON form (`"\\S+@\\S+"` for a source of `\S+@\S+`), which is how an operator typed
      // it into api_config.json but not how it reads here.
      const warned = logger.warn.mock.calls
        .some((args: any[]) => args.join(' ').includes('ordinary personal data'));
      expect([source, warned]).toEqual([source, shouldWarn]);
    }
  });

  it('compiles nothing when there is nothing to compile', () => {
    expect(compileAllowlist(undefined)).toBeUndefined();
    expect(compileAllowlist({})).toBeUndefined();
    expect(compileAllowlist({ patterns: [], terms: [] })).toBeUndefined();
  });

  it('matches a term or a pattern, and nothing in between', () => {
    const compiled = compileAllowlist({ terms: ['Watson Studio'], patterns: ['Z[A-Z0-9_]+'] })!;
    expect(isAllowlisted('Watson Studio', compiled)).toBe(true);
    expect(isAllowlisted('ZPC_FICA_TRAN_DAILY', compiled)).toBe(true);
    expect(isAllowlisted('Watson', compiled)).toBe(false);
    expect(isAllowlisted('Ferreira Nakamura', compiled)).toBe(false);
  });
});

/**
 * The layering, measured through the real activation path rather than by calling the
 * resolver: a resolver being right is worth nothing if the request never reaches it.
 */
describe('the allow-list layers global -> endpoint -> model by CONCATENATION', () => {
  const maskedValues = async (): Promise<string[]> => {
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
    mockConfig.api_config.hooks.defaults = { anthropic: { pseudonymization: { enabled: true } } };
  });

  it('masks both spans with no allow-list configured anywhere', async () => {
    expect((await maskedValues()).sort()).toEqual(['Ferreira Nakamura', 'Watson Studio']);
  });

  it('honours a global allow-list', async () => {
    mockConfig.api_config.observability.pseudonymization = { allowlist: { terms: ['Watson Studio'] } };
    expect(await maskedValues()).toEqual(['Ferreira Nakamura']);
  });

  it('an endpoint list EXTENDS the global one rather than replacing it', async () => {
    mockConfig.api_config.observability.pseudonymization = { allowlist: { terms: ['Watson Studio'] } };
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, allowlist: { terms: ['Ferreira Nakamura'] } } },
    };
    expect(await maskedValues()).toEqual([]);
  });

  it('a per-model list extends both layers above it', async () => {
    mockConfig.api_config.observability.pseudonymization = { allowlist: { terms: ['Watson Studio'] } };
    mockConfig.api_config.models.overrides = {
      'claude-sonnet-4-20250514': { pseudonymization: { allowlist: { patterns: ['Ferreira \\w+'] } } },
    };
    expect(await maskedValues()).toEqual([]);
  });

  // The property concatenation exists for: a lower layer can only ever ADD an exemption.
  it('a lower layer cannot remove an upper layer entry', async () => {
    mockConfig.api_config.observability.pseudonymization = { allowlist: { terms: ['Watson Studio'] } };
    mockConfig.api_config.hooks.defaults = {
      anthropic: { pseudonymization: { enabled: true, allowlist: { terms: [] } } },
    };
    mockConfig.api_config.models.overrides = {
      'claude-sonnet-4-20250514': { pseudonymization: { allowlist: { patterns: [] } } },
    };
    expect(await maskedValues()).toEqual(['Ferreira Nakamura']);
  });
});

describe('the saturation report counts, and never decides', () => {
  const entities = (values: Array<[string, string]>): any[] =>
    values.map(([original, type], i) => ({ original, type, start: i, end: i + 1, priority: 2, confidence: 1 }));

  it('defaults the bar to 40 and ignores a value that is not a whole number of at least 1', () => {
    expect(DEFAULT_SATURATION_WARN).toBe(40);
    expect(resolveSaturationWarn(undefined)).toBe(40);
    expect(resolveSaturationWarn(5)).toBe(5);
    // Dropped, not coerced: 0 would warn about every request on the strength of a typo.
    for (const bad of [0, -1, 1.5, '10', null, NaN]) {
      expect([bad, resolveSaturationWarn(bad)]).toEqual([bad, 40]);
    }
  });

  it('counts DISTINCT values, not occurrences', () => {
    const report = buildSaturationReport(
      entities([['Ana Ruiz', 'profile-person'], ['Ana Ruiz', 'profile-person'], ['a@b.invalid', 'profile-email']]),
      40,
    );
    expect(report).toEqual({
      masked_values: 2,
      categories: { 'profile-person': 1, 'profile-email': 1 },
      saturated: false,
    });
  });

  it('is saturated strictly ABOVE the bar', () => {
    const at = entities(Array.from({ length: 40 }, (_, i) => [`v${i}`, 'profile-person'] as [string, string]));
    expect(buildSaturationReport(at, 40).saturated).toBe(false);
    expect(buildSaturationReport([...at, ...entities([['v40', 'profile-person']])], 40).saturated).toBe(true);
  });

  it('renders a shape, never a value', () => {
    expect(identifierShape('ZPC_FICA_TRAN_DAILY')).toBe('XXX_XXXX_XXXX_XXXXX');
    expect(identifierShape('Ferreira Nakamura')).toBe('XXXXXXXX.XXXXXXXX');
    expect(identifierShape('AB-123')).toBe('XX-999');
    expect(identifierShape('a.b@example.invalid')).toBe('X.X.XXXXXXX.XXXXXXX');
    // The property, not the examples: no letter or digit of the value survives.
    for (const value of ['Ferreira Nakamura', 'ZPC_FICA_TRAN_DAILY', 'a.b@example.invalid']) {
      expect(identifierShape(value)).not.toMatch(/[A-WYZa-z0-8]/);
      expect(identifierShape(value)).toHaveLength(value.length);
    }
  });

  it('reports the most common shapes, highest first', () => {
    const shapes = topShapes(entities([
      ['Ana Ruizx', 'profile-person'],
      ['Jan Roexx', 'profile-person'],
      ['ZPC_A', 'custom'],
    ]));
    // Two nine-character names collapse to one shape; the identifier keeps its own.
    expect(shapes).toEqual(['XXX.XXXXX x2', 'XXX_X x1']);
  });

  it('the WARN line carries the histogram and no masked value', () => {
    const values = entities([['Ferreira Nakamura', 'profile-person'], ['a.b@example.invalid', 'profile-email']]);
    const report = buildSaturationReport(values, 1);
    const line = formatSaturationWarning(report, topShapes(values), 1);

    expect(line).toContain('2 distinct values');
    expect(line).toContain('profile-person=1');
    expect(line).toContain('profile-email=1');
    expect(line).toContain('saturation_warn=1');
    expect(line).not.toContain('Ferreira');
    expect(line).not.toContain('Nakamura');
    expect(line).not.toContain('example.invalid');
  });
});

/**
 * The report through the real request path — and the ruling it exists to keep: saturation is
 * REPORT-ONLY.
 */
describe('a saturated request warns once, and masks everything anyway', () => {
  /** A roster of `count` distinct synthetic names, one per bullet — the shape of a real data dump. */
  const roster = (count: number): string =>
    Array.from({ length: count }, (_, i) => `- Ana Silva${i} Nakamura${i}`).join('\n');

  const run = async (text: string, saturationWarn?: number) => {
    mockConfig.api_config.hooks.defaults = {
      anthropic: {
        pseudonymization: {
          enabled: true,
          ...(saturationWarn === undefined ? {} : { saturation_warn: saturationWarn }),
        },
      },
    };
    const req: any = {
      __endpoint: 'anthropic',
      body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: text }] },
    };
    const utilsLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
    await beforeHandler({ req, res: {}, utils: { logger: utilsLogger } });
    return {
      maskedValues: [...(req.__pseudonymizationMap?.forward.keys() ?? [])],
      report: req.__pseudonymizationSaturation,
      warnings: utilsLogger.warn.mock.calls.map((args: any[]) => String(args[0])),
    };
  };

  beforeEach(() => {
    mockConfig.api_config.observability.pseudonymization = undefined;
    mockConfig.api_config.models.overrides = {};
  });

  it('41 distinct values over a bar of 40: exactly one WARN, with the histogram and no value', async () => {
    const { maskedValues, report, warnings } = await run(roster(41), 40);

    expect(maskedValues).toHaveLength(41);
    expect(report).toMatchObject({ masked_values: 41, saturated: true });
    expect(report.categories['profile-person']).toBe(41);

    const saturationWarnings = warnings.filter(line => line.includes('saturation'));
    expect(saturationWarnings).toHaveLength(1);
    expect(saturationWarnings[0]).toContain('profile-person=41');
    for (const value of maskedValues) {
      expect(saturationWarnings[0]).not.toContain(value);
    }
  });

  it('below the bar it says so and stays quiet', async () => {
    const { maskedValues, report, warnings } = await run(roster(3), 40);

    expect(maskedValues).toHaveLength(3);
    expect(report).toMatchObject({ masked_values: 3, saturated: false });
    expect(warnings.filter(line => line.includes('saturation'))).toEqual([]);
  });

  // THE RULING. Task 2's fix round 3 removed a −0.2 saturation adjustment that made this
  // roster mask NOTHING once it crossed the bar. If a future change lets saturation reach a
  // score again, this is the test that goes red.
  it('a 60-name roster at a bar of 40 masks all 60, warns once, and reports saturated', async () => {
    const { maskedValues, report, warnings } = await run(roster(60), 40);

    expect(maskedValues).toHaveLength(60);
    expect(report).toMatchObject({ masked_values: 60, saturated: true });
    expect(warnings.filter(line => line.includes('saturation'))).toHaveLength(1);
  });

  it('the same roster below its own bar masks exactly the same 60', async () => {
    // The counts differ; the masking does not. That is the whole of "report-only".
    const high = await run(roster(60), 100);
    const low = await run(roster(60), 40);

    expect(high.maskedValues.sort()).toEqual(low.maskedValues.sort());
    expect([high.report.saturated, low.report.saturated]).toEqual([false, true]);
  });

  it('an allowed value is not counted, because it was never masked', async () => {
    mockConfig.api_config.observability.pseudonymization = {
      allowlist: { patterns: ['Ana Silva0 Nakamura0'] },
    };
    const { maskedValues, report } = await run(roster(41), 40);

    expect(maskedValues).not.toContain('Ana Silva0 Nakamura0');
    expect(report).toMatchObject({ masked_values: 40, saturated: false });
  });
});
