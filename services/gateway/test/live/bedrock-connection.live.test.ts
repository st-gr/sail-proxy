/**
 * Live proof of the `bedrock` connection adapter against AWS Bedrock (B2b). Opt-in and never in CI:
 *
 *   CONNECTIONS_LIVE=1 pnpm exec cross-env NODE_ENV=test jest --config jest.config.json test/live/bedrock-connection.live.test.ts
 *
 * Reads AWS_REGION, BEDROCK_MODEL_ID and the credentials (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY with an
 * optional AWS_SESSION_TOKEN, and/or AWS_BEARER_TOKEN_BEDROCK) from AWS_CONNECTION_ENV_FILE (default
 * ~/Documents/repos/aws-connection.env). Each credential kind present is proven. Prints statuses, counts and
 * the error type only, never a credential or a response text. An account that is throttled answers 429
 * ThrottlingException on invoke; that counts as reached and signed, anything else (403 above all) fails.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { describe, it, expect } from '@jest/globals';

import { adapterFor } from '../../src/upstreams';
import type { Connection } from '../../src/connections/types';

const LIVE = process.env.CONNECTIONS_LIVE === '1';
const suite = LIVE ? describe : describe.skip;

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

const envFile = process.env.AWS_CONNECTION_ENV_FILE || path.join(os.homedir(), 'Documents/repos/aws-connection.env');
const env = LIVE ? readEnvFile(envFile) : {};
const REGION = env.AWS_REGION || 'us-east-1';
const MODEL = env.BEDROCK_MODEL_ID || '';

const kinds: Array<{ label: string; connection: Connection }> = [];
const base = { name: 'bd', providerType: 'bedrock' as const, isActive: true, models: [] };
if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
  kinds.push({
    label: env.AWS_SESSION_TOKEN ? 'access key + session token' : 'access key',
    connection: {
      ...base, id: 'live-bd-key',
      settings: { region: REGION, authMode: 'access-key', accessKeyId: env.AWS_ACCESS_KEY_ID },
      credentials: { secret: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
    } as Connection,
  });
}
if (env.AWS_BEARER_TOKEN_BEDROCK) {
  kinds.push({
    label: 'Bedrock API key',
    connection: {
      ...base, id: 'live-bd-bearer',
      settings: { region: REGION, authMode: 'bearer' },
      credentials: { secret: env.AWS_BEARER_TOKEN_BEDROCK },
    } as Connection,
  });
}

const errorType = (r: { headers: any; data: any }): string => {
  const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '');
  return String(r.headers?.['x-amzn-errortype'] || '') + ' ' + text;
};
const invoke = async (connection: Connection, stream: boolean) => {
  const body = { messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 16, ...(stream ? { stream: true } : {}) };
  const r = await adapterFor(connection)!.buildRequest('messages', body, MODEL, {});
  return axios.post(r.url, r.body, {
    headers: r.headers, timeout: 60000, validateStatus: () => true,
    responseType: stream ? 'arraybuffer' : 'json',
  });
};
const asText = (data: any): string => (Buffer.isBuffer(data) ? data.toString('latin1') : typeof data === 'string' ? data : JSON.stringify(data ?? ''));

suite('bedrock connection, live', () => {
  it('has a region, a model id and a credential', () => {
    expect(MODEL.length).toBeGreaterThan(5);
    expect(kinds.length).toBeGreaterThan(0);
    console.log(`credential kinds: ${kinds.map((k) => k.label).join(', ')}`);
  });

  for (const { label, connection } of kinds) {
    describe(label, () => {
      it('testConnection is ok', async () => {
        expect(await adapterFor(connection)!.testConnection()).toEqual({ ok: true });
      });

      it('listModels contains the model id', async () => {
        const models = await adapterFor(connection)!.listModels();
        console.log(`listModels: ${models.length} ids`);
        expect(models).toContain(MODEL);
      });

      it('a plain invoke answers 200, or 429 ThrottlingException', async () => {
        const r = await invoke(connection, false);
        const throttled = r.status === 429 && /ThrottlingException/.test(errorType(r));
        console.log(`invoke: ${r.status}${r.status === 200 ? ` input=${r.data?.usage?.input_tokens} output=${r.data?.usage?.output_tokens}` : throttled ? ' ThrottlingException' : ''}`);
        expect(r.status === 200 || throttled).toBe(true);
        if (r.status === 200) expect(r.data.usage.input_tokens).toBeGreaterThan(0);
      });

      it('a streamed invoke answers 200 in an event stream, or 429 ThrottlingException', async () => {
        const r = await invoke(connection, true);
        const text = asText(r.data);
        const throttled = r.status === 429 && /ThrottlingException/.test(String(r.headers?.['x-amzn-errortype'] || '') + ' ' + text);
        console.log(`invoke stream: ${r.status}${r.status === 200 ? ` bytes=${Buffer.byteLength(text, 'latin1')}` : throttled ? ' ThrottlingException' : ''}`);
        expect(r.status === 200 || throttled).toBe(true);
        if (r.status === 200) expect(String(r.headers['content-type'])).toContain('eventstream');
      });
    });
  }
});
