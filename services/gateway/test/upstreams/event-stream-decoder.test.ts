import { crc32, encodeEventStreamMessage } from '../../src/utils/bedrockEventStream';
import { EventStreamDecoder, EventStreamError } from '../../src/utils/eventStreamDecoder';

const frame = (event: string, body: unknown): Buffer =>
  encodeEventStreamMessage(
    { ':event-type': event, ':content-type': 'application/json', ':message-type': 'event' },
    Buffer.from(JSON.stringify(body), 'utf8'));

const frames = [
  frame('chunk', { bytes: 'aGVsbG8=' }),
  frame('chunk', { text: 'héllo wörld ✓' }),
  encodeEventStreamMessage({ ':message-type': 'event' }, Buffer.alloc(0)),
];
const stream = Buffer.concat(frames);

const summarize = (messages: { headers: Record<string, string>; payload: Buffer }[]) =>
  messages.map((m) => ({ headers: m.headers, payload: m.payload.toString('utf8') }));

describe('EventStreamDecoder', () => {
  const expected = [
    { headers: { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' }, payload: '{"bytes":"aGVsbG8="}' },
    { headers: { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' }, payload: '{"text":"héllo wörld ✓"}' },
    { headers: { ':message-type': 'event' }, payload: '' },
  ];

  it('decodes three messages pushed whole', () => {
    const decoder = new EventStreamDecoder();
    expect(summarize(decoder.push(stream))).toEqual(expected);
    expect(decoder.pending).toBe(0);
  });

  it('decodes the same messages when split at every byte offset', () => {
    for (let at = 0; at <= stream.length; at++) {
      const decoder = new EventStreamDecoder();
      const out = [...decoder.push(stream.subarray(0, at)), ...decoder.push(stream.subarray(at))];
      expect(summarize(out)).toEqual(expected);
      expect(decoder.pending).toBe(0);
    }
  });

  it('decodes one byte at a time and reports the bytes held', () => {
    const decoder = new EventStreamDecoder();
    const out = [];
    for (let i = 0; i < frames[0].length - 1; i++) out.push(...decoder.push(stream.subarray(i, i + 1)));
    expect(out).toEqual([]);
    expect(decoder.pending).toBe(frames[0].length - 1);
  });

  it('throws EventStreamError on a prelude CRC mismatch', () => {
    const bad = Buffer.from(frames[0]);
    bad[9] ^= 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(EventStreamError);
  });

  it('throws EventStreamError on a message CRC mismatch', () => {
    const bad = Buffer.from(frames[0]);
    bad[bad.length - 1] ^= 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(EventStreamError);
  });

  it('throws EventStreamError on a corrupted payload byte', () => {
    const bad = Buffer.from(frames[0]);
    bad[bad.length - 6] ^= 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(EventStreamError);
  });

  it('throws EventStreamError on a non-string header', () => {
    // header: name len 1, "x", type 4 (int32), 4 value bytes -> rebuild with valid CRCs
    const headers = Buffer.from([1, 0x78, 4, 0, 0, 0, 1]);
    const prelude = Buffer.alloc(12);
    prelude.writeUInt32BE(12 + headers.length + 4, 0);
    prelude.writeUInt32BE(headers.length, 4);
    prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
    const body = Buffer.concat([prelude, headers]);
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(crc32(body), 0);
    expect(() => new EventStreamDecoder().push(Buffer.concat([body, trailer]))).toThrow(EventStreamError);
  });

  describe('malformed lengths and headers (valid CRCs)', () => {
    /** Prelude with the given lengths and a valid prelude CRC. */
    const prelude = (total: number, headersLength: number): Buffer => {
      const buf = Buffer.alloc(12);
      buf.writeUInt32BE(total, 0);
      buf.writeUInt32BE(headersLength, 4);
      buf.writeUInt32BE(crc32(buf.subarray(0, 8)), 8);
      return buf;
    };
    /** A whole message around raw header bytes, both CRCs valid. */
    const withRawHeaders = (headers: Buffer): Buffer => {
      const body = Buffer.concat([prelude(12 + headers.length + 4, headers.length), headers]);
      const trailer = Buffer.alloc(4);
      trailer.writeUInt32BE(crc32(body), 0);
      return Buffer.concat([body, trailer]);
    };

    it('rejects a total length below the 16-byte minimum', () => {
      expect(() => new EventStreamDecoder().push(prelude(15, 0))).toThrow(EventStreamError);
    });

    it('rejects a total length above the 16 MB cap without waiting for the bytes', () => {
      expect(() => new EventStreamDecoder().push(prelude(16 * 1024 * 1024 + 1, 0))).toThrow(EventStreamError);
    });

    it('rejects a headers length larger than the total allows', () => {
      expect(() => new EventStreamDecoder().push(prelude(20, 100))).toThrow(EventStreamError);
    });

    it('rejects a header whose value length runs past the header block', () => {
      const headers = Buffer.from([1, 0x78, 7, 0, 100, 0x61]); // name "x", string, claims 100 bytes, has 1
      expect(() => new EventStreamDecoder().push(withRawHeaders(headers))).toThrow(EventStreamError);
    });

    it('rejects headers that end inside a header', () => {
      const headers = Buffer.from([255]); // a name length with no name behind it
      expect(() => new EventStreamDecoder().push(withRawHeaders(headers))).toThrow(EventStreamError);
    });
  });
});
