/**
 * Invoked-tool recording for a controller that writes its stream itself (the Bedrock service writes
 * Anthropic-shaped or native Bedrock frames straight to `res`). Each written chunk is scanned for
 * tool calls that START in it, before it goes out - so the calls are recorded before the stream's
 * own usage event is emitted at its end. A frame split across writes (the direct-passthrough branch
 * forwards raw upstream network chunks, with no regard for SSE frame boundaries) is reassembled: the
 * text after the last newline of each chunk is held over and prefixed onto the next one before
 * scanning, so only the completed lines are ever handed to the adapter. Only a "line" longer than
 * 64 KiB - never a real tool-start frame - is skipped, so a stream with no newlines at all cannot
 * grow this held-over text without bound. The write itself is never altered, delayed or dropped:
 * the original chunk is always forwarded immediately, byte for byte. A chunk handed to `end()` is
 * scanned the same way, and whatever is still held over is scanned then as the final line.
 */
import { recordInvokedTools, stateOf } from './record';
import type { ToolAdapter } from './adapters/types';

const MAX_PENDING = 64 * 1024;

export function tapStreamedTools(req: any, res: any, adapter: ToolAdapter): void {
  if (!stateOf(req) || typeof res?.write !== 'function') return;
  const write = res.write.bind(res);
  let pending = '';
  const textOf = (chunk: any): string => (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');
  res.write = (chunk: any, ...rest: any[]) => {
    try {
      const chunkText = textOf(chunk);
      if (chunkText) {
        const text = pending + chunkText;
        const cut = text.lastIndexOf('\n');
        const complete = cut === -1 ? '' : text.slice(0, cut + 1);
        pending = cut === -1 ? text : text.slice(cut + 1);
        if (pending.length > MAX_PENDING) pending = '';
        if (complete) recordInvokedTools(req, adapter.invokedToolsFromStream(complete));
      }
    } catch { /* recording never breaks the stream */ }
    return write(chunk, ...rest);
  };
  // The last chunk may come with end() instead of write(); nothing follows it, so the held-over
  // tail is scanned as a final line.
  if (typeof res.end !== 'function') return;
  const end = res.end.bind(res);
  res.end = (...args: any[]) => {
    try {
      const text = pending + textOf(args[0]);
      pending = '';
      if (text) recordInvokedTools(req, adapter.invokedToolsFromStream(`${text}\n`));
    } catch { /* recording never breaks the stream */ }
    return end(...args);
  };
}
