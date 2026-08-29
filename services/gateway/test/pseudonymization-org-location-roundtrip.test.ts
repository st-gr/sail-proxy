/**
 * Round-trip tests for the profile-org and profile-location categories (Task 3
 * of the entity-coverage-gaps plan).
 *
 * Detection tests (orgLocationDetector) prove a match is *found*. They do not prove
 * the value comes *back* through masking → the model → unmasking. Masking has broken
 * on the return path twice before in this codebase:
 *   - commit f236892: an over-masked value led the model to emit a *variant*
 *     placeholder that existed in no reverse map — unmaskable, and it replayed for
 *     many turns.
 *   - commit 6b314a7: placeholders are content-derived (SHA-256 → decimal digits) so
 *     the same value yields the same placeholder across requests, and
 *     StreamUnmaskBuffer handles placeholders split across streaming chunk boundaries.
 *
 * This suite exercises org/location through the SAME mask/unmask harness the other
 * categories use (see test/pseudonymization.test.ts) rather than a parallel one:
 * detectEntities / ReplacementMap / replaceEntities / unmaskText / StreamUnmaskBuffer
 * directly, plus the plugin's before/after handlers for the tool-call and leak-audit
 * cases (mirrors the "Plugin Handlers" and "Residue audit (non-streaming)" describe
 * blocks in test/pseudonymization.test.ts).
 *
 * profile-org and profile-location are OFF by default (see defaultMaskingConfig.ts),
 * so every config below enables them explicitly and supplies org_suffixes /
 * location_gazetteer directly — an explicit `masking` body config is used as-is by
 * the plugin and is not merged with the default lists.
 *
 * Fixtures are invented, per repo convention (public repo): "Acme Industries Inc",
 * "Springfield", "Rivertown Heights".
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock logger before imports (verbatim from test/pseudonymization.test.ts)
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

// Mutable mock config used by getModelForcedConfig — not exercised by these tests
// (every case supplies an explicit `masking` config), but mocked for parity with
// the established harness so requiring index.ts never touches the real service.
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
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import { replaceEntities } from '../src/plugins/pseudonymization/replacer';
import { unmaskText } from '../src/plugins/pseudonymization/unmasker';
import { StreamUnmaskBuffer } from '../src/plugins/pseudonymization/streamBuffer';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';

// Plugin handlers, imported the same way test/pseudonymization.test.ts does (index.ts
// is a CommonJS `export = pluginRules` module).
import pluginRules = require('../src/plugins/pseudonymization/index');

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

const beforeRule = (pluginRules as any[]).find((r: any) => r.strategy === 'before');
const afterRule = (pluginRules as any[]).find((r: any) => r.strategy === 'after');
const beforeHandler = beforeRule?.handler;
const afterHandler = afterRule?.handler;

describe('Pseudonymization: profile-org / profile-location round trip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.api_config.observability.pseudonymization = undefined;
    mockConfig.api_config.hooks.defaults = {};
    mockConfig.api_config.models.overrides = {};
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. Non-streaming: mask an org and a location, unmask the reply verbatim.
  // ───────────────────────────────────────────────────────────────────────
  it('masks a configured org and location and unmasks the model reply verbatim (non-streaming)', () => {
    const config: MaskingConfig = {
      method: 'pseudonymization',
      entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
      org_suffixes: ['Inc'],
      location_gazetteer: ['Springfield'],
    };
    const text = 'Acme Industries Inc is opening an office in Springfield next quarter.';
    const map = new ReplacementMap('pseudonymization');
    const matches = detectEntities(text, config);
    const masked = replaceEntities(text, matches, map, config);

    // Both placeholders appear; neither original survives.
    expect(masked).toMatch(/MASKED_ORG_\d+/);
    expect(masked).toMatch(/MASKED_LOCATION_\d+/);
    expect(masked).not.toContain('Acme Industries Inc');
    expect(masked).not.toContain('Springfield');

    const orgPlaceholder = map.forward.get('Acme Industries Inc');
    const locationPlaceholder = map.forward.get('Springfield');
    expect(orgPlaceholder).toBeDefined();
    expect(locationPlaceholder).toBeDefined();

    // Unmask the model's reply containing both placeholders: originals come back verbatim.
    const reply = `Confirmed: ${orgPlaceholder} will lease office space in ${locationPlaceholder}.`;
    const unmasked = unmaskText(reply, map);
    expect(unmasked).toBe('Confirmed: Acme Industries Inc will lease office space in Springfield.');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Streaming: feed the reply through StreamUnmaskBuffer in chunks that
  //    split a placeholder mid-token; concatenated output must match the
  //    non-streaming result.
  // ───────────────────────────────────────────────────────────────────────
  it('round-trips through StreamUnmaskBuffer when a placeholder is split across a chunk boundary', () => {
    const config: MaskingConfig = {
      method: 'pseudonymization',
      entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
      org_suffixes: ['Inc'],
      location_gazetteer: ['Rivertown Heights'],
    };
    const text = 'Acme Industries Inc opened a branch in Rivertown Heights.';
    const map = new ReplacementMap('pseudonymization');
    replaceEntities(text, detectEntities(text, config), map, config);

    const orgPlaceholder = map.forward.get('Acme Industries Inc')!;
    const locationPlaceholder = map.forward.get('Rivertown Heights')!;
    const reply = `${orgPlaceholder} confirmed the lease in ${locationPlaceholder} today.`;

    // Non-streaming baseline this case must match.
    const nonStreamingResult = unmaskText(reply, map);
    expect(nonStreamingResult).toBe('Acme Industries Inc confirmed the lease in Rivertown Heights today.');

    // Split the LOCATION placeholder mid-token: "MASKED_LOC" | "ATION_<id>"
    // (mirrors the brief's example split, applied to the real minted placeholder).
    const locationIndex = reply.indexOf(locationPlaceholder);
    const splitIndex = locationIndex + 'MASKED_LOC'.length;
    expect(reply.slice(locationIndex, splitIndex)).toBe('MASKED_LOC'); // sanity: split is really mid-token

    const buffer = new StreamUnmaskBuffer(map);
    let streamed = '';
    streamed += buffer.append(reply.slice(0, splitIndex));
    streamed += buffer.append(reply.slice(splitIndex));
    streamed += buffer.flush();

    expect(streamed).toBe(nonStreamingResult);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Tool calls: mask a tool call's `arguments`/`input` JSON containing an
  //    org and a location; unmask a tool result containing the placeholders.
  //    Valid JSON in and out.
  // ───────────────────────────────────────────────────────────────────────
  it('round-trips org and location through a tool call (masked input JSON in, unmasked result JSON out)', async () => {
    const req: any = {
      body: {
        messages: [{
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'lookup_company',
            input: { company: 'Acme Industries Inc', city: 'Springfield' },
          }],
        }],
        masking: {
          method: 'pseudonymization',
          entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
          org_suffixes: ['Inc'],
          location_gazetteer: ['Springfield'],
        },
      },
    };

    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    const maskedInput = req.body.messages[0].content[0].input;
    // Still valid JSON (masking mutates values in place, structure survives).
    const maskedJson = JSON.stringify(maskedInput);
    expect(() => JSON.parse(maskedJson)).not.toThrow();
    expect(maskedJson).toContain('MASKED_ORG_');
    expect(maskedJson).toContain('MASKED_LOCATION_');
    expect(maskedJson).not.toContain('Acme Industries Inc');
    expect(maskedJson).not.toContain('Springfield');

    const map = req.__pseudonymizationMap;
    const orgPlaceholder = map.forward.get('Acme Industries Inc');
    const locationPlaceholder = map.forward.get('Springfield');
    expect(orgPlaceholder).toBeDefined();
    expect(locationPlaceholder).toBeDefined();

    // Simulate the upstream tool result (OpenAI shape: tool_calls[].function.arguments
    // is a JSON string) echoing both placeholders back.
    const upstreamResponse = {
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'lookup_company_result',
              arguments: JSON.stringify({ company: orgPlaceholder, city: locationPlaceholder }),
            },
          }],
        },
      }],
    };

    const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    const unmaskedArgs = result.choices[0].message.tool_calls[0].function.arguments;

    // Valid JSON out, and the originals are restored verbatim.
    expect(() => JSON.parse(unmaskedArgs)).not.toThrow();
    expect(JSON.parse(unmaskedArgs)).toEqual({ company: 'Acme Industries Inc', city: 'Springfield' });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Placeholder stability: the same org value masked in two SEPARATE
  //    requests mints the identical placeholder (content-derived, commit
  //    6b314a7) — which is what lets residue echoed from an earlier turn
  //    still resolve in a brand-new request.
  // ───────────────────────────────────────────────────────────────────────
  it('mints the identical placeholder for the same org value across two separate requests', async () => {
    const mkReq = () => ({
      body: {
        messages: [{ role: 'user', content: 'Acme Industries Inc is expanding into a new market.' }],
        masking: {
          method: 'pseudonymization',
          entities: [{ type: 'profile-org' }],
          org_suffixes: ['Inc'],
        },
      },
    });

    const req1: any = mkReq();
    const req2: any = mkReq();
    await beforeHandler({ req: req1, res: {}, utils: { logger: mockLogger } });
    await beforeHandler({ req: req2, res: {}, utils: { logger: mockLogger } });

    const placeholder1 = req1.__pseudonymizationMap.forward.get('Acme Industries Inc');
    const placeholder2 = req2.__pseudonymizationMap.forward.get('Acme Industries Inc');
    expect(placeholder1).toBeDefined();
    expect(placeholder1).toBe(placeholder2);

    // Residue resolution: a THIRD, independent request whose history carries req1's
    // token literally (as if echoed from an earlier turn) still resolves it, because
    // masking the fresh mention of the same value re-mints the identical token.
    const req3: any = {
      body: {
        messages: [
          { role: 'assistant', content: `${placeholder1} confirmed the filing.` },
          { role: 'user', content: 'Acme Industries Inc will proceed with the filing.' },
        ],
        masking: {
          method: 'pseudonymization',
          entities: [{ type: 'profile-org' }],
          org_suffixes: ['Inc'],
        },
      },
    };
    await beforeHandler({ req: req3, res: {}, utils: { logger: mockLogger } });
    const map3 = req3.__pseudonymizationMap;
    expect(map3.forward.get('Acme Industries Inc')).toBe(placeholder1);
    expect(unmaskText(`${placeholder1} confirmed the filing.`, map3)).toBe(
      'Acme Industries Inc confirmed the filing.'
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Leak audit: run the same residue audit the existing suite exercises
  //    ("Residue audit (non-streaming)" in test/pseudonymization.test.ts,
  //    reached via the after-handler) over a full org+location round trip
  //    and confirm it reports nothing.
  // ───────────────────────────────────────────────────────────────────────
  it('reports no residue for a clean org+location round trip (leak audit)', async () => {
    const req: any = {
      debugRequestId: 'req-org-location-leak-audit',
      body: {
        messages: [{ role: 'user', content: 'The company to contact is Acme Industries Inc, located in Springfield.' }],
        masking: {
          method: 'pseudonymization',
          entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
          org_suffixes: ['Inc'],
          location_gazetteer: ['Springfield'],
        },
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    const map = req.__pseudonymizationMap;
    const orgPlaceholder = map.forward.get('Acme Industries Inc');
    const locationPlaceholder = map.forward.get('Springfield');
    expect(orgPlaceholder).toBeDefined();
    expect(locationPlaceholder).toBeDefined();

    const upstreamResponse = {
      final_result: {
        choices: [{ message: { content: `Confirmed: ${orgPlaceholder} in ${locationPlaceholder}.` } }],
      },
    };
    const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(result.final_result.choices[0].message.content).toBe('Confirmed: Acme Industries Inc in Springfield.');

    // auditResponseResidue (invoked internally by the after-handler) only logs when
    // MASKED_* residue survives unmasking. A clean round trip logs nothing for it.
    const warnCalls = (mockLogger.warn as any).mock.calls.map((c: any[]) => c.join(' '));
    expect(warnCalls.some((s: string) => s.includes('pseudonymization_residue_unresolved_total'))).toBe(false);
    expect(warnCalls.some((s: string) => s.includes('Unresolvable masked residue'))).toBe(false);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. Task 8 — Group 4: cross-request placeholder stability specifically for
  //    the trailing-period fix. Before this task, the SAME organisation text
  //    masked in two requests with different trailing sentence context (one
  //    sentence-final, one continuing into a lowercase word) minted a period
  //    and a no-period span respectively — two different content-derived
  //    placeholders for one entity (commit f236892's unmaskable-residue
  //    class). The context-free rule fixes that: both requests must resolve
  //    to the SAME map key ("Acme Industries Inc") and therefore the same
  //    placeholder.
  // ───────────────────────────────────────────────────────────────────────
  it('mints the identical placeholder across two requests even when trailing sentence context differs (Task 8)', async () => {
    const masking = {
      method: 'pseudonymization' as const,
      entities: [{ type: 'profile-org' }],
      org_suffixes: ['Inc', 'Inc.', 'LLC', 'GmbH'],
    };
    const req1: any = {
      body: {
        messages: [{ role: 'user', content: 'The contract is with Acme Industries Inc.' }],
        masking,
      },
    };
    const req2: any = {
      body: {
        messages: [{ role: 'user', content: 'Acme Industries Inc. filed today.' }],
        masking,
      },
    };
    await beforeHandler({ req: req1, res: {}, utils: { logger: mockLogger } });
    await beforeHandler({ req: req2, res: {}, utils: { logger: mockLogger } });

    const placeholder1 = req1.__pseudonymizationMap.forward.get('Acme Industries Inc');
    const placeholder2 = req2.__pseudonymizationMap.forward.get('Acme Industries Inc');
    expect(placeholder1).toBeDefined();
    expect(placeholder1).toBe(placeholder2);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. Task 8 — Group 5: round-trip losslessness for every Group 1 / Group 2
  //    input (see test/pseudonymization-org-location.test.ts for the
  //    detection-level assertions on the same inputs). Mask then unmask and
  //    the result must be byte-identical to the input — proof the trim
  //    leaves the period in the surrounding text rather than deleting it.
  // ───────────────────────────────────────────────────────────────────────
  describe('Task 8 — Group 5: round-trip losslessness', () => {
    const roundTrip = (text: string, config: MaskingConfig): string => {
      const map = new ReplacementMap('pseudonymization');
      const matches = detectEntities(text, config);
      const masked = replaceEntities(text, matches, map, config);
      return unmaskText(masked, map);
    };

    const group1Config: MaskingConfig = {
      method: 'pseudonymization',
      entities: [{ type: 'profile-org' }],
      org_suffixes: ['Inc', 'Inc.', 'LLC', 'GmbH'],
    };
    const group1Inputs = [
      'The contract is with Acme Industries Inc.',
      'Acme Industries Inc. filed today.',
      'We work with Acme Industries Inc on that project.',
      'Acme Industries Inc, a supplier, agreed.',
      '(Acme Industries Inc.)',
      '...said Acme Industries Inc.',
      'Acme Industries Inc',
      'Acme Industries Inc.\nNext line.',
      'Acme Industries Inc. Later we met.',
    ];

    it.each(group1Inputs)('Group 1 input round-trips byte-identical: %s', (text) => {
      expect(roundTrip(text, group1Config)).toBe(text);
    });

    const group2Config: MaskingConfig = {
      method: 'pseudonymization',
      entities: [{ type: 'profile-org' }],
      org_suffixes: ['S.A.', 'L.L.C.', 'B.V.', 'Inc.'],
    };
    const group2Inputs = [
      'Acme S.A. filed today.',
      'The contract is with Acme S.A.',
      'Contoso L.L.C. reported.',
      'Fabrikam B.V. agreed.',
      'Acme Industries Inc. filed.',
    ];

    it.each(group2Inputs)('Group 2 input round-trips byte-identical: %s', (text) => {
      expect(roundTrip(text, group2Config)).toBe(text);
    });
  });
});
