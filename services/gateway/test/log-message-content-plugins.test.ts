/**
 * Plugins log through `utils.logger(message, meta)`. A web search query and an image URL from the
 * request are conversation content: the console line keeps them (as metadata), the entry shipped
 * for the stored log does not. A plugin's metadata at ERROR reaches the console as metadata and
 * never the stored error field.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockRemoteUrlToDataUrl: jest.Mock<any> = jest.fn();
jest.mock('../src/utils/imageUtils', () => ({ remoteUrlToDataUrl: (...a: any[]) => (mockRemoteUrlToDataUrl as any)(...a) }));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getSAPAICoreConfig: () => { throw new Error('SAP AI Core is not configured'); } },
}));
const mockSelectRule: jest.Mock<any> = jest.fn();
const mockGetRule: jest.Mock<any> = jest.fn();
jest.mock('../src/services/pluginLoader', () => ({
  __esModule: true,
  default: {
    selectRule: (...a: any[]) => (mockSelectRule as any)(...a),
    matchAll: () => true,
    getRule: (...a: any[]) => (mockGetRule as any)(...a),
  },
}));
jest.mock('../src/pluginSupport/webSearch/searchExecutor', () => {
  const actual = jest.requireActual('../src/pluginSupport/webSearch/searchExecutor') as any;
  return { ...actual, executeWebSearch: jest.fn(actual.executeWebSearch) };
});

import { getDefaultLogger } from '@libs/logger';
import { executeWebSearch } from '../src/pluginSupport/webSearch/searchExecutor';
import { webSearchDescriptor } from '../src/pluginSupport/webSearch/descriptor';
import imagePluginRules = require('../src/plugins/responsesImagePlugin/index');
import { executeBeforePlugins, executeAfterPlugins } from '../src/services/pluginExecutor';
import { EXEMPT_FLAG } from '../src/pluginSupport/pseudonymization/failClosed';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';
const logger = getDefaultLogger();
// A plugin's logger as pluginExecutor hands it over (the rule id is the component).
const pluginLogger = {
  error: (m: string, meta?: any) => logger.error('probe', m, undefined, meta),
  warn: (m: string, meta?: any) => logger.warn('probe', m, meta),
  info: (m: string, meta?: any) => logger.info('probe', m, meta),
  debug: (m: string, meta?: any) => logger.debug('probe', m, meta),
  trace: (m: string, meta?: any) => logger.trace('probe', m, meta),
};

describe('plugin log lines keep content out of the shipped log', () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleLines = [];
    shipped = [];
    for (const m of ['info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((l: unknown) => { consoleLines.push(String(l)); });
    }
    stop = startLogShipper({ publish: async (b) => { shipped.push(...b); }, settings: () => ({ enabled: true, minLevel: 'INFO' }), warn: () => undefined });
  });
  afterEach(() => { stop(); jest.useRealTimers(); jest.restoreAllMocks(); });

  const lineAndEntry = async (message: string): Promise<{ line: string; entry: ShippedLogEntry }> => {
    await jest.advanceTimersByTimeAsync(1000);
    const line = consoleLines.find((l) => l.includes(message) && l.includes(MARKER));
    const entry = shipped.find((e) => e.message.includes(message));
    expect(line).toBeDefined();
    expect(entry).toBeDefined();
    expect(JSON.stringify(shipped)).not.toContain(MARKER);
    return { line: line as string, entry: entry as ShippedLogEntry };
  };

  it('the web search query: on the console, not in the shipped entry', async () => {
    await expect(executeWebSearch(`${MARKER} weather`, pluginLogger)).resolves.toEqual([]);
    await lineAndEntry('Executing web search via Perplexity sonar-pro');
  });

  it('a failed hosted web search: the query is on the console, the shipped entry says what failed', async () => {
    (executeWebSearch as jest.Mock<any>).mockRejectedValueOnce(new Error('search provider unreachable'));
    const result = await webSearchDescriptor.execute(
      { callId: 'ws_1', rawArguments: '', args: { query: `${MARKER} weather` } } as any,
      { logger: pluginLogger, remask: (q: string) => q, isStreaming: false } as any,
    );
    expect(result.status).toBe('failed');
    const { entry } = await lineAndEntry('Web search failed');
    expect(entry).toMatchObject({ level: 'ERROR', message: 'Web search failed: search provider unreachable' });
    expect(entry.error).toBeUndefined();
  });

  describe('the image plugin', () => {
    const handler = (imagePluginRules as any)[0].handler;
    const url = `https://example.org/${MARKER}.png`;
    const request = () => ({
      __responsesRoute: 'orchestration',
      body: { input: [{ role: 'user', content: [{ type: 'input_image', image_url: url }] }] },
    });
    const response = () => ({ headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

    it('an inlined image URL: on the console, not in the shipped entry', async () => {
      mockRemoteUrlToDataUrl.mockResolvedValueOnce('data:image/png;base64,AAAA');
      await handler({ req: request(), res: response(), utils: { logger: pluginLogger } });
      await lineAndEntry('inlined a remote input_image');
    });

    it('a failed download: the URL is on the console, the shipped entry keeps the reason', async () => {
      mockRemoteUrlToDataUrl.mockRejectedValueOnce(new Error('Request failed with status code 404'));
      await handler({ req: request(), res: response(), utils: { logger: pluginLogger } });
      const { entry } = await lineAndEntry('failed to download input_image');
      expect(entry.message).toContain('Request failed with status code 404');
    });
  });

  it("pluginExecutor passes a plugin's ERROR metadata as metadata: on the console, not in the shipped error", async () => {
    mockSelectRule.mockReturnValueOnce({
      ruleId: 'probe',
      rule: {
        strategy: 'before',
        handler: async ({ utils }: any) => {
          utils.logger.error('probe failed', { message: `${MARKER} as a query`, stack: 'Error: x\n    at probe' });
          return { stop: false };
        },
      },
    });
    await executeBeforePlugins({ [EXEMPT_FLAG]: true } as any, {} as any, { id: 'probe' } as any);
    const { line, entry } = await lineAndEntry('probe failed');
    expect(line).toContain('"stack"');
    expect(entry).toEqual(expect.objectContaining({ level: 'ERROR', component: 'probe', message: 'probe failed' }));
    expect(entry.error).toBeUndefined();
  });

  it('pluginExecutor still passes an Error a plugin hands over as the error', async () => {
    mockSelectRule.mockReturnValueOnce({
      ruleId: 'probe',
      rule: { strategy: 'before', handler: async ({ utils }: any) => { utils.logger.error('probe threw', new Error('boom')); return { stop: false }; } },
    });
    await executeBeforePlugins({ [EXEMPT_FLAG]: true } as any, {} as any, { id: 'probe' } as any);
    await jest.advanceTimersByTimeAsync(1000);
    expect(shipped.find((e) => e.message === 'probe threw')).toMatchObject({ error: 'Error: boom' });
  });

  describe("a plugin that throws: the stored entry names the plugin and the phase; the stack stays on the console", () => {
    const thrown = () => Object.assign(new Error('boom'), { stack: `Error: boom\n    at ${MARKER} (/plugins/probe.js:1:1)` });

    it('before', async () => {
      mockSelectRule.mockReturnValueOnce({ ruleId: 'probe', rule: { strategy: 'before', handler: async () => { throw thrown(); } } });
      await executeBeforePlugins({ [EXEMPT_FLAG]: true } as any, {} as any, { id: 'probe' } as any);
      await jest.advanceTimersByTimeAsync(1000);
      expect(consoleLines.some((l) => l.includes(MARKER))).toBe(true);
      expect(JSON.stringify(shipped)).not.toContain(MARKER);
      expect(shipped.find((e) => e.component === 'PluginExecutor' && e.level === 'ERROR'))
        .toMatchObject({ message: "Error executing plugin 'probe' (before)", error: 'Error: boom' });
    });

    it('after', async () => {
      mockGetRule.mockReturnValueOnce({ strategy: 'after', handler: async () => { throw thrown(); } });
      await executeAfterPlugins({} as any, {} as any, { ok: true }, { request: { match: [], callback: { id: 'probe' } } } as any);
      await jest.advanceTimersByTimeAsync(1000);
      expect(consoleLines.some((l) => l.includes(MARKER))).toBe(true);
      expect(JSON.stringify(shipped)).not.toContain(MARKER);
      expect(shipped.find((e) => e.component === 'PluginExecutor' && e.level === 'ERROR'))
        .toMatchObject({ message: "Error executing plugin 'probe' (after)", error: 'Error: boom' });
    });
  });
});
