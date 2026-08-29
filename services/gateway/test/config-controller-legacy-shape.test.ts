/**
 * PUT/PATCH /config used to check only that `api_config` existed. An external
 * npm-dist user sending a body written against the pre-restructure flat layout
 * therefore got a 200 and a silent no-op: the deep-merge added top-level keys
 * nothing reads, and the settings they meant to change never applied.
 *
 * These tests cover the diagnostic that replaces that silence, and — just as
 * importantly — that a correctly shaped body still goes through untouched.
 */
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfigAsync: jest.fn(),
    updateConfig: jest.fn(async (config: unknown) => config),
    patchConfig: jest.fn(async (patch: unknown) => patch),
  },
}));

import { updateConfig, patchConfig } from '../src/controllers/configController';
import configService from '../src/services/configService';
import { LEGACY_SECTION_MOVES } from '../src/utils/legacyConfigShape';

function fakeResponse() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

const next = jest.fn();

describe('legacy api_config section map', () => {
  it('covers all twenty pre-restructure sections', () => {
    expect(Object.keys(LEGACY_SECTION_MOVES)).toHaveLength(20);
  });

  it('points every section at one of the six groups', () => {
    const groups = new Set(
      Object.values(LEGACY_SECTION_MOVES).map((target) => target.split('.')[0])
    );
    expect([...groups].sort()).toEqual([
      'capabilities', 'hooks', 'models', 'observability', 'platform', 'providers',
    ]);
  });
});

describe('PUT /config rejects a pre-restructure body', () => {
  it('answers 400 and names each offending section and its new home', async () => {
    const res = fakeResponse();
    await updateConfig(
      { body: { api_config: { timeouts: { default: 1000 }, model_list_changes: {} } } } as any,
      res,
      next
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('timeouts -> platform.timeouts');
    expect(res.body.error).toContain('model_list_changes -> models.overrides');
    expect(res.body.moved_sections).toEqual({
      timeouts: 'platform.timeouts',
      model_list_changes: 'models.overrides',
    });
    // The whole point: nothing was written.
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('still accepts a new-shape body', async () => {
    const res = fakeResponse();
    const body = { api_config: { platform: { timeouts: { default: 1000 } } } };
    await updateConfig({ body } as any, res, next);

    expect(res.statusCode).toBe(200);
    expect(configService.updateConfig).toHaveBeenCalledWith(body);
  });
});

describe('PATCH /config rejects a pre-restructure body', () => {
  it('answers 400 rather than deep-merging keys nothing reads', async () => {
    const res = fakeResponse();
    await patchConfig({ body: { api_config: { siem: { enabled: true } } } } as any, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('siem -> observability.siem');
    expect(configService.patchConfig).not.toHaveBeenCalled();
  });

  it('still accepts a new-shape patch', async () => {
    const res = fakeResponse();
    const body = { api_config: { observability: { siem: { enabled: true } } } };
    await patchConfig({ body } as any, res, next);

    expect(res.statusCode).toBe(200);
    expect(configService.patchConfig).toHaveBeenCalledWith(body);
  });

  it('does not mistake a new-shape group for an old section name', async () => {
    // `models`, `hooks`, `platform` and friends are group names now; only the
    // twenty old leaf names are rejected, and only at api_config's top level.
    const res = fakeResponse();
    const body = { api_config: { models: { overrides: { 'some-model': { hooks: {} } } } } };
    await patchConfig({ body } as any, res, next);

    expect(res.statusCode).toBe(200);
  });

  it('does not mistake inherited Object.prototype keys for old sections', async () => {
    // `key in LEGACY_SECTION_MOVES` walked the prototype chain, so a body with a
    // top-level `toString` or `constructor` was answered 400 with a nonsense
    // move ("constructor -> function Object() { [native code] }").
    const res = fakeResponse();
    const body = {
      api_config: {
        toString: 'not a section',
        constructor: 'not a section',
        hasOwnProperty: 'not a section',
        platform: { timeouts: { default: 1000 } },
      },
    };
    await patchConfig({ body } as any, res, next);

    expect(res.statusCode).toBe(200);
  });

  it('ignores old names nested below the top level', async () => {
    // capabilities.web_search is the section's correct new home; the name check
    // must not fire on the leaf it moved to.
    const res = fakeResponse();
    const body = { api_config: { capabilities: { web_search: { enabled: true } } } };
    await patchConfig({ body } as any, res, next);

    expect(res.statusCode).toBe(200);
  });
});
