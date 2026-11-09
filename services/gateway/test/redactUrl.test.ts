/**
 * An API key passed in the URL (`?key=`, `?api_key=`) never reaches the access log, the auth
 * middlewares' log lines or a security event in clear text.
 *
 * @see ../src/utils/redactUrl.ts
 */
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { redactUrl } from '../src/utils/redactUrl';
import { filterSensitiveHeaders } from '../src/utils/payloadLogger';
import { API_KEY_HEADERS } from '../src/utils/extractApiKey';
import { accessLogMiddleware } from '../src/utils/accessLog';

const KEY = 'sk-test-FAKE-INVALID-KEY-1234567890';

/** True when any 8-character window of the key appears in the text. */
function leaksKey(text: string): boolean {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
}

describe('redactUrl', () => {
  it('masks key and api_key, keeping path, name and other parameters', () => {
    expect(redactUrl(`/v1/models?key=${KEY}&x=1`)).toBe('/v1/models?key=***&x=1');
    expect(redactUrl(`/v1/models?x=1&api_key=${KEY}`)).toBe('/v1/models?x=1&api_key=***');
  });

  it('masks repeated, differently cased, encoded and bracketed forms', () => {
    const out = redactUrl(`/p?KEY=${KEY}&Api_Key=${KEY}&%6Bey=${KEY}&api%5Fkey=${KEY}&key[a]=${KEY}&k=2#f`);
    expect(out).toBe('/p?KEY=***&Api_Key=***&%6Bey=***&api%5Fkey=***&key[a]=***&k=2#f');
    expect(leaksKey(out)).toBe(false);
  });

  it('leaves other URLs unchanged', () => {
    for (const u of ['/v1/models', '/v1/models?x=1&keyword=abc&monkey=1', '/p?key', '/p?', '']) {
      expect(redactUrl(u)).toBe(u);
    }
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('access log', () => {
  it.each(['key', 'api_key'])('does not write the ?%s= value', async (param) => {
    const lines: string[] = [];
    const app = express();
    app.use(accessLogMiddleware((m) => lines.push(m)));
    app.get('/v1/models', (req, res) => res.json({ seen: req.query[param] }));

    const res = await request(app).get(`/v1/models?${param}=${KEY}&x=1`).set('Referer', `http://h/p?${param}=${KEY}`);
    expect(res.body.seen).toBe(KEY); // handlers still see the real value
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`/v1/models?${param}=***&x=1`);
    expect(leaksKey(lines[0])).toBe(false);
  });
});

describe('security events', () => {
  it('securityEventEmitter masks the endpoint of every event', async () => {
    const { default: emitter } = await import('../src/services/securityEventEmitter');
    const sent: any[] = [];
    jest.spyOn(emitter as any, 'emit').mockImplementation(async (e: any) => { sent.push(e); });
    await emitter.emitFailedAuth({
      credentialId: 'c', authType: 'api_key', reason: 'r', endpoint: `/v1/models?api_key=${KEY}&x=1`, method: 'GET',
    } as any);
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('/v1/models?api_key=***&x=1');
  });
});

describe('payload log headers', () => {
  it('redacts every header extractApiKey reads a key from, and masks a key in the referer', () => {
    const headers: Record<string, string> = { referer: `http://h/p?key=${KEY}&x=1`, accept: 'a' };
    for (const h of API_KEY_HEADERS) headers[h] = KEY;
    const out = filterSensitiveHeaders(headers);
    for (const h of API_KEY_HEADERS) expect(out[h]).toBe('[REDACTED]');
    expect(out.referer).toBe('http://h/p?key=***&x=1');
    expect(out.accept).toBe('a');
    expect(leaksKey(JSON.stringify(out))).toBe(false);
  });
});
