/**
 * The page image for the vision model (fileSearch/extractors/pageImage.ts): pdftoppm's grey PGM
 * parsed, resized to the long-side bound with sharp, and encoded as a grey PNG data URL. Real sharp,
 * synthetic PGMs; no external tool.
 */
import sharp from 'sharp';
import { pageImageDataUrl, parsePgm } from '../../src/fileSearch/extractors/pageImage';

function pgm(width: number, height: number, header?: string): Buffer {
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) % 256;
  return Buffer.concat([Buffer.from(header ?? `P5\n${width} ${height}\n255\n`, 'latin1'), pixels]);
}

describe('parsePgm', () => {
  it('reads pdftoppm-style headers, comments included', () => {
    expect(parsePgm(pgm(3, 2))).toMatchObject({ width: 3, height: 2 });
    const commented = parsePgm(pgm(4, 1, 'P5\n# made by a test\n4 1\n255\n'));
    expect(commented).toMatchObject({ width: 4, height: 1 });
    expect([...commented.pixels]).toEqual([0, 7, 14, 21]);
  });

  it('refuses other formats, bad sizes, 16-bit and truncated pixel data', () => {
    expect(() => parsePgm(Buffer.from('\x89PNG\r\n'))).toThrow(/binary PGM/);
    expect(() => parsePgm(Buffer.from('P6\n1 1\n255\n\x00\x00\x00', 'latin1'))).toThrow(/binary PGM/);
    expect(() => parsePgm(Buffer.from('P5\n0 1\n255\n', 'latin1'))).toThrow(/invalid size/);
    expect(() => parsePgm(Buffer.from('P5\n1 1\n65535\n\x00\x00', 'latin1'))).toThrow(/8-bit/);
    expect(() => parsePgm(Buffer.from('P5\n10 10\n255\n\x00', 'latin1'))).toThrow(/truncated/);
    expect(() => parsePgm(Buffer.from('P5\n10', 'latin1'))).toThrow(/incomplete/);
  });
});

describe('pageImageDataUrl', () => {
  it('shrinks a large page to the long-side bound, keeping the aspect ratio, as a grey PNG', async () => {
    const image = await pageImageDataUrl(pgm(2480, 3508), 1568); // A4 at 300 dpi
    expect(image.height).toBe(1568);
    expect(image.width).toBe(Math.round((2480 * 1568) / 3508));
    expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64');
    expect(png.length).toBe(image.bytes);
    const meta = await sharp(png).metadata();
    expect(meta).toMatchObject({ format: 'png', width: image.width, height: 1568, channels: 1 });
  });

  it('a landscape page is bounded by its width; a small page is never enlarged', async () => {
    const wide = await pageImageDataUrl(pgm(3000, 1000), 1568);
    expect([wide.width, wide.height]).toEqual([1568, 523]);
    const small = await pageImageDataUrl(pgm(800, 600), 1568);
    expect([small.width, small.height]).toEqual([800, 600]);
  });

  it('a corrupt image throws', async () => {
    await expect(pageImageDataUrl(Buffer.from('not an image'), 1568)).rejects.toThrow(/binary PGM/);
  });
});
