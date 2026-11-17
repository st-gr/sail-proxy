/**
 * A streamed SAP orchestration request in a raw capture session keeps its streaming stages
 * (02_streaming_request_payload, 03_sap_response_streaming) with DEBUG and file logging off. With file
 * payload logging on (PAYLOAD_LOGGING_ENABLED or platform.logging.payload_logging_enabled) they go to the
 * payload files without DEBUG. A request outside every session, with both off, does no stage work at all.
 *
 * @see ../src/services/sapAIService.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
  createSafePreview: () => '',
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => ({}),
    getDeploymentId: async () => 'd-orchestration',
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
    getAccessToken: async () => 'tok',
    getTimeout: () => 1000,
  },
}));
jest.mock('../src/sap/sapTarget', () => ({
  ...jest.requireActual<any>('../src/sap/sapTarget'),
  currentSapTarget: () => ({ resourceGroup: 'rg-test' }),
}));
const frames = (): Readable => Readable.from([
  Buffer.from('data: {"final_result":{"choices":[{"delta":{"content":"Hello Jane"}}]}}\n\n'),
  Buffer.from('data: [DONE]\n\n'),
]);
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: async () => ({ status: 200, headers: {}, data: frames() }), isCancel: () => false },
}));

import { openSealed } from '@libs/trace-seal';
import { streamChatCompletion } from '../src/services/sapAIService';
import * as payloadLogger from '../src/utils/payloadLogger';
import { openCollector, closeCollector, clearRawCaptureState, RawTraceMessage } from '../src/services/rawCapture';
import securityEventEmitter from '../src/services/securityEventEmitter';

const LIMITS = { stageMaxBytes: 262144, maxStages: 40, requestMaxBytes: 2097152 };
let xadd: jest.Mock<(...args: string[]) => Promise<string>>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['METADATA_ENCRYPTION_KEY', 'PAYLOAD_LOGGING_ENABLED', 'DEBUG']) saved[k] = process.env[k];
  process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PAYLOAD_LOGGING_ENABLED = 'false';
  process.env.DEBUG = 'false';
  xadd = jest.fn(async (..._args: string[]) => '1-0');
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd });
  clearRawCaptureState();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  securityEventEmitter.setValkeyClient(undefined);
  clearRawCaptureState();
});

const payload = (): any => ({ config: { stream: { enabled: true }, modules: { prompt_templating: { model: { name: 'gpt-4o' } } } } });

function stagesOf(): { name: string; content: any }[] {
  const message: RawTraceMessage = JSON.parse(xadd.mock.calls[0][6]);
  const opened = openSealed(message.sealedStages, process.env);
  if (!opened.ok) throw new Error(opened.reason);
  return JSON.parse(opened.text).map((s: any) => ({ name: s.name, content: JSON.parse(s.content) }));
}

describe('a streamed SAP request in a raw capture session, DEBUG and file logging off', () => {
  it('records the streaming request and the assembled streamed answer (request id on the client request)', async () => {
    openCollector('gateway-s1', 's-1', 'cred-jane', LIMITS);
    await streamChatCompletion(payload(), () => {}, undefined, { debugRequestId: 'gateway-s1' } as any);
    closeCollector('gateway-s1', { statusCode: 200, complete: true });
    const stages = stagesOf();
    expect(stages.map((s) => s.name)).toEqual(['02_streaming_request_payload', '03_sap_response_streaming']);
    expect(stages[1].content.payload.fullText).toBe('Hello Jane');
  });

  it('records them under the request id the payload carries when there is no client request (Anthropic path)', async () => {
    openCollector('gateway-s2', 's-1', 'cred-jane', LIMITS);
    await streamChatCompletion({ ...payload(), debugRequestId: 'gateway-s2' }, () => {});
    closeCollector('gateway-s2', { statusCode: 200, complete: true });
    expect(stagesOf().map((s) => s.name)).toEqual(['02_streaming_request_payload', '03_sap_response_streaming']);
  });
});

describe('a streamed SAP request outside every session, DEBUG off', () => {
  it('saves no streaming stage at all', async () => {
    const save = jest.spyOn(payloadLogger, 'savePayload');
    await streamChatCompletion(payload(), () => {}, undefined, { debugRequestId: 'gateway-s3' } as any);
    expect(save.mock.calls.map((c) => c[1])).not.toContain('02_streaming_request_payload');
    expect(save.mock.calls.map((c) => c[1])).not.toContain('03_sap_response_streaming');
    expect(xadd).not.toHaveBeenCalled();
  });
});

describe('a streamed SAP request with file payload logging on, DEBUG off', () => {
  const streamingStages = (save: jest.SpiedFunction<typeof payloadLogger.savePayload>) =>
    save.mock.calls.filter((c) => ['02_streaming_request_payload', '03_sap_response_streaming'].includes(c[1])).map((c) => [c[0], c[1]]);

  it('saves both streaming stages under the client request id', async () => {
    process.env.PAYLOAD_LOGGING_ENABLED = 'true';
    const save = jest.spyOn(payloadLogger, 'savePayload').mockImplementation(() => {});
    await streamChatCompletion(payload(), () => {}, undefined, { debugRequestId: 'gateway-f1' } as any);
    expect(streamingStages(save)).toEqual([
      ['gateway-f1', '02_streaming_request_payload'],
      ['gateway-f1', '03_sap_response_streaming'],
    ]);
    expect(save.mock.calls.find((c) => c[1] === '03_sap_response_streaming')![2].fullText).toBe('Hello Jane');
    save.mockRestore();
  });

  it('saves them under the request id the payload carries when there is no client request (Anthropic path)', async () => {
    process.env.PAYLOAD_LOGGING_ENABLED = 'true';
    const save = jest.spyOn(payloadLogger, 'savePayload').mockImplementation(() => {});
    await streamChatCompletion({ ...payload(), debugRequestId: 'gateway-f2' }, () => {});
    expect(streamingStages(save)).toEqual([
      ['gateway-f2', '02_streaming_request_payload'],
      ['gateway-f2', '03_sap_response_streaming'],
    ]);
    save.mockRestore();
  });
});
