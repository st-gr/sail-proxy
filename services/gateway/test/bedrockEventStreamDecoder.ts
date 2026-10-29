/**
 * An independent reader of the AWS event stream wire format (application/vnd.amazon.eventstream),
 * written from the published layout rather than from src/utils/bedrockEventStream.ts, so the
 * encoder is checked against the format and not against itself:
 *
 *   total length (u32 BE) | headers length (u32 BE) | prelude CRC32 (u32 BE)
 *   headers: name length (u8) | name | value type (u8, 7 = string) | value length (u16 BE) | value
 *   payload | message CRC32 (u32 BE, over everything before it)
 *
 * Both CRCs are checked with Node's zlib.crc32.
 */
import * as zlib from 'zlib';

export interface DecodedFrame {
  headers: Record<string, string>;
  payload: Buffer;
}

export function decodeEventStream(buf: Buffer): DecodedFrame[] {
  const crc32 = (zlib as any).crc32 as (data: Buffer) => number;
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 16) throw new Error(`truncated frame at ${offset}`);
    const total = buf.readUInt32BE(offset);
    const headersLength = buf.readUInt32BE(offset + 4);
    if (crc32(buf.subarray(offset, offset + 8)) !== buf.readUInt32BE(offset + 8)) {
      throw new Error(`prelude CRC mismatch at ${offset}`);
    }
    if (crc32(buf.subarray(offset, offset + total - 4)) !== buf.readUInt32BE(offset + total - 4)) {
      throw new Error(`message CRC mismatch at ${offset}`);
    }
    const headers: Record<string, string> = {};
    let h = offset + 12;
    const headersEnd = h + headersLength;
    while (h < headersEnd) {
      const nameLength = buf.readUInt8(h);
      const name = buf.subarray(h + 1, h + 1 + nameLength).toString('utf8');
      h += 1 + nameLength;
      const type = buf.readUInt8(h);
      if (type !== 7) throw new Error(`header ${name} has type ${type}, expected 7 (string)`);
      const valueLength = buf.readUInt16BE(h + 1);
      headers[name] = buf.subarray(h + 3, h + 3 + valueLength).toString('utf8');
      h += 3 + valueLength;
    }
    frames.push({ headers, payload: buf.subarray(headersEnd, offset + total - 4) });
    offset += total;
  }
  return frames;
}

/** The JSON payload of a frame. */
export const payloadJson = (f: DecodedFrame): any => JSON.parse(f.payload.toString('utf8'));

/** An invoke-with-response-stream `chunk` frame's inner event: base64 `bytes` → JSON. */
export const chunkEvent = (f: DecodedFrame): any =>
  JSON.parse(Buffer.from(payloadJson(f).bytes, 'base64').toString('utf8'));
