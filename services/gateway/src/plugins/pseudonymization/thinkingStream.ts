/**
 * One streamed thinking block: restores its placeholders as the deltas arrive and collects what
 * the block's restore record needs (pluginSupport/pseudonymization/thinkingRoundTrip.ts).
 */
import { ReplacementMap } from '../../pluginSupport/pseudonymization/replacementMap';
import { Replacement, encodeRecord, maskedTextHash } from '../../pluginSupport/pseudonymization/thinkingRoundTrip';
import { StreamUnmaskBuffer } from './streamBuffer';

export class ThinkingStream {
  private readonly buffer: StreamUnmaskBuffer;
  /** The block's text as the model wrote it. Kept whole: a delta may end inside a surrogate pair, so the hash is taken once, over the text. */
  private masked = '';
  private readonly replacements: Replacement[] = [];
  /** Set once the record went onto the signature: the block's text is complete. */
  sealed = false;

  constructor(map: ReplacementMap) {
    // No containment: a placeholder the model invented stays in the text as it is, so the record
    // describes exactly the text the client holds.
    this.buffer = new StreamUnmaskBuffer(map, undefined, {
      onReplace: (placeholder, restored, offset) => {
        if (!this.sealed) this.replacements.push([offset, restored.length, placeholder]);
      },
    });
  }

  /**
   * A masked delta in, the text safe to send out (a placeholder cut by the delta is held back).
   * A delta after seal() is still restored; the record, already sent, does not cover it, so the
   * block falls back to the re-mask of known values when it returns.
   */
  append(maskedDelta: string): string {
    if (!this.sealed) this.masked += maskedDelta;
    return this.buffer.append(maskedDelta);
  }

  /** What is still held back, restored. */
  flush(): string {
    return this.buffer.flush();
  }

  /** Ends the block: the record for its signature, also when nothing was restored. Call after flush(). */
  seal(): string {
    this.sealed = true;
    return encodeRecord(maskedTextHash(this.masked), this.replacements);
  }
}
