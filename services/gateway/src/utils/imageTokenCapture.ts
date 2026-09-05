/**
 * Off-hot-path image-token compute for the SAP orchestration route.
 *
 * The Responses route (`responsesController.ts`'s native/deployed path) gets
 * `input_tokens_details.image_tokens` straight from SAP's own usage object --
 * cheap and synchronous, no sniffing needed. Orchestration (chat/completions,
 * and Responses-via-orchestration) reports no such figure, so this module
 * computes it locally from the request's own images, via `imageDimensions.ts`'s
 * header-only sniffer (Task 8) -- but ONLY after the client response is
 * already on the wire. See spec §7.3: the client must never wait on image
 * sniffing.
 *
 * `captureImageTokensAsync` returns synchronously having done nothing but
 * `setImmediate` a task; the actual sniff + fold runs on a later turn of the
 * event loop. An optional `onComplete` callback lets the (still
 * fire-and-forget) usage-event emission be sequenced to happen after the
 * fold completes -- required so the emitted event's `imageInputTokens` is
 * ever non-zero, rather than racing a same-tick emit that fires before the
 * deferred fold ever runs.
 */
import { Request } from 'express';
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import { sniffImageDimensions, imageTokensFromDimensions } from './imageDimensions';
import { updateTokenCounts } from './usageTracker';
import { UsageMetrics } from '../types/usage';

const logger = getDefaultLogger();

// Every supported format's header lives well inside this many bytes (PNG needs 24,
// GIF 10, WebP <= 30, JPEG may need to walk a few segments past APP0/EXIF/ICC blocks
// on a real photo). Generous on purpose -- this is a one-time deferred read, not
// something that runs on the request path.
const HEADER_BYTES_NEEDED = 4096;

function imageTokenOverhead(): number {
  const raw = process.env.IMAGE_TOKEN_OVERHEAD;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 85;
}

/**
 * Decode a bounded prefix of a base64 `data:` URL's payload -- never the whole
 * thing. A multi-megabyte inlined image would make a full decode itself a cost
 * worth avoiding, even off the hot path.
 */
function bytesFromDataUrl(ref: string): Buffer | null {
  if (!ref.startsWith('data:')) return null;
  const commaIdx = ref.indexOf(',');
  if (commaIdx === -1) return null;
  const meta = ref.slice('data:'.length, commaIdx);
  if (!/;base64$/i.test(meta)) return null; // percent-encoded data URLs carry no raw bytes to decode this way
  const base64Body = ref.slice(commaIdx + 1);
  // 4 base64 chars decode to 3 bytes; round up so the decoded prefix comfortably covers
  // HEADER_BYTES_NEEDED.
  const prefixChars = Math.ceil((HEADER_BYTES_NEEDED * 4) / 3 / 4) * 4;
  try {
    return Buffer.from(base64Body.slice(0, prefixChars), 'base64');
  } catch {
    return null;
  }
}

/**
 * A SINGLE bounded fetch for a ref the request-time plugins left remote --
 * acceptable here (deferred task only, never on the hot path) but not on the
 * common path: both `responsesImagePlugin.ts` and the chat-completions
 * Anthropic-image handling already inline remote images to `data:` URLs
 * before this ever runs, so this is a fallback for whatever they leave alone
 * (e.g. a non-Anthropic chat-completions image sent as a remote URL).
 */
async function bytesFromRemoteUrl(url: string): Promise<Buffer | null> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 3000,
      headers: { Range: `bytes=0-${HEADER_BYTES_NEEDED - 1}` },
      maxContentLength: HEADER_BYTES_NEEDED * 4,
      validateStatus: (status) => status === 200 || status === 206,
    });
    return Buffer.from(response.data);
  } catch {
    return null;
  }
}

async function bytesForRef(ref: string): Promise<Buffer | null> {
  if (ref.startsWith('data:')) return bytesFromDataUrl(ref);
  if (/^https?:\/\//i.test(ref)) return bytesFromRemoteUrl(ref);
  return null;
}

/**
 * This ref's SAP-formula token count, or 0 when its dimensions cannot be
 * determined -- never guessed. Never throws.
 */
async function tokensForRef(ref: string, overhead: number): Promise<number> {
  let dims = null;
  try {
    const buf = await bytesForRef(ref);
    dims = buf ? sniffImageDimensions(buf) : null;
  } catch {
    dims = null;
  }
  if (!dims) {
    logger.info('imageTokenCapture', 'dimensions undeterminable — imageInputTokens left 0', { ref });
    return 0;
  }
  return imageTokensFromDimensions(dims.width, dims.height, overhead);
}

/**
 * Schedule the compute. Returns immediately -- the caller (an orchestration
 * controller) has already served, or is about to serve, the client response
 * before this ever runs. `imageRefs` entries are `data:` URLs (the common
 * case) or still-remote URLs (fetched, bounded, inside the deferred task).
 *
 * `onComplete`, when given, runs after the fold (or immediately, synchronously,
 * when there is nothing to do) so a caller can sequence its usage-event
 * emission to happen only once `metrics.imageInputTokens` is final.
 */
export function captureImageTokensAsync(
  // Not read today -- part of the documented call shape (every caller already has it in
  // scope) and the natural place to hang request-scoped context (debug id, abort signal)
  // if a future caller needs it.
  _req: Request,
  metrics: UsageMetrics,
  imageRefs: string[] | undefined,
  onComplete?: () => void,
): void {
  if (!imageRefs || imageRefs.length === 0) {
    onComplete?.();
    return;
  }

  const overhead = imageTokenOverhead();
  const refs = imageRefs.slice();

  setImmediate(() => {
    void (async () => {
      let total = 0;
      for (const ref of refs) {
        total += await tokensForRef(ref, overhead);
      }
      if (total > 0) {
        updateTokenCounts(metrics, 0, 0, 0, 0, total);
      }
      onComplete?.();
    })();
  });
}
