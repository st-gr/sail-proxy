import { sniffImageDimensions, imageTokensFromDimensions } from '../../src/utils/imageDimensions';

// --- PNG: signature + IHDR chunk, width/height BE at offsets 16/20 ---
// 89504e470d0a1a0a = PNG signature (8 bytes)
// 0000000d = IHDR chunk length (13)
// 49484452 = "IHDR"
// 00000002 = width (2)
// 00000003 = height (3)
// 08 = bit depth (rest of IHDR/CRC omitted; not needed to read width/height)
const PNG_2x3 = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308', 'hex');

// --- GIF: "GIF89a" + logical screen descriptor, width/height LE at offsets 6/8 ---
// 47494638 3961 = "GIF89a"
// 0400 = width (4, LE)
// 0500 = height (5, LE)
// 80 = packed byte (rest of descriptor omitted)
const GIF_4x5 = Buffer.from('4749463839610400050080', 'hex');

// --- JPEG: SOI, an APP0/JFIF segment (to exercise segment-walking), then SOF0 ---
// SOF0 payload: precision(1) height(2 BE) width(2 BE) numComponents(1) + 3 bytes/component
function buildJpegSOF0(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, // APP0 marker
    0x00, 0x10, // length = 16 (includes itself)
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // units
    0x00, 0x01, // x density
    0x00, 0x01, // y density
    0x00, 0x00 // thumbnail w/h
  ]);
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xff;
  sof0[1] = 0xc0; // SOF0
  sof0.writeUInt16BE(0x000b, 2); // length = 11 (includes itself)
  sof0[4] = 0x08; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 0x01; // 1 component
  sof0[10] = 0x01; // component id
  sof0[11] = 0x11; // sampling factors
  sof0[12] = 0x00; // quant table id
  return Buffer.concat([soi, app0, sof0]);
}
const JPEG_9x6 = buildJpegSOF0(9, 6);

// --- WebP VP8X (extended): 24-bit width-1/height-1 LE, at chunk-data offset 4/7 ---
function buildWebpVP8X(width: number, height: number): Buffer {
  const chunkData = Buffer.alloc(10);
  chunkData[0] = 0x00; // flags
  chunkData.writeUIntLE(width - 1, 4, 3);
  chunkData.writeUIntLE(height - 1, 7, 3);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(chunkData.length, 0);
  const body = Buffer.concat([Buffer.from('VP8X', 'ascii'), chunkSize, chunkData]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0); // "WEBP" + body
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body]);
}
const WEBP_VP8X_5x3 = buildWebpVP8X(5, 3);

// --- WebP VP8L (lossless): sig byte 0x2f then 14-bit width-1/height-1 packed LE ---
function buildWebpVP8L(width: number, height: number): Buffer {
  const value = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const chunkData = Buffer.alloc(5);
  chunkData[0] = 0x2f;
  chunkData.writeUInt32LE(value >>> 0, 1);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(chunkData.length, 0);
  const body = Buffer.concat([Buffer.from('VP8L', 'ascii'), chunkSize, chunkData]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body]);
}
const WEBP_VP8L_3x2 = buildWebpVP8L(3, 2);

// --- WebP VP8 (lossy): frame tag(3) + start code 9D012A + width/height 14-bit LE ---
function buildWebpVP8(width: number, height: number): Buffer {
  const chunkData = Buffer.alloc(10);
  chunkData[0] = 0x00;
  chunkData[1] = 0x00;
  chunkData[2] = 0x00; // frame tag (unused by the sniffer)
  chunkData[3] = 0x9d;
  chunkData[4] = 0x01;
  chunkData[5] = 0x2a; // start code
  chunkData.writeUInt16LE(width, 6);
  chunkData.writeUInt16LE(height, 8);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(chunkData.length, 0);
  const body = Buffer.concat([Buffer.from('VP8 ', 'ascii'), chunkSize, chunkData]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body]);
}
const WEBP_VP8_6x4 = buildWebpVP8(6, 4);

describe('sniffImageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(sniffImageDimensions(PNG_2x3)).toEqual({ width: 2, height: 3 });
  });

  it('reads GIF dimensions (little-endian)', () => {
    expect(sniffImageDimensions(GIF_4x5)).toEqual({ width: 4, height: 5 });
  });

  it('reads JPEG dimensions by walking to the SOF0 marker', () => {
    expect(sniffImageDimensions(JPEG_9x6)).toEqual({ width: 9, height: 6 });
  });

  it('reads WebP VP8X (extended) dimensions', () => {
    expect(sniffImageDimensions(WEBP_VP8X_5x3)).toEqual({ width: 5, height: 3 });
  });

  it('reads WebP VP8L (lossless) dimensions', () => {
    expect(sniffImageDimensions(WEBP_VP8L_3x2)).toEqual({ width: 3, height: 2 });
  });

  it('reads WebP VP8 (lossy) dimensions', () => {
    expect(sniffImageDimensions(WEBP_VP8_6x4)).toEqual({ width: 6, height: 4 });
  });

  it('returns null for unknown/short buffers', () => {
    expect(sniffImageDimensions(Buffer.from([0, 1, 2]))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(sniffImageDimensions(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for garbage that resembles no known signature', () => {
    expect(sniffImageDimensions(Buffer.from('not an image at all, just text bytes'))).toBeNull();
  });

  it('returns null for a WebP RIFF/WEBP container with an unrecognized chunk type', () => {
    const body = Buffer.concat([Buffer.from('ANIM', 'ascii'), Buffer.alloc(8)]);
    const riffSize = Buffer.alloc(4);
    riffSize.writeUInt32LE(4 + body.length, 0);
    const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body]);
    expect(sniffImageDimensions(buf)).toBeNull();
  });
});

describe('imageTokensFromDimensions (SAP formula)', () => {
  it('ceil(min(W,1540)/14)*ceil(min(H,1540)/14)+overhead', () => {
    // ceil(28/14)=2, ceil(14/14)=1 -> 2*1+8 = 10
    expect(imageTokensFromDimensions(28, 14, 8)).toBe(10);
    // width downscaled from 3080 to 1540 -> ceil(1540/14)=110; ceil(14/14)=1 -> 110*1+0 = 110
    expect(imageTokensFromDimensions(3080, 14, 0)).toBe(110);
  });

  it('treats a missing/zero overhead as 0', () => {
    expect(imageTokensFromDimensions(14, 14, 0)).toBe(1);
  });
});
