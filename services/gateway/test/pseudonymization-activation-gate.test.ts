/**
 * THE GATE, NOT THE FALLBACK.
 *
 * `chunkMasking.ts`'s `effectiveConfig` falls back to `DEFAULT_MASKING_CONFIG` when the
 * request's own `MaskingConfig` has an empty `entities` list. That fallback is UNREACHABLE
 * in production today, and a review asked for it to be covered. Covering the fallback
 * directly is the wrong test: the only honest way to reach it is to call
 * `maskThroughRequestMap` with a hand-built config no request can produce, which pins
 * nothing about the system and would keep passing after the property that makes it
 * unreachable was destroyed.
 *
 * WHAT MAKES IT UNREACHABLE is a single early return in the pseudonymization before
 * handler: a config with no `entities` never activates masking at all, so
 * `__pseudonymization` is never stashed on the request, so the engine has nothing to read
 * into `ToolExecCtx.maskingConfig`, so `maskThroughRequestMap` is handed `undefined` (the
 * no-map path, which returns the text untouched) rather than an empty-entities config.
 *
 * WHY IT MATTERS THAT THE GATE STAYS. Relaxing that early return — letting an
 * empty-`entities` config through as "masking is on, just with nothing configured" — would
 * hand `chunkMasking` a config whose `custom_entities` tier is present but whose category
 * list is empty. That is the shape of the leak Task 8 closed: a caller who declared "mask
 * anything matching `EMP-\d{6}`" would get their badge numbers masked in the prompt and
 * shipped verbatim inside every retrieved passage sent to the deployment.
 *
 * So this suite pins the GATE. It is the property the fallback's unreachability rests on,
 * it is the property whose loss is a security regression, and unlike the fallback it is
 * reachable from a real request body.
 *
 * @see ../src/plugins/pseudonymization/index.ts - the early return, and the stash below it
 * @see ../src/plugins/fileSearch/chunkMasking.ts - effectiveConfig, and its header's
 *      account of the custom_entities leak
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

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

import pluginRules = require('../src/plugins/pseudonymization/index');
import { maskThroughRequestMap } from '../src/plugins/fileSearch/chunkMasking';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';

const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

/** A body carrying content every detector category would match, so "nothing was masked"
 *  can only mean the gate closed — never that there was nothing to find. */
function reqWith(masking: any): any {
  return {
    body: {
      messages: [{ role: 'user', content: 'John Smith, john@example.com, badge EMP-004417' }],
      ...(masking === undefined ? {} : { masking }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.api_config.pseudonymization = undefined;
  mockConfig.api_config.defaultHooks = {};
  mockConfig.api_config.model_list_changes = {};
});

describe('pseudonymization does not activate on a config with no entities', () => {
  it('stashes NO __pseudonymization when entities is an empty array', async () => {
    const req = reqWith({ method: 'pseudonymization', entities: [] });

    const result = await beforeHandler({ req, res: {}, utils: { logger } });

    // The gate. Relax the `entities.length === 0` early return and this fails first.
    expect(req.__pseudonymization).toBeUndefined();
    expect(req.__pseudonymizationMap).toBeUndefined();
    expect(result.stop).toBe(false);
    // ...and, because no map was built, the body is forwarded unchanged.
    expect(req.body.messages[0].content).toBe('John Smith, john@example.com, badge EMP-004417');
  });

  it('stashes NO __pseudonymization when entities is missing entirely', async () => {
    const req = reqWith({ method: 'pseudonymization' });

    await beforeHandler({ req, res: {}, utils: { logger } });

    expect(req.__pseudonymization).toBeUndefined();
    expect(req.__pseudonymizationMap).toBeUndefined();
  });

  it('stashes NO __pseudonymization when method is missing', async () => {
    // The same early return guards `method`; both halves are load-bearing.
    const req = reqWith({ entities: [{ type: 'profile-person' }] });

    await beforeHandler({ req, res: {}, utils: { logger } });

    expect(req.__pseudonymization).toBeUndefined();
  });

  it('an empty-entities config does not survive as custom_entities-only activation', async () => {
    // The precise shape of the Task 8 leak, asked directly: a caller declaring a custom
    // regex tier but no categories must not activate masking with an entities-less config,
    // because that config is what would then reach chunkMasking as "the request's own".
    const req = reqWith({
      method: 'pseudonymization',
      entities: [],
      custom_entities: [{ type: 'badge', pattern: 'EMP-\\d{6}' }],
    });

    await beforeHandler({ req, res: {}, utils: { logger } });

    expect(req.__pseudonymization).toBeUndefined();
  });

  it('CONTRAST: a config WITH entities does activate and does stash the state', async () => {
    // Without this, every assertion above would still pass against a before handler that
    // had stopped working entirely.
    const req = reqWith({ method: 'pseudonymization', entities: [{ type: 'profile-person' }] });

    await beforeHandler({ req, res: {}, utils: { logger } });

    expect(req.__pseudonymization).toBeDefined();
    expect(req.__pseudonymization.config.entities).toHaveLength(1);
    expect(req.__pseudonymizationMap).toBeDefined();
    expect(req.body.messages[0].content).toContain('MASKED_');
  });
});

describe('the chunk-masking consumer therefore never sees an entities-less config', () => {
  it('gets `undefined` for both map and config on a non-activating request, and no-ops', async () => {
    // The composition the two suites above are really about: what the engine can hand a
    // descriptor is read off `req.__pseudonymization`, so when the gate closes there is no
    // map — and `maskThroughRequestMap`'s no-map path returns the text untouched, which is
    // correct (there would be nothing to unmask against on the way back out).
    const req = reqWith({ method: 'pseudonymization', entities: [] });
    await beforeHandler({ req, res: {}, utils: { logger } });

    const state = req.__pseudonymization;
    expect(state).toBeUndefined();

    const chunk = 'Contact John Smith at john@example.com';
    expect(maskThroughRequestMap(chunk, req.__pseudonymizationMap, state?.config)).toBe(chunk);
  });

  it('an ACTIVE request hands chunkMasking a config that carries its categories', async () => {
    const req = reqWith({ method: 'pseudonymization', entities: [{ type: 'profile-email' }] });
    await beforeHandler({ req, res: {}, utils: { logger } });

    const config = req.__pseudonymization.config;
    expect(config.entities.length).toBeGreaterThan(0);

    // The same live map production would extend, so this exercises the real registration
    // path rather than a stand-in.
    const map: ReplacementMap = req.__pseudonymizationMap;
    const masked = maskThroughRequestMap('Reach her at jane.roe@example.com', map, config);
    expect(masked).toContain('MASKED_EMAIL_');
    expect(masked).not.toContain('jane.roe@example.com');
  });
});
