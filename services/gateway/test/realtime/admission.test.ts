import { describe, it, expect, jest } from '@jest/globals';
import { createRecordingResponse, prepareUpgradeRequest, refusal, runMiddleware, writeRefusal } from '../../src/realtime/admission';

function fakeIncoming(url: string, headers: Record<string, string> = {}): any {
  return { url, method: 'GET', headers: { 'user-agent': 'jest', ...headers }, socket: { remoteAddress: '::ffff:203.0.113.7' } };
}

describe('prepareUpgradeRequest', () => {
  it('adds what the Express middlewares read: originalUrl, path, query, get(), ip, body, params, debugRequestId', () => {
    const r = prepareUpgradeRequest(fakeIncoming('/openai/v1/realtime?model=gpt-realtime&x[a]=1', { authorization: 'Bearer test-key' }));
    expect(r.originalUrl).toBe('/openai/v1/realtime?model=gpt-realtime&x[a]=1');
    expect(r.path).toBe('/openai/v1/realtime');
    expect(r.query).toEqual({ model: 'gpt-realtime', 'x[a]': '1' });
    expect(r.get('User-Agent')).toBe('jest');
    expect(r.header('authorization')).toBe('Bearer test-key');
    expect(r.get('missing')).toBeUndefined();
    expect(r.ip).toBe('::ffff:203.0.113.7');
    expect(r.body).toEqual({});
    expect(r.params).toEqual({});
    expect(r.protocol).toBe('http');
    expect(r.debugRequestId).toMatch(/^gateway-\d+-[a-z0-9]+$/);
  });
  it('keeps the first value of a repeated query parameter and copes with a missing url', () => {
    expect(prepareUpgradeRequest(fakeIncoming('/v1/realtime?model=a&model=b')).query.model).toBe('a');
    const r = prepareUpgradeRequest({ headers: {}, socket: {} } as any);
    expect(r.path).toBe('/');
    expect(r.originalUrl).toBe('/');
    expect(r.ip).toBe('');
  });
});

describe('createRecordingResponse', () => {
  it('records status, headers (case-insensitively) and a JSON body, and reports finish once', () => {
    const onFinish = jest.fn();
    const res = createRecordingResponse(onFinish);
    res.set({ 'X-RateLimit-Limit': '5', 'Retry-After': 7 });
    res.setHeader('X-Custom', ['a', 'b']);
    res.status(429).json({ error: { type: 'rate_limit_exceeded' } });
    expect(res.recorded).toEqual({
      statusCode: 429, finished: true,
      headers: { 'x-ratelimit-limit': '5', 'retry-after': '7', 'x-custom': 'a, b', 'content-type': 'application/json; charset=utf-8' },
      body: '{"error":{"type":"rate_limit_exceeded"}}',
    });
    expect(res.getHeader('retry-after')).toBe('7');
    expect(res.statusCode).toBe(429);
    expect(res.headersSent).toBe(false);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
  it('send() with an object behaves like json(); send() with a string and end() record the text', () => {
    const a = createRecordingResponse(); a.status(500).send({ error: 'x' });
    expect(a.recorded.body).toBe('{"error":"x"}');
    expect(a.recorded.headers['content-type']).toBe('application/json; charset=utf-8');
    const b = createRecordingResponse(); b.status(404).send('gone');
    expect(b.recorded).toMatchObject({ statusCode: 404, body: 'gone', finished: true });
    const c = createRecordingResponse(); c.end();
    expect(c.recorded).toMatchObject({ statusCode: 200, body: '', finished: true });
  });
});

describe('runMiddleware', () => {
  it("resolves 'next' when the middleware calls next()", async () => {
    const mw = jest.fn((req: any, _res: any, next: any) => { req.touched = true; next(); });
    const req: any = {};
    const { outcome } = await runMiddleware(mw, req);
    expect(outcome).toBe('next');
    expect(req.touched).toBe(true);
  });
  it("resolves 'refused' with the recorded response when the middleware writes one", async () => {
    const mw = async (_req: any, res: any) => { res.set({ 'Retry-After': '3' }); res.status(429).json({ error: { type: 'quota_exceeded' } }); };
    const { outcome, recorded } = await runMiddleware(mw, {});
    expect(outcome).toBe('refused');
    expect(recorded.statusCode).toBe(429);
    expect(recorded.headers['retry-after']).toBe('3');
    expect(JSON.parse(recorded.body).error.type).toBe('quota_exceeded');
  });
  it('turns next(err) and a rejected middleware into a recorded 500', async () => {
    const a = await runMiddleware((_r: any, _s: any, next: any) => next(new Error('boom')), {});
    expect(a).toMatchObject({ outcome: 'refused', recorded: { statusCode: 500 } });
    expect(JSON.parse(a.recorded.body).error.message).toBe('boom');
    const b = await runMiddleware(async () => { throw new Error('async boom'); }, {});
    expect(b.outcome).toBe('refused');
    expect(b.recorded.statusCode).toBe(500);
  });
  it('settles once even if the middleware both writes and calls next', async () => {
    const mw = (_r: any, res: any, next: any) => { res.status(401).json({ error: 'no' }); next(); };
    const { outcome, recorded } = await runMiddleware(mw, {});
    expect(outcome).toBe('refused');
    expect(recorded.statusCode).toBe(401);
  });
});

describe('writeRefusal', () => {
  function parse(buf: Buffer) {
    const text = buf.toString('utf8');
    const [head, body] = text.split('\r\n\r\n');
    const [statusLine, ...headerLines] = head.split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of headerLines) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
    return { statusLine, headers, body };
  }
  it('writes a complete HTTP/1.1 response with the recorded status, headers and JSON body, then ends the socket', () => {
    const socket = { writable: true, end: jest.fn(), destroy: jest.fn() };
    writeRefusal(socket, refusal(429, { error: { type: 'rate_limit_exceeded', limit: 5 } }, { 'Retry-After': '7', 'X-RateLimit-Limit': '5' }));
    expect(socket.end).toHaveBeenCalledTimes(1);
    const { statusLine, headers, body } = parse((socket.end as jest.Mock).mock.calls[0][0] as Buffer);
    expect(statusLine).toBe('HTTP/1.1 429 Too Many Requests');
    expect(headers['content-type']).toBe('application/json; charset=utf-8');
    expect(headers['retry-after']).toBe('7');
    expect(headers['x-ratelimit-limit']).toBe('5');
    expect(headers['connection']).toBe('close');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(JSON.parse(body)).toEqual({ error: { type: 'rate_limit_exceeded', limit: 5 } });
  });
  it('uses the recorded content-type when one was set and a generic reason phrase for unknown codes', () => {
    const socket = { writable: true, end: jest.fn(), destroy: jest.fn() };
    writeRefusal(socket, { statusCode: 599, headers: { 'content-type': 'text/plain' }, body: 'nope', finished: true });
    const { statusLine, headers, body } = parse((socket.end as jest.Mock).mock.calls[0][0] as Buffer);
    expect(statusLine).toBe('HTTP/1.1 599 Error');
    expect(headers['content-type']).toBe('text/plain');
    expect(body).toBe('nope');
  });
  it('destroys a socket that is no longer writable', () => {
    const socket = { writable: false, end: jest.fn(), destroy: jest.fn() };
    writeRefusal(socket, refusal(404, { error: { type: 'not_found' } }));
    expect(socket.end).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
