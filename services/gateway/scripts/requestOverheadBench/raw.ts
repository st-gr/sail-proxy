import * as crypto from 'crypto';
import express from 'express';
import { AddressInfo } from 'net';
import { measure, UPSTREAM_DELAY_MS } from './load';

const STAGES_PER_REQUEST = 6; // savePayload calls of a non-streamed chat completion through the gateway
const BENCH_CREDENTIAL = 'bench-credential';

// The raw capture path alone: the real tap and payload logger in an in-process app, with a Valkey
// stand-in whose XADD resolves at once. A standalone gateway never holds sessions, so the session
// variants cannot run through the e2e mode.
export async function runRawMode(): Promise<void> {
  process.env.DISABLE_FILE_LOGGING = 'true';
  process.env.LOG_LEVEL = 'INFO';
  process.env.PAYLOAD_LOGGING_ENABLED = 'false';
  process.env.METADATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  // Loaded only now, so the variables above reach the logger when it is created.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { logger } = require('@libs/logger');
  const { rawCaptureTap } = require('../../src/middlewares/rawCaptureTap');
  const { applySessions, clearRawCaptureState } = require('../../src/services/rawCapture');
  const { savePayload } = require('../../src/utils/payloadLogger');
  const securityEventEmitter = require('../../src/services/securityEventEmitter').default;
  /* eslint-enable @typescript-eslint/no-var-requires */

  // BENCH_RAW: off (default, no session), other (a session for another credential), own (a session
  // for the bench's credential: every request is captured, sealed and handed to the stand-in).
  const rawMode = process.env.BENCH_RAW ?? 'off';
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd: () => Promise.resolve('1-0') });
  if (rawMode !== 'off') {
    const credentialIds = [rawMode === 'own' ? BENCH_CREDENTIAL : 'another-credential'];
    applySessions(JSON.stringify({ sessions: [{ id: 'bench-session', credentialIds, endsAt: Date.now() + 3_600_000 }] }), new Date());
  }

  const saved = { info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const noop = (): void => undefined;
  console.info = console.debug = console.warn = console.error = noop;

  const answer = { id: 'chatcmpl-bench', object: 'chat.completion', model: 'gpt-bench', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  const app = express();
  app.use(express.json());
  let counter = 0;
  app.post('/openai/v1/chat/completions', (req: any, _res, next) => {
    req.debugRequestId = `gateway-bench-${++counter}`;
    req.unifiedAuth = { valid: true, authType: 'api_key', data: { id: BENCH_CREDENTIAL } };
    next();
  }, rawCaptureTap, async (req: any, res) => {
    for (let i = 0; i < STAGES_PER_REQUEST; i++) savePayload(req.debugRequestId, `0${i}_bench_stage`, i % 2 ? answer : req.body, i === 0 ? req : undefined);
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_DELAY_MS));
    res.json(answer);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1/chat/completions`;
  const body = JSON.stringify({ model: 'gpt-bench', messages: [{ role: 'user', content: 'hi' }] });
  try {
    await measure('raw', async () => { await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).text(); });
  } finally {
    Object.assign(console, saved);
    clearRawCaptureState();
    await new Promise((resolve) => server.close(resolve));
    logger.close();
  }
}
