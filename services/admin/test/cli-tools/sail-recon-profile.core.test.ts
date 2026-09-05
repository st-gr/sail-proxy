export {}; // make this a TS module so top-level consts don't share global scope (avoids TS2451 across test files)
const runner = require('../../../../cli-tools/sail-recon-profile.js');

describe('sail-recon-profile core', () => {
  it('imageTokens matches the gateway tile formula', () => {
    expect(runner.imageTokens(1540, 1540, 0)).toBe(110 * 110); // ceil(1540/14)=110
    expect(runner.imageTokens(28, 14, 5)).toBe(2 * 1 + 5);
  });

  it('default imageOverhead matches the gateway per-image constant (85)', () => {
    // Gateway: imageTokenOverhead() in services/gateway/src/utils/imageTokenCapture.ts.
    // Smoke-verified 2026-09-03: captured 12185 = 110*110 + 85 per 1540x1540 image.
    const cfg = runner.DEFAULT_CONFIG;
    expect(cfg.imageOverhead).toBe(85);
    expect(runner.imageTokens(cfg.imageWidth, cfg.imageHeight, cfg.imageOverhead)).toBe(12185);
  });

  it('makeSolidPng emits a PNG whose IHDR encodes the exact dimensions', () => {
    const png = runner.makeSolidPng(64, 48);
    expect(png.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG signature
    // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(48);
  });

  it('makeSolidPng writes a valid CRC32 on every chunk and IDAT inflates to the raw image', () => {
    const zlib = require('zlib');
    // Standard PNG CRC32 (reversed polynomial 0xEDB88320) over each chunk's type+data.
    const table = (() => {
      const t = new Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (buf: Buffer) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };

    const w = 32, h = 16;
    const png = runner.makeSolidPng(w, h);
    const chunks: string[] = [];
    let off = 8; // skip the 8-byte signature
    let idat: Buffer | null = null;
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.slice(off + 4, off + 8).toString('ascii');
      const storedCrc = png.readUInt32BE(off + 8 + len);
      // CRC is computed over type + data, not the length prefix.
      expect(crc32(png.slice(off + 4, off + 8 + len))).toBe(storedCrc);
      if (type === 'IDAT') idat = png.slice(off + 8, off + 8 + len);
      chunks.push(type);
      off += 12 + len; // length(4) + type(4) + data(len) + crc(4)
    }
    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    // IDAT is zlib-wrapped; it must inflate to exactly h rows of (1 filter byte + w*3 RGB), all zero.
    expect(idat).not.toBeNull();
    const raw = zlib.inflateSync(idat as Buffer);
    expect(raw.length).toBe(h * (1 + w * 3));
    expect(raw.every((b: number) => b === 0)).toBe(true);
  });

  it('resolveConfig applies overrides over defaults', () => {
    const cfg = runner.resolveConfig({ cacheReadRepeats: 5 });
    expect(cfg.cacheReadRepeats).toBe(5);
    expect(cfg.model).toBe('anthropic--claude-4.5-sonnet--deployed');
  });

  it('buildCacheWriteRequest puts cache_control on a distinct large block', () => {
    const cfg = runner.resolveConfig({ cacheContextTokens: 10 });
    const a = runner.buildCacheWriteRequest(cfg, 'n1');
    const b = runner.buildCacheWriteRequest(cfg, 'n2');
    const blockA = a.messages[0].content[0];
    expect(blockA.cache_control).toEqual({ type: 'ephemeral' });
    expect(a.temperature).toBe(0);
    expect(blockA.text).not.toEqual(b.messages[0].content[0].text); // nonce makes each a fresh write
  });

  it('buildImageRequest carries a base64 image block, no cache_control', () => {
    const cfg = runner.resolveConfig({});
    const req = runner.buildImageRequest(cfg, 'QUJD');
    const block = req.messages[0].content.find((c: any) => c.type === 'image');
    expect(block.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
    expect(JSON.stringify(req)).not.toContain('cache_control');
  });
});
