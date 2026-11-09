/**
 * On Kyma the admin often boots before the gateway is ready. Its self-heal model-data fetch then
 * met a refused connection and logged two ERRORs with stack traces, gave up, and relied on the
 * gateway's model-list event alone. A gateway that is not up yet is expected at boot: the admin
 * now says so at WARN and tries again, and keeps ERROR for a gateway that answers with a failure.
 */
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockCdsRun = jest.fn();

jest.mock('@sap/cds', () => {
  const updateChain: any = {};
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = jest.fn(() => updateChain);
  const chain = () => ({ from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), into: jest.fn().mockReturnThis(), entries: jest.fn().mockReturnThis() });
  return {
    connect: { to: jest.fn(() => ({ run: mockCdsRun })) },
    tx: (fn: any) => fn({ run: mockCdsRun }),
    ql: { SELECT: chain(), INSERT: chain(), UPSERT: chain(), UPDATE: jest.fn(() => updateChain) },
  };
});

jest.mock('../../../../../libs/logger', () => {
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => log, mockLog: log };
});
const { mockLog } = require('../../../../../libs/logger');

import { modelCostService } from '../../../src/services/modelCostService';

const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' });
const modelList = { data: { data: [{ id: 'gpt-4.1-nano', owned_by: 'openai', provider: 'openai', versions: [{ name: 'v1', isLatest: true, cost: [{ inputCost: '0.0001', outputCost: '0.0004' }] }] }] } };
const svc = modelCostService as any;

describe('model-data self-heal while the gateway is not up yet', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    svc.useValkeyEvents = true;
    svc.hasModelData = false;
    svc.serviceApiKey = 'test-service-key';
    svc.lastFetch = 0;
    svc.fallbackFetchDelay = 1000;
    mockCdsRun.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    svc.useValkeyEvents = false;
    svc.hasModelData = false;
    svc.serviceApiKey = null;
  });

  it('logs no error and fetches again once the gateway answers', async () => {
    mockedAxios.get.mockRejectedValueOnce(refused()).mockResolvedValueOnce(modelList);
    svc.scheduleModelDataFallback();
    for (let i = 0; i < 10 && !svc.hasModelData; i++) await jest.advanceTimersByTimeAsync(60_000);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(svc.hasModelData).toBe(true);
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockLog.warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toMatch(/not reachable yet/);
  });

  it('stops trying once a model-list event delivered the data', async () => {
    mockedAxios.get.mockRejectedValue(refused());
    svc.scheduleModelDataFallback();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    svc.hasModelData = true;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts, with one error', async () => {
    mockedAxios.get.mockRejectedValue(refused());
    svc.scheduleModelDataFallback();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    const attempts = mockedAxios.get.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(6);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });

  it('still logs an error when the gateway answers with a failure', async () => {
    mockedAxios.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }));
    svc.scheduleModelDataFallback();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockLog.error).toHaveBeenCalled();
  });
});
