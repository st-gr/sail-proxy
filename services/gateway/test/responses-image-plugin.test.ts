import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockDownload = jest.fn<(url: string) => Promise<string>>();
jest.mock('../src/utils/imageUtils', () => ({
  __esModule: true,
  remoteUrlToDataUrl: (url: string) => mockDownload(url),
}));

import pluginRules = require('../src/plugins/responsesImagePlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

function mockRes() {
  const r: any = { statusCode: undefined, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

const orchestrationReq = (body: any) => ({ body, __responsesRoute: 'orchestration' } as any);

beforeEach(() => {
  mockDownload.mockReset();
  logger.error.mockClear();
  logger.info.mockClear();
});

describe('responsesImagePlugin — before', () => {
  it('inlines a remote input_image (string url form) as a data: URL', async () => {
    mockDownload.mockResolvedValue('data:image/png;base64,AAA');
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'http://example.com/cat.png' },
      ] }],
    });

    const r = await before({ req, res: mockRes(), utils: { logger } });

    expect(r).toEqual({ stop: false });
    expect(req.body.input[0].content[0].image_url).toBe('data:image/png;base64,AAA');
    expect(mockDownload).toHaveBeenCalledWith('http://example.com/cat.png');
  });

  it('inlines a remote input_image ({url} object form), preserving the object shape', async () => {
    mockDownload.mockResolvedValue('data:image/png;base64,BBB');
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: { url: 'https://example.com/cat.png', detail: 'high' } },
      ] }],
    });

    await before({ req, res: mockRes(), utils: { logger } });

    expect(req.body.input[0].content[0].image_url).toEqual({
      url: 'data:image/png;base64,BBB', detail: 'high',
    });
  });

  it('leaves an already-inlined data: URL untouched and never downloads', async () => {
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      ] }],
    });
    const snapshot = JSON.parse(JSON.stringify(req.body));

    await before({ req, res: mockRes(), utils: { logger } });

    expect(req.body).toEqual(snapshot);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('keeps a mixed text+image message intact, rewriting only the image part', async () => {
    mockDownload.mockResolvedValue('data:image/png;base64,CCC');
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: 'http://example.com/cat.png' },
      ] }],
    });

    await before({ req, res: mockRes(), utils: { logger } });

    expect(req.body.input[0].content[0]).toEqual({ type: 'input_text', text: 'what is this?' });
    expect(req.body.input[0].content[1].image_url).toBe('data:image/png;base64,CCC');
  });

  it('does nothing when the request will not take the orchestration route', async () => {
    const req = { body: {
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'http://example.com/cat.png' },
      ] }],
    }, __responsesRoute: 'native' } as any;
    const snapshot = JSON.parse(JSON.stringify(req.body));

    const r = await before({ req, res: mockRes(), utils: { logger } });

    expect(r).toEqual({ stop: false });
    expect(req.body).toEqual(snapshot);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('ignores non-input_image parts and non-message items', async () => {
    const req = orchestrationReq({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(req.body));

    await before({ req, res: mockRes(), utils: { logger } });

    expect(req.body).toEqual(snapshot);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('on a download failure, sends a 400 naming the real cause and stops the request', async () => {
    mockDownload.mockRejectedValue(new Error('Failed to process image from URL: getaddrinfo ENOTFOUND'));
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'http://bad.example.com/cat.png' },
      ] }],
    });
    const res = mockRes();

    const r = await before({ req, res, utils: { logger } });

    expect(r).toEqual({ stop: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('image_download_failed');
    expect(res.body.error.message).toContain('http://bad.example.com/cat.png');
    expect(res.body.error.message).toContain('ENOTFOUND');
    // Not silently dropped: the part is left as the plugin found it, not stripped from
    // content, and the request never reaches the bridge to be forwarded either.
    expect(req.body.input[0].content[0].image_url).toBe('http://bad.example.com/cat.png');
  });

  it('does not attempt a second download after the first failure in the same request', async () => {
    mockDownload.mockRejectedValue(new Error('boom'));
    const req = orchestrationReq({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'http://example.com/a.png' },
        { type: 'input_image', image_url: 'http://example.com/b.png' },
      ] }],
    });

    await before({ req, res: mockRes(), utils: { logger } });

    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('never throws on a malformed body', async () => {
    for (const body of [undefined, null, {}, { input: 'nope' }, { input: [null, 42, { type: 'message' }] }] as any[]) {
      const req = { body, __responsesRoute: 'orchestration' } as any;
      await expect(before({ req, res: mockRes(), utils: { logger } })).resolves.toEqual({ stop: false });
    }
  });
});
