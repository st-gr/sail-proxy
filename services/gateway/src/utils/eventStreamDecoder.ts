/**
 * Incremental decoder for AWS's binary event stream (application/vnd.amazon.eventstream),
 * the framing Bedrock streams answer in. Network chunks may cut a message anywhere, so
 * bytes are held until a whole message has arrived. Layout: see bedrockEventStream.ts.
 */
import { crc32 } from './bedrockEventStream';

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

export class EventStreamError extends Error {}

const PRELUDE_LENGTH = 12;
const TRAILER_LENGTH = 4;
const HEADER_TYPE_STRING = 7;
// Bedrock events are far below this; it stops a corrupt length from buffering without bound.
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

export class EventStreamDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Appends bytes; returns every message they complete. Throws EventStreamError on a CRC mismatch or a non-string header. */
  push(chunk: Buffer): EventStreamMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: EventStreamMessage[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= PRELUDE_LENGTH) {
      const total = this.buffer.readUInt32BE(offset);
      const headersLength = this.buffer.readUInt32BE(offset + 4);
      if (crc32(this.buffer.subarray(offset, offset + 8)) !== this.buffer.readUInt32BE(offset + 8)) {
        throw new EventStreamError('Event stream prelude CRC mismatch');
      }
      if (total < PRELUDE_LENGTH + headersLength + TRAILER_LENGTH || total > MAX_MESSAGE_LENGTH) {
        throw new EventStreamError('Event stream message length is invalid');
      }
      if (this.buffer.length - offset < total) break;
      const end = offset + total;
      if (crc32(this.buffer.subarray(offset, end - TRAILER_LENGTH)) !== this.buffer.readUInt32BE(end - TRAILER_LENGTH)) {
        throw new EventStreamError('Event stream message CRC mismatch');
      }
      const headersEnd = offset + PRELUDE_LENGTH + headersLength;
      messages.push({
        headers: this.readHeaders(offset + PRELUDE_LENGTH, headersEnd),
        payload: Buffer.from(this.buffer.subarray(headersEnd, end - TRAILER_LENGTH)),
      });
      offset = end;
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
    return messages;
  }

  /** Bytes held for an incomplete message. */
  get pending(): number {
    return this.buffer.length;
  }

  private readHeaders(start: number, end: number): Record<string, string> {
    const headers: Record<string, string> = {};
    let h = start;
    try {
      while (h < end) {
        const nameLength = this.buffer.readUInt8(h);
        const name = this.buffer.toString('utf8', h + 1, h + 1 + nameLength);
        h += 1 + nameLength;
        const type = this.buffer.readUInt8(h);
        if (type !== HEADER_TYPE_STRING) throw new EventStreamError(`Event stream header ${name} is not a string (type ${type})`);
        const valueLength = this.buffer.readUInt16BE(h + 1);
        if (h + 3 + valueLength > end) throw new EventStreamError(`Event stream header ${name} overruns the header block`);
        headers[name] = this.buffer.toString('utf8', h + 3, h + 3 + valueLength);
        h += 3 + valueLength;
      }
    } catch (error) {
      if (error instanceof EventStreamError) throw error;
      throw new EventStreamError('Event stream headers are truncated');
    }
    return headers;
  }
}
