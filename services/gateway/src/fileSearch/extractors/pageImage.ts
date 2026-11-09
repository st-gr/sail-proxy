// A rendered PDF page (pdftoppm's 8-bit grey PGM, pdfOcr.ts popplerPageRenderer) as an image a
// vision model reads: at most `maxSidePx` on its long side, encoded as a grey PNG, as a base64
// data URL (the shape orchestrationCompletion.ts sends as an `image_url` part).
//
// sharp (libvips) does the resize and the encoding. Its prebuilt binaries cannot read PGM from a
// buffer, so the PGM header is parsed here and the pixels are handed over raw (one channel).
//
// sharp is loaded on first use, not imported at the top: it is a native module, and until W3 the
// gateway only loaded it inside a plugin. A host where it does not load (an unsupported platform, an
// install without its optional platform package — possible for the npm standalone CLI) must keep
// starting and ingesting; there, vision is unavailable with a warning and pages fall back to OCR or
// their text layer (visionTranscriber.ts).
import type SharpType from 'sharp';

/** A parsed binary PGM (P5) with an 8-bit maxval. */
export interface Pgm {
  width: number;
  height: number;
  /** width × height bytes, one per pixel. */
  pixels: Buffer;
}

/** The header token after `at`, skipping whitespace and `#` comments; null when the header ends. */
function headerToken(buf: Buffer, at: number): { value: string; end: number } | null {
  let i = at;
  for (;;) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
    if (i < buf.length && buf[i] === 0x23) { // '#': a comment to the end of the line
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      continue;
    }
    break;
  }
  const start = i;
  while (i < buf.length && i - start < 16 && !/\s/.test(String.fromCharCode(buf[i])) && buf[i] !== 0x23) i += 1;
  if (i === start || i >= buf.length) return null;
  return { value: buf.toString('latin1', start, i), end: i };
}

/** Parse pdftoppm's `-gray` output. Throws on anything but a complete 8-bit P5 image. */
export function parsePgm(buf: Buffer): Pgm {
  const magic = headerToken(buf, 0);
  if (!magic || magic.value !== 'P5') throw new Error('The page image is not a binary PGM');
  const w = headerToken(buf, magic.end);
  const h = w && headerToken(buf, w.end);
  const max = h && headerToken(buf, h.end);
  if (!w || !h || !max) throw new Error('The page image header is incomplete');
  const width = Number(w.value);
  const height = Number(h.value);
  const maxval = Number(max.value);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('The page image has an invalid size');
  }
  if (maxval < 1 || maxval > 255) throw new Error('The page image is not 8-bit');
  // Exactly one whitespace byte separates the header from the pixels.
  const start = max.end + 1;
  const bytes = width * height;
  if (buf.length - start < bytes) throw new Error('The page image is truncated');
  return { width, height, pixels: buf.subarray(start, start + bytes) };
}

let sharpModule: typeof SharpType | null | undefined;
let sharpError = '';

/** sharp, or null when it cannot be loaded on this host (see the module comment). */
export function loadSharp(): typeof SharpType | null {
  if (sharpModule === undefined) {
    try {
      const loaded = require('sharp');
      sharpModule = (loaded?.default ?? loaded) as typeof SharpType;
    } catch (err) {
      sharpModule = null;
      sharpError = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
  }
  return sharpModule;
}

/** Why sharp did not load ('' when it did or was not tried). */
export function sharpLoadError(): string {
  return sharpError;
}

export interface PageImage {
  /** `data:image/png;base64,…` */
  dataUrl: string;
  width: number;
  height: number;
  /** The PNG's size in bytes. */
  bytes: number;
}

/**
 * The page image `pgm` as a grey PNG data URL whose long side is at most `maxSidePx` (aspect ratio
 * kept, never enlarged). Throws when sharp is unavailable or the image cannot be read.
 */
export async function pageImageDataUrl(pgm: Buffer, maxSidePx: number): Promise<PageImage> {
  const sharp = loadSharp();
  if (!sharp) throw new Error(`The image library could not be loaded: ${sharpError}`);
  const { width, height, pixels } = parsePgm(pgm);
  const { data, info } = await sharp(pixels, {
    raw: { width, height, channels: 1 },
    limitInputPixels: width * height,
  })
    .resize({ width: maxSidePx, height: maxSidePx, fit: 'inside', withoutEnlargement: true })
    .toColourspace('b-w')
    .png({ compressionLevel: 6 })
    .toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/png;base64,${data.toString('base64')}`, width: info.width, height: info.height, bytes: data.length };
}
