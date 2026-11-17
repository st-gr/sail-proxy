/**
 * savePayload hands every stage to the raw capture before it looks at file logging: a request in a
 * raw session keeps its stages while file logging is off, and no file is written for them.
 *
 * @see ../src/utils/payloadLogger.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import * as fs from 'fs';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import { openSealed } from '@libs/trace-seal';
import { savePayload, getLogDir } from '../src/utils/payloadLogger';
import { openCollector, closeCollector, clearRawCaptureState, RawTraceMessage } from '../src/services/rawCapture';
import securityEventEmitter from '../src/services/securityEventEmitter';

const LIMITS = { stageMaxBytes: 262144, maxStages: 40, requestMaxBytes: 2097152 };
let xadd: jest.Mock<(...args: string[]) => Promise<string>>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['METADATA_ENCRYPTION_KEY', 'PAYLOAD_LOGGING_ENABLED']) saved[k] = process.env[k];
  process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PAYLOAD_LOGGING_ENABLED = 'false';
  xadd = jest.fn(async (..._args: string[]) => '1-0');
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd });
  clearRawCaptureState();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  securityEventEmitter.setValkeyClient(undefined);
  clearRawCaptureState();
});

describe('savePayload with file logging off', () => {
  it('still records the stages of a selected request and writes no file', () => {
    const id = `gateway-rawstage${randomBytes(4).toString('hex')}`;
    const req: any = { method: 'POST', originalUrl: '/openai/v1/chat/completions?key=abc', url: '/', query: { key: 'abc' }, headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } };
    openCollector(id, 's-1', 'cred-jane', LIMITS);
    savePayload(id, '02_sap_request_payload', { prompt: 'Hello Jane' });
    savePayload(id, '03_sap_response_raw', { answer: 'Hi' }, req);
    closeCollector(id, { statusCode: 200, complete: true });

    const dir = getLogDir();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes(id)) : []).toEqual([]);
    const message: RawTraceMessage = JSON.parse(xadd.mock.calls[0][6]);
    expect(message.stageIndex.map((s) => s.name)).toEqual(['02_sap_request_payload', '03_sap_response_raw']);
    const opened = openSealed(message.sealedStages, process.env);
    if (!opened.ok) throw new Error(opened.reason);
    const [first, second] = JSON.parse(opened.text).map((s: any) => JSON.parse(s.content));
    expect(first.payload).toEqual({ prompt: 'Hello Jane' });
    expect(second).toMatchObject({ httpMethod: 'POST', url: '/openai/v1/chat/completions?key=***', queryParams: { key: '***' }, requestHeaders: { authorization: '[REDACTED]' } });
  });

  it('records nothing for a request outside every session', () => {
    savePayload('gateway-2', '02_sap_request_payload', { prompt: 'Hello Jane' });
    closeCollector('gateway-2', { statusCode: 200, complete: true });
    expect(xadd).not.toHaveBeenCalled();
  });
});
