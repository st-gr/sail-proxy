/**
 * resizeOversizedImages plugin: multi-image requests get every image above the
 * model's dimension limit resized in place (aspect ratio kept, format kept);
 * single-image requests and images within the limit are left untouched.
 *
 * Images are synthesised with sharp itself, so the test exercises the real
 * decode → metadata → resize → encode chain the plugin runs in production — the
 * chain that a sharp/libvips upgrade can change.
 */
import { describe, it, expect } from '@jest/globals';
import sharp from 'sharp';
import pluginRules = require('../src/plugins/resizeOversizedImages');

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, trace: () => undefined } as any;
const handler = pluginRules[0].handler as (ctx: any) => Promise<{ stop: boolean }>;

async function pngBase64(width: number, height: number): Promise<string> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
  return buf.toString('base64');
}

function imageBlock(data: string, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

async function dims(data: string): Promise<{ width?: number; height?: number; format?: string }> {
  const m = await sharp(Buffer.from(data, 'base64')).metadata();
  return { width: m.width, height: m.height, format: m.format };
}

describe('resizeOversizedImages', () => {
  it('resizes only the oversized images of a multi-image request, keeping aspect ratio and format', async () => {
    const big = await pngBase64(2400, 1200);     // over the 1568 px default limit
    const small = await pngBase64(400, 300);
    const body: any = { model: 'some-model', messages: [{ role: 'user', content: [imageBlock(big), { type: 'text', text: 'and' }, imageBlock(small)] }] };

    const result = await handler({ req: { body }, res: {}, utils: { logger } });

    expect(result).toEqual({ stop: false });
    const resized = await dims(body.messages[0].content[0].source.data);
    expect(resized.format).toBe('png');
    expect(resized.width).toBe(1568);
    expect(resized.height).toBe(784);
    expect(body.messages[0].content[2].source.data).toBe(small);
  });

  it('honours a model-specific limit and keeps the media type for jpeg', async () => {
    const jpeg = (await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#888' } }).jpeg().toBuffer()).toString('base64');
    const other = await pngBase64(100, 100);
    const body: any = { model: 'unknown-model', messages: [{ role: 'user', content: [imageBlock(jpeg, 'image/jpeg'), imageBlock(other)] }] };

    await handler({ req: { body }, res: {}, utils: { logger } });

    const resized = await dims(body.messages[0].content[0].source.data);
    expect(resized.format).toBe('jpeg');
    expect(Math.max(resized.width!, resized.height!)).toBe(1568);
  });

  it('resizes images nested inside tool_result blocks', async () => {
    const big = await pngBase64(1600, 3200);
    const other = await pngBase64(50, 50);
    const body: any = { model: 'm', messages: [
      { role: 'user', content: [imageBlock(other)] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [imageBlock(big)] }] }
    ] };

    await handler({ req: { body }, res: {}, utils: { logger } });

    const resized = await dims(body.messages[1].content[0].content[0].source.data);
    expect(resized.height).toBe(1568);
    expect(resized.width).toBe(784);
  });

  it('leaves a single-image request alone even when it is oversized', async () => {
    const big = await pngBase64(4000, 100);
    const body: any = { model: 'm', messages: [{ role: 'user', content: [imageBlock(big)] }] };

    await handler({ req: { body }, res: {}, utils: { logger } });

    expect(body.messages[0].content[0].source.data).toBe(big);
  });

  it('ignores requests without a messages array', async () => {
    expect(await handler({ req: { body: { prompt: 'x' } }, res: {}, utils: { logger } })).toEqual({ stop: false });
    expect(await handler({ req: {}, res: {}, utils: { logger } })).toEqual({ stop: false });
  });
});
