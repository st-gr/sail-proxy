/**
 * An upstream's error body is for the console only: the log line printed on the console still holds
 * it (as metadata), but the entry the gateway ships to Valkey carries the status and a short
 * description, never the body.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://mock-sap.example.com', resourceGroup: 'default' }),
    getDeploymentId: () => Promise.resolve('mock-deployment-id'),
    getAccessToken: () => Promise.resolve('mock-token'),
    getTimeout: () => 30000,
    getModelListChanges: () => ({}),
  },
}));
jest.mock('../src/services/modelService', () => ({ __esModule: true, default: { markModelAsNonStreaming: jest.fn() } }));

const mockPost: jest.Mock<any> = jest.fn();
const mockGet: jest.Mock<any> = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...a: any[]) => (mockPost as any)(...a),
    get: (...a: any[]) => (mockGet as any)(...a),
    isCancel: () => false,
  },
}));

import sapAIService from '../src/services/sapAIService';
import { getOrchestrationDeployments, clearCache } from '../src/services/deploymentDiscoveryService';
import BedrockStreamParser from '../src/utils/bedrockStreamParser';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const BODY = 'UPSTREAM-BODY-TEXT-of-Jane-Roe';
const rejection = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status, data: { error: { message: BODY } } },
});

describe('upstream bodies stay out of the shipped log', () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(async () => {
    jest.useFakeTimers();
    consoleLines = [];
    shipped = [];
    const grab = (l: unknown) => { consoleLines.push(String(l)); };
    for (const m of ['info', 'warn', 'error', 'debug'] as const) jest.spyOn(console, m).mockImplementation(grab);
    stop = startLogShipper({
      publish: async (b) => { shipped.push(...b); },
      settings: () => ({ enabled: true, minLevel: 'INFO' }),
      warn: () => undefined,
    });
    mockPost.mockReset();
    mockGet.mockReset();
  });
  afterEach(() => { stop(); jest.useRealTimers(); jest.restoreAllMocks(); });

  const shippedText = async () => {
    await jest.advanceTimersByTimeAsync(1000);
    return JSON.stringify(shipped);
  };
  const onConsole = () => consoleLines.filter((l) => l.includes(BODY));

  it('completeChat: the console line holds the body, the shipped entry does not', async () => {
    mockPost.mockRejectedValue(rejection(400));
    await expect(sapAIService.completeChat({ config: {} } as any)).rejects.toBeDefined();
    expect(onConsole().some((l) => l.includes('Response data from SAP AI Core'))).toBe(true);
    const text = await shippedText();
    expect(text).not.toContain(BODY);
    expect(shipped.some((e) => e.message === 'Response data from SAP AI Core')).toBe(true);
    expect(shipped.some((e) => e.message === 'Response status: 400')).toBe(true);
  });

  it('callSAPAIOrchestration: the console line holds the body, the shipped entry does not', async () => {
    mockPost.mockRejectedValue(rejection(400));
    await expect(sapAIService.callSAPAIOrchestration({ config: {} } as any)).rejects.toBeDefined();
    expect(onConsole().length).toBeGreaterThan(0);
    expect(await shippedText()).not.toContain(BODY);
  });

  it('createEmbedding: the console line holds the body, the shipped entry does not and keeps the status', async () => {
    mockPost.mockRejectedValue(rejection(429));
    await expect(sapAIService.createEmbedding({ input: 'x' }, 'text-embedding-3-small')).rejects.toBeDefined();
    expect(onConsole().some((l) => l.includes('SAP AI Core error response: 429'))).toBe(true);
    expect(await shippedText()).not.toContain(BODY);
    expect(shipped.some((e) => e.message === 'SAP AI Core error response: 429')).toBe(true);
  });

  it('deployment discovery: the console line holds the body, the shipped entry does not', async () => {
    clearCache();
    mockGet.mockRejectedValue(rejection(400));
    await getOrchestrationDeployments(true).catch(() => undefined);
    expect(onConsole().some((l) => l.includes('API Error - Status: 400'))).toBe(true);
    expect(await shippedText()).not.toContain(BODY);
    expect(shipped.some((e) => e.message === 'API Error - Status: 400')).toBe(true);
  });

  it('model list: the deployment fetch error holds the body on the console, not in the shipped entry', async () => {
    process.env.AUTH_URL = 'https://auth.example/oauth/token';
    process.env.CLIENT_ID = 'id';
    process.env.CLIENT_SECRET = 'secret';
    const real = jest.requireActual('../src/services/modelService') as typeof import('../src/services/modelService');
    real.clearAllCaches();
    mockPost.mockResolvedValue({ data: { access_token: 't', expires_in: 3600 } });
    mockGet.mockImplementation((url: unknown) => String(url).includes('/lm/scenarios/foundation-models/models')
      ? Promise.resolve({ data: { resources: [] } })
      : Promise.reject(rejection(400)));
    await real.getModels(true);
    expect(onConsole().some((l) => l.includes('Deployment fetch error - Status: 400'))).toBe(true);
    expect(await shippedText()).not.toContain(BODY);
    expect(shipped.some((e) => e.message === 'Deployment fetch error - Status: 400')).toBe(true);
  });

  it('Bedrock stream parser: the raw data of a failed event is on the console, not in the shipped entry', async () => {
    const parser: any = new BedrockStreamParser('anthropic.claude-test', '/invoke-with-response-stream');
    parser.res = { writableEnded: false, write: jest.fn(), end: jest.fn(), setHeader: jest.fn() };
    jest.spyOn(parser, 'transformBedrockEvent').mockImplementation(() => { throw new Error('transform failed'); });
    parser.handleData(JSON.stringify({ somethingElse: BODY }));
    expect(onConsole().some((l) => l.includes('Error handling data: Error: transform failed'))).toBe(true);
    expect(await shippedText()).not.toContain(BODY);
    expect(shipped.some((e) => e.message === 'Error handling data: Error: transform failed')).toBe(true);
  });
});
