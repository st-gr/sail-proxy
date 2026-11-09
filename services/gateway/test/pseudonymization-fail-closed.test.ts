/**
 * A masking error refuses the request when pseudonymization is forced, instead of sending it
 * unmasked. "Forced" is the configuration's force flag for the route (hooks.defaults.<endpoint>)
 * or for the model (models.overrides.<model>). Not forced, a masking error keeps today's
 * behaviour: logged, and the request goes on. Other plugins keep continue-on-error.
 *
 * The plugin executor, plugin loader matching and pseudonymization plugin are the REAL modules;
 * only the detector entry point is wrapped so a test can make it throw.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const logged: Array<{ level: string; args: any[] }> = [];
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => logged.push({ level: 'error', args }),
    warn: (...args: any[]) => logged.push({ level: 'warn', args }),
    info: () => {}, debug: () => {}, trace: () => {},
  }),
}));

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => {
      if (mockConfigReadThrows) throw new Error('configuration unavailable');
      return m;
    },
  };
  return { __esModule: true, default: svc, ...svc };
});
let mockConfigReadThrows = false;

// wink-nlp wrapped so a test can make NER detection throw at run time (readDoc).
let mockNerThrows = false;
jest.mock('wink-nlp', () => {
  const actual: any = jest.requireActual('wink-nlp');
  return (...args: any[]) => {
    const inst = actual(...args);
    return new Proxy(inst, {
      get: (t: any, k: string) => (k === 'readDoc' && mockNerThrows
        ? () => { throw new Error('ner failed'); }
        : t[k]),
    });
  };
});

let mockDetectorThrows = false;
jest.mock('../src/pluginSupport/pseudonymization/detectors', () => {
  const actual: any = jest.requireActual('../src/pluginSupport/pseudonymization/detectors');
  return {
    ...actual,
    detectEntities: (text: string, ...rest: any[]) => {
      // The message quotes the text, as a real detector error can: it must not reach the log.
      if (mockDetectorThrows) throw new Error(`detector failed on: ${text}`);
      return actual.detectEntities(text, ...rest);
    },
  };
});

import { executeBeforePlugins } from '../src/services/pluginExecutor';
import { describeErrorWithoutContent } from '../src/pluginSupport/pseudonymization/failClosed';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;

const EMAIL = 'jane.roe@example.org';
const PSEUDO_HOOK = { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['header:contentTypeJson'] } };
const hookFor = (id: string) => ({ request: { callback: { id }, match: ['header:contentTypeJson'] } });

function mockRes() {
  const r: any = { statusCode: 200, body: undefined, headersSent: false, writableEnded: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function mockReq(body: any, endpoint = 'openai') {
  return {
    body,
    headers: { 'content-type': 'application/json' },
    query: {},
    __endpoint: endpoint,
  } as any;
}

const chatBody = (extra: Record<string, any> = {}) => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: `Please email ${EMAIL} about the invoice.` }],
  ...extra,
});

const allLogText = () => JSON.stringify(logged.map((l) => l.args));

let ranAfterExploding = 0;

describe('a pseudonymization error when masking is forced', () => {
  beforeAll(() => {
    (global as any).pluginRegistry = {};
    (pseudonymizationRules as any[]).forEach((rule: any, i: number) => {
      (global as any).pluginRegistry[`${rule.id}_${rule.strategy}_${i}`] = rule;
    });
    (global as any).pluginRegistry.exploding_before = {
      id: 'explodingPlugin', strategy: 'before', match: [],
      handler: () => { throw new Error('exploding plugin'); },
    };
    (global as any).pluginRegistry.counting_before = {
      id: 'countingPlugin', strategy: 'before', match: [],
      handler: () => { ranAfterExploding++; return { stop: false }; },
    };
  });

  beforeEach(() => {
    mockConfig.api_config = {
      hooks: JSON.parse(JSON.stringify(shippedHooks)),
      models: { overrides: {} },
      observability: {},
    };
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockNerThrows = false;
    mockConfigReadThrows = false;
    logged.length = 0;
    ranAfterExploding = 0;
  });

  it('refuses with 503 pseudonymization_failed when the route forces masking', async () => {
    mockDetectorThrows = true;
    const req = mockReq(chatBody());
    const res = mockRes();

    const result = await executeBeforePlugins(req, res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: { message: expect.any(String), type: 'api_error', code: 'pseudonymization_failed' },
    });
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    // The error is logged, without the request content its message quoted.
    expect(logged.some((l) => l.level === 'error')).toBe(true);
    expect(allLogText()).not.toContain(EMAIL);
  });

  it('refuses when only the model forces masking', async () => {
    mockConfig.api_config.hooks.defaults.openai.pseudonymization.enabled = false;
    mockConfig.api_config.models.overrides['gpt-4o'] = { pseudonymization: { enabled: true } };
    mockDetectorThrows = true;
    const res = mockRes();

    const result = await executeBeforePlugins(mockReq(chatBody()), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_failed');
  });

  it('refuses when the caller sends its own masking config on a forced route and masking fails', async () => {
    mockDetectorThrows = true;
    const res = mockRes();
    const body = chatBody({ masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }] } });

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it('refuses when the forced configuration leaves no entity to mask', async () => {
    // Every default category switched off for the endpoint.
    const off: Record<string, boolean> = {};
    const defaults = (jest.requireActual('../src/pluginSupport/pseudonymization/defaultMaskingConfig') as any)
      .DEFAULT_MASKING_CONFIG.entities as Array<{ type: string }>;
    for (const e of defaults) off[e.type] = false;
    mockConfig.api_config.hooks.defaults.openai.pseudonymization.entities = off;
    const res = mockRes();

    const result = await executeBeforePlugins(mockReq(chatBody()), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_failed');
  });

  it('masks with the forced set when a caller masking config has an empty entity list on a forced route', async () => {
    const res = mockRes();
    const body = chatBody({ masking: { method: 'pseudonymization', entities: [] } });

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(false);
    expect(JSON.stringify(body.messages)).not.toContain(EMAIL);
  });

  it('refuses a caller masking config that disables every entity it lists on a forced route', async () => {
    const res = mockRes();
    const body = chatBody({ masking: { method: 'pseudonymization', entities: [{ type: 'profile-email', enabled: false }] } });

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(body.messages[0].content).toContain(EMAIL); // nothing was sent, nothing was masked
  });

  it('refuses on the anthropic endpoint the same way', async () => {
    mockDetectorThrows = true;
    const res = mockRes();
    const body = { model: 'claude-sonnet-4', max_tokens: 10, messages: [{ role: 'user', content: `Mail ${EMAIL}` }] };

    const result = await executeBeforePlugins(mockReq(body, 'anthropic'), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_failed');
  });

  it('refuses when an error escapes the pseudonymization plugin while masking is forced', async () => {
    const res = mockRes();
    const saved = (global as any).pluginRegistry;
    // Only this rule answers for the pseudonymization id here: it marks the request forced, as the
    // plugin does once it resolved the force flag, and then throws past its own error handling.
    (global as any).pluginRegistry = {
      escaping_before: {
        id: 'pseudonymizationPlugin', strategy: 'before', match: [],
        handler: ({ req }: any) => { req.__pseudonymizationForced = true; throw new Error(`escaped ${EMAIL}`); },
      },
    };
    try {
      const result = await executeBeforePlugins(mockReq(chatBody()), res, [PSEUDO_HOOK]);
      expect(result.stop).toBe(true);
      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('pseudonymization_failed');
      expect(allLogText()).not.toContain(EMAIL);
    } finally {
      (global as any).pluginRegistry = saved;
    }
  });
});

describe('a pseudonymization error when masking is not forced', () => {
  beforeEach(() => {
    // The shipped hooks (their matcher definitions included) with every force flag off.
    const hooks = JSON.parse(JSON.stringify(shippedHooks));
    for (const entry of Object.values(hooks.defaults) as any[]) {
      if (entry?.pseudonymization) entry.pseudonymization.enabled = false;
    }
    mockConfig.api_config = { hooks, models: { overrides: {} }, observability: {} };
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockNerThrows = false;
    mockConfigReadThrows = false;
    logged.length = 0;
    ranAfterExploding = 0;
  });

  it('logs the error and lets the request go on (caller-requested masking)', async () => {
    mockDetectorThrows = true;
    const res = mockRes();
    const body = chatBody({ masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }] } });

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(false);
    expect(res.body).toBeUndefined();
    expect(logged.some((l) => l.level === 'error')).toBe(true);
    expect(allLogText()).not.toContain(EMAIL);
  });

  it('skips an empty caller entity list with a warning, as before', async () => {
    const res = mockRes();
    const body = chatBody({ masking: { method: 'pseudonymization', entities: [] } });

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(false);
    expect(res.body).toBeUndefined();
  });

  it('continues past an error that escapes the pseudonymization plugin', async () => {
    const saved = (global as any).pluginRegistry;
    (global as any).pluginRegistry = {
      escaping_before: { id: 'pseudonymizationPlugin', strategy: 'before', match: [], handler: () => { throw new Error(`escaped ${EMAIL}`); } },
    };
    try {
      const res = mockRes();
      const result = await executeBeforePlugins(mockReq(chatBody()), res, [PSEUDO_HOOK]);
      expect(result.stop).toBe(false);
      expect(res.body).toBeUndefined();
      expect(logged.some((l) => l.level === 'error')).toBe(true);
      expect(allLogText()).not.toContain(EMAIL);
    } finally {
      (global as any).pluginRegistry = saved;
    }
  });
});

describe('another plugin throwing', () => {
  beforeEach(() => {
    mockConfig.api_config = {
      hooks: JSON.parse(JSON.stringify(shippedHooks)),
      models: { overrides: {} },
      observability: {},
    };
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockNerThrows = false;
    mockConfigReadThrows = false;
    logged.length = 0;
    ranAfterExploding = 0;
  });

  it('keeps continue-on-error even when masking is forced', async () => {
    const res = mockRes();
    const req = mockReq(chatBody());

    const result = await executeBeforePlugins(req, res, [hookFor('explodingPlugin'), hookFor('countingPlugin'), PSEUDO_HOOK]);

    expect(result.stop).toBe(false);
    expect(res.body).toBeUndefined();
    expect(ranAfterExploding).toBe(1);
    // and the pseudonymization plugin after it still masked the request
    expect(JSON.stringify(req.body)).not.toContain(EMAIL);
  });
});

const PERSON = 'Lena Marquardt';
const personBody = (extra: Record<string, any> = {}) => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: `Please ask ${PERSON} to email ${EMAIL} about the invoice.` }],
  ...extra,
});

describe('a detector tier that cannot run', () => {
  beforeEach(() => {
    mockConfig.api_config = {
      hooks: JSON.parse(JSON.stringify(shippedHooks)),
      models: { overrides: {} },
      observability: {},
    };
    (global as any).matcherCache?.clear?.();
    mockDetectorThrows = false;
    mockNerThrows = false;
    mockConfigReadThrows = false;
    logged.length = 0;
  });

  it('forced: a NER error refuses the request instead of sending person names unmasked', async () => {
    mockNerThrows = true;
    const res = mockRes();
    const body = personBody();

    const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_failed');
    expect(allLogText()).not.toContain(PERSON);
  });

  it('not forced: a NER error skips that tier and the rest still masks, as before', async () => {
    for (const entry of Object.values(mockConfig.api_config.hooks.defaults) as any[]) {
      if (entry?.pseudonymization) entry.pseudonymization.enabled = false;
    }
    mockNerThrows = true;
    const res = mockRes();
    const body = personBody({ masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }, { type: 'profile-person' }] } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await executeBeforePlugins(mockReq(body), res, [PSEUDO_HOOK]);

      expect(result.stop).toBe(false);
      expect(res.body).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(EMAIL);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refuses when the configuration cannot be read to tell whether masking is forced', async () => {
    mockConfigReadThrows = true;
    const res = mockRes();

    const result = await executeBeforePlugins(mockReq(chatBody()), res, [PSEUDO_HOOK]);

    expect(result.stop).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_failed');
  });

  it('logs an invalid caller regex without its pattern or the error message', async () => {
    for (const entry of Object.values(mockConfig.api_config.hooks.defaults) as any[]) {
      if (entry?.pseudonymization) entry.pseudonymization.enabled = false;
    }
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const body = chatBody({
        masking: { method: 'pseudonymization', entities: [{ type: 'profile-email' }], custom_entities: [{ pattern: `(${PERSON}` }] },
      });
      const result = await executeBeforePlugins(mockReq(body), mockRes(), [PSEUDO_HOOK]);

      expect(result.stop).toBe(false);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(PERSON);
      expect(allLogText()).not.toContain(PERSON);
      expect(allLogText()).toContain('custom_entities pattern from the request is invalid');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('describeErrorWithoutContent', () => {
  it('drops a message line that looks like a stack frame', () => {
    const error = new Error(`parse failed\n    at quoted (${EMAIL})`);
    const out = describeErrorWithoutContent(error);
    expect(out).not.toContain(EMAIL);
    expect(out).toMatch(/^Error\n\s+at /);
  });
});
