/**
 * sseEventSource decodes the provider's bytes as UTF-8 across chunk boundaries: a character cut
 * between two network chunks must come out whole, and an event cut between two chunks once.
 */
import { describe, it, expect } from '@jest/globals';
import { PassThrough } from 'stream';
import { sseEventSource } from '../../src/upstreams/messagesDispatch';

describe('sseEventSource', () => {
  it('keeps multi-byte characters and split events intact', () => {
    const text = 'Grüße 😀';
    const event = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { text } })}\n\n`;
    const second = `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    const bytes = Buffer.from(event + second, 'utf8');
    const cutUe = bytes.indexOf(Buffer.from('ü')) + 1; // inside ü (2 bytes)
    const cutEmoji = bytes.indexOf(Buffer.from('😀')) + 2; // inside the 4-byte emoji
    const stream = new PassThrough();
    const got: any[] = [];
    const source = sseEventSource(stream, (e) => got.push(e));
    stream.write(bytes.subarray(0, cutUe));
    stream.write(bytes.subarray(cutUe, cutEmoji));
    stream.write(bytes.subarray(cutEmoji, bytes.length - 10)); // the second event cut in two
    stream.write(bytes.subarray(bytes.length - 10));
    source.flush();
    expect(got.map((e) => e.type)).toEqual(['content_block_delta', 'message_stop']);
    expect(got[0].delta.text).toBe(text);
  });
});
