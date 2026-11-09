/**
 * Header-only image dimension sniffer.
 *
 * Reads pixel width/height for PNG, JPEG, GIF and WebP directly from a
 * buffer's leading header bytes -- no full image decode, no image library.
 * Used to compute SAP's per-image token estimate (see
 * `imageTokensFromDimensions`) without paying the cost of decoding the
 * image itself.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, i) => buf[i] === byte);
}

function sniffPng(buf: Buffer): ImageDimensions | null {
  // Signature (8 bytes) + IHDR length (4) + "IHDR" (4) + width (4 BE) + height (4 BE)
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function isGif(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  return (
    buf[0] === 0x47 && // G
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x38 && // 8
    (buf[4] === 0x37 || buf[4] === 0x39) && // 7 or 9
    buf[5] === 0x61 // a
  );
}

function sniffGif(buf: Buffer): ImageDimensions | null {
  // "GIF87a"/"GIF89a" (6 bytes) + width (2 LE) + height (2 LE)
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Walk JPEG segments (marker + big-endian length, length inclusive of
 * itself) looking for a Start-Of-Frame marker (0xFFC0-0xFFCF, excluding the
 * Huffman/arithmetic-table-definition markers 0xFFC4/0xFFC8/0xFFCC, which
 * reuse the SOF marker range). Height/width are big-endian 2-byte fields at
 * marker+5/marker+7 in every SOF variant.
 */
function sniffJpeg(buf: Buffer): ImageDimensions | null {
  let pos = 2;
  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    let marker = buf[pos + 1];
    // Skip fill bytes (0xFF padding before the actual marker code).
    while (marker === 0xff && pos + 2 < buf.length) {
      pos++;
      marker = buf[pos + 1];
    }
    // Markers with no length field: SOI, EOI, TEM, RSTn.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 8 >= buf.length) return null;
      const height = buf.readUInt16BE(pos + 5);
      const width = buf.readUInt16BE(pos + 7);
      return { width, height };
    }
    if (pos + 3 >= buf.length) return null;
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) return null; // malformed segment; avoid an infinite loop
    pos += 2 + length;
  }
  return null;
}

function isWebp(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return (
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50 // P
  );
}

const WEBP_CHUNK_DATA_OFFSET = 20; // "RIFF"(4) + size(4) + "WEBP"(4) + fourCC(4) + chunkSize(4)

function sniffWebp(buf: Buffer): ImageDimensions | null {
  const fourCC = buf.toString('ascii', 12, 16);

  if (fourCC === 'VP8X') {
    // Extended format: flags(1) + reserved(3) + width-1(3 LE) + height-1(3 LE)
    if (buf.length < WEBP_CHUNK_DATA_OFFSET + 10) return null;
    const width = buf.readUIntLE(WEBP_CHUNK_DATA_OFFSET + 4, 3) + 1;
    const height = buf.readUIntLE(WEBP_CHUNK_DATA_OFFSET + 7, 3) + 1;
    return { width, height };
  }

  if (fourCC === 'VP8L') {
    // Lossless format: signature byte 0x2F, then a 4-byte LE value packing
    // 14-bit width-1, 14-bit height-1, 1-bit alpha flag, 3-bit version.
    if (buf.length < WEBP_CHUNK_DATA_OFFSET + 5) return null;
    if (buf[WEBP_CHUNK_DATA_OFFSET] !== 0x2f) return null;
    const value = buf.readUInt32LE(WEBP_CHUNK_DATA_OFFSET + 1);
    const width = (value & 0x3fff) + 1;
    const height = ((value >>> 14) & 0x3fff) + 1;
    return { width, height };
  }

  if (fourCC === 'VP8 ') {
    // Lossy format: 3-byte frame tag, 3-byte start code (0x9D 0x01 0x2A),
    // then 14-bit width and height, each packed into a little-endian 2-byte field.
    if (buf.length < WEBP_CHUNK_DATA_OFFSET + 10) return null;
    const startCodeOffset = WEBP_CHUNK_DATA_OFFSET + 3;
    if (buf[startCodeOffset] !== 0x9d || buf[startCodeOffset + 1] !== 0x01 || buf[startCodeOffset + 2] !== 0x2a) {
      return null;
    }
    const widthField = buf.readUInt16LE(WEBP_CHUNK_DATA_OFFSET + 6);
    const heightField = buf.readUInt16LE(WEBP_CHUNK_DATA_OFFSET + 8);
    return { width: widthField & 0x3fff, height: heightField & 0x3fff };
  }

  return null;
}

/**
 * Read pixel dimensions from an image buffer's header bytes only (no full
 * decode, no image library). Supports PNG, JPEG, GIF and WebP (VP8/VP8L/VP8X).
 * Returns `null` for unrecognized formats or buffers too short to contain
 * the relevant header.
 */
export function sniffImageDimensions(buf: Buffer): ImageDimensions | null {
  if (!buf || buf.length === 0) return null;

  if (isPng(buf)) return sniffPng(buf);
  if (isGif(buf)) return sniffGif(buf);
  if (isJpeg(buf)) return sniffJpeg(buf);
  if (isWebp(buf)) return sniffWebp(buf);

  return null;
}

/**
 * SAP's per-image token formula: each axis is capped at 1540px, tiled into
 * 14px cells (partial cells count as a full cell via ceil), and the tile
 * counts are multiplied together before adding a fixed per-image overhead.
 */
export function imageTokensFromDimensions(w: number, h: number, overhead: number): number {
  const cap = (x: number) => Math.min(x, 1540);
  return Math.ceil(cap(w) / 14) * Math.ceil(cap(h) / 14) + (overhead || 0);
}
