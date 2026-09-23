import { describe, it, expect } from '@jest/globals';
import { Readable } from 'stream';
import { parseMultipartFields, extractBoundary, MalformedMultipartError } from '../src/utils/multipart';

const BOUNDARY = 'XyZ12345';
function body(parts: Array<{ name: string; filename?: string; type?: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `Content-Disposition: form-data; name="${p.name}"` + (p.filename ? `; filename="${p.filename}"` : '');
    const type = p.type ? `\r\nContent-Type: ${p.type}` : '';
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${disp}${type}\r\n\r\n`, 'latin1'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}
/** Delivers the body in tiny chunks so boundary handling across chunk edges is exercised. */
function stream(buf: Buffer, chunk = 7): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunk) pieces.push(buf.subarray(i, i + chunk));
  return Readable.from(pieces);
}
const opts = { maxBytes: 1024 * 1024, fileFields: ['image', 'mask'], textFields: ['prompt', 'n', 'size'] };

describe('parseMultipartFields', () => {
  it('collects text fields and files in order, normalising image[] to image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8]);
    const parsed = await parseMultipartFields(stream(body([
      { name: 'prompt', data: 'make it blue' },
      { name: 'image[]', filename: 'a.png', type: 'image/png', data: png },
      { name: 'n', data: '2' },
      { name: 'image[]', filename: 'b.jpg', type: 'image/jpeg', data: jpg },
    ])), BOUNDARY, opts);
    expect(parsed.error).toBeNull();
    expect(parsed.tooLarge).toBe(false);
    expect(parsed.fields).toEqual({ prompt: 'make it blue', n: '2' });
    expect(parsed.files.map((f) => [f.field, f.filename, f.contentType, f.bytes.length])).toEqual([
      ['image', 'a.png', 'image/png', png.length], ['image', 'b.jpg', 'image/jpeg', jpg.length],
    ]);
    expect(parsed.files[0].bytes.equals(png)).toBe(true);
    expect(parsed.files[1].bytes.equals(jpg)).toBe(true);
  });
  it('ignores parts with unknown names but still counts their bytes against maxBytes', async () => {
    const parsed = await parseMultipartFields(stream(body([
      { name: 'prompt', data: 'x' }, { name: 'other', data: 'y'.repeat(50) },
    ])), BOUNDARY, { ...opts, maxBytes: 40 });
    expect(parsed.tooLarge).toBe(true);
  });
  it('reports an over-budget text field in truncated and still parses the rest', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
    const parsed = await parseMultipartFields(stream(body([
      { name: 'prompt', data: 'p'.repeat(500) },
      { name: 'n', data: '2' },
      { name: 'image', filename: 'a.png', type: 'image/png', data: png },
    ])), BOUNDARY, { ...opts, maxTextFieldBytes: 64 });
    expect(parsed.error).toBeNull();
    expect(parsed.tooLarge).toBe(false);
    expect(parsed.truncated).toEqual(['prompt']);
    // Only the budget is kept (bounded memory), and every other part is unaffected — the
    // caller is what decides whether a marked field is a refusal.
    expect(parsed.fields.prompt).toHaveLength(64);
    expect(parsed.fields.n).toBe('2');
    expect(parsed.files[0].bytes.equals(png)).toBe(true);
  });
  it('leaves truncated empty for a text field inside the budget', async () => {
    const parsed = await parseMultipartFields(stream(body([{ name: 'prompt', data: 'p'.repeat(3000) }])), BOUNDARY, { ...opts, maxTextFieldBytes: 32 * 1024 });
    expect(parsed.truncated).toEqual([]);
    expect(parsed.fields.prompt).toHaveLength(3000);
  });
  it('refuses a file part over maxFileBytes DURING the stream, destroying the request', async () => {
    // 5 KB of image bytes fed in 7-byte chunks against a 1 KB per-file cap: the parse has to
    // settle (and tear the request down) long before the body ends, or the cap is post-hoc.
    const big = Buffer.alloc(5 * 1024, 0x41);
    const src = stream(body([{ name: 'prompt', data: 'x' }, { name: 'image', filename: 'big.png', type: 'image/png', data: big }]));
    let destroyed = false;
    const readBytes: number[] = [];
    src.on('data', (c: Buffer) => readBytes.push(c.length));
    // The real destroy is kept (so the stream genuinely stops being read), only observed.
    const realDestroy = src.destroy.bind(src);
    (src as any).destroy = (...a: any[]) => { destroyed = true; return (realDestroy as any)(...a); };
    const parsed = await parseMultipartFields(src, BOUNDARY, { ...opts, maxFileBytes: 1024 });
    expect(parsed.tooLarge).toBe(true);
    expect(parsed.tooLargeField).toBe('image');
    expect(destroyed).toBe(true);
    // Settled mid-body: far fewer than the ~740 seven-byte chunks the whole body holds.
    expect(readBytes.reduce((a, b) => a + b, 0)).toBeLessThan(2 * 1024);
  });
  it('accepts a file part at exactly maxFileBytes', async () => {
    const exact = Buffer.alloc(1024, 0x42);
    const parsed = await parseMultipartFields(stream(body([{ name: 'image', filename: 'a.png', type: 'image/png', data: exact }])), BOUNDARY, { ...opts, maxFileBytes: 1024 });
    expect(parsed.tooLarge).toBe(false);
    expect(parsed.tooLargeField).toBeUndefined();
    expect(parsed.files[0].bytes.length).toBe(1024);
  });
  it('reports a malformed body as MalformedMultipartError', async () => {
    const parsed = await parseMultipartFields(stream(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nunterminated`)), BOUNDARY, opts);
    expect(parsed.error).toBeInstanceOf(MalformedMultipartError);
  });
  it('extractBoundary still reads quoted and bare boundaries', () => {
    expect(extractBoundary('multipart/form-data; boundary="abc"')).toBe('abc');
    expect(extractBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(extractBoundary('application/json')).toBeNull();
  });
});
