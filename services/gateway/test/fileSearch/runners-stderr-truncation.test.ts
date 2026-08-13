// Task 11 review (C-fold-in item): pandoc/pdftotext error output can quote
// fragments of the document they failed to parse -- runners.ts's own doc
// comment claimed stderr was "only used to build a human-readable error
// message", which is true, but did not bound how much of it, or what
// characters, end up in that message. Since that message flows straight
// into ingestWorker.ts's last_error column and its error log, an
// unsanitized/unbounded stderr was a document-content leak. This is a new
// test file (not a modification of the existing runners.test.ts, which
// already covers stderr surfacing for a small, control-character-free
// message) specifically for the truncation/sanitization behavior.
import * as path from 'path';
import { runExtractor } from '../../src/fileSearch/extractors/runners';

const FIXTURE = path.join(__dirname, 'fixtures', 'stderrFloodProcess.js');

describe('runExtractor stderr truncation (Task 11 review fold-in)', () => {
  it('truncates a long stderr message and strips control characters before it reaches the rejected Error', async () => {
    await expect(runExtractor('node', [FIXTURE], Buffer.from(''), { timeoutMs: 5000 })).rejects.toThrow();

    let message = '';
    try {
      await runExtractor('node', [FIXTURE], Buffer.from(''), { timeoutMs: 5000 });
    } catch (error: any) {
      message = error.message;
    }

    expect(message).toMatch(/exited with code 7/);
    // The fixture wrote >5000 bytes of stderr (padding, then a trailing
    // marker) -- none of that bulk survives, proving truncation, not just a
    // generous cap.
    expect(message.length).toBeLessThan(400);
    expect(message).not.toContain('DOCUMENT_FRAGMENT_END');
    // No raw NUL/control bytes, and no literal newline -- the fixture wrote
    // one right next to "EVIL_NEWLINE_INJECTED"; a literal '\n' surviving
    // into the message would let stderr content forge a second log line
    // when this reaches ingestWorker.ts's logger.error call.
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\x00-\x08\x0e-\x1f\x7f]/);
    expect(message).not.toContain('\n');
    // A truncation marker is present so a reader knows content was cut,
    // rather than silently looking like the whole message.
    expect(message).toMatch(/truncated/);
  });
});
