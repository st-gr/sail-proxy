/**
 * Normalise remote `input_image` URLs to `data:` URLs on the Responses orchestration bridge.
 *
 * `requestTranslator.ts` (the bridge) accepts an `input_image` part only when its url is
 * already `data:image/…` — it is documented pure (no I/O, no downloads) and throws
 * `UnsupportedInputItemError` on a remote url. Codex replays its whole history every turn,
 * so a rejected image item bricks every subsequent turn too, not just the one that sent it.
 * This plugin is the guarantee the bridge's header refers to: it downloads a remote image
 * and rewrites the part to a `data:` URL BEFORE the bridge ever sees the request, which is
 * where I/O belongs on this route (see requestTranslator.ts:134-138 for the same pattern
 * applied to tools).
 *
 * REUSE. `openaiController.ts:1010-1057` already does exactly this for the chat path,
 * proven working (a remote PNG came back described correctly, with no trace of the
 * original URL in the upstream payload). The actual download + media-type-detection work —
 * `imageUtils.downloadAndEncodeImage` / `getMediaTypeFromUrl`, composed here via the new
 * `imageUtils.remoteUrlToDataUrl` — is reused unchanged. What is NOT shared is the
 * surrounding walk and failure handling: the chat path walks `message.content[]` looking
 * for `image_url` blocks and, on a failed download, logs and silently keeps the original
 * url (letting a network problem surface later as an opaque upstream 400). This plugin
 * walks Responses `input[].content[]` looking for `input_image` parts, and a failed
 * download here ends the request immediately with a 400 that NAMES the failure — seen live,
 * an earlier probe of this feature that used a Wikimedia URL failed exactly this way (the
 * download rejected for a missing User-Agent), and forwarding the untouched url would have
 * reached the bridge only to 400 as "Unsupported Responses input item type: input_image",
 * naming the symptom rather than the cause. Reusing the chat path's loop verbatim was
 * rejected: the two failure behaviours are deliberately different (see the plan's Task 2
 * decision on failure mode), and the item type each keeps (`image_url` vs `input_image`)
 * differs too, so sharing the outer walk would need to branch on both without buying back
 * any real de-duplication — the part actually at risk of drifting, the download itself, is
 * shared already.
 *
 * SIZE. No bound is applied here. `resizeOversizedImages.ts` exists but operates on
 * Anthropic-shaped `{type:'image'}` blocks and does not see `image_url` blocks, so it does
 * not apply on this route either way. The reused download path already carries this same
 * no-cap behaviour on the proven, deployed chat path today, so leaving it unbounded here is
 * parity, not a new risk introduced by this change — bounding request/token size for
 * inlined images is left as a follow-up.
 *
 * ROUTE SCOPE. Runs only when the request is going to take the orchestration bridge.
 * `responsesController.ts` resolves `native` vs `orchestration` BEFORE running before-plugins
 * and stashes the verdict on `req.__responsesRoute` for exactly this reason: the deployed
 * (native) route already accepts remote `input_image` urls today and must not be touched by
 * this change, so a request headed there is left alone here even though it carries the same
 * hook (`defaultHooks.openai.responses` / `responses-stream`) as an orchestration-bound one.
 *
 * MASKING ORDER, a known trade-off, not a bug. `pseudonymizationPlugin` sits at index 0 in
 * both hook arrays, ahead of this plugin, and its `replacer.ts` (`:77-88`) walks every string
 * under `body.input` — `image_url` values included — replacing anything that matches a
 * detected entity with a placeholder BEFORE this plugin ever reads the url. A remote url that
 * happens to contain a detectable entity (an embedded email address, say) therefore reaches
 * `downloadAndEncodeImage` already masked, and the fetch predictably fails against a url that
 * was never real. Where the chat path degrades quietly here (openaiController.ts:1054-1057,
 * log and keep the original — itself already masked, since pseudonymization runs ahead of
 * that path too), this plugin's new hard 400 (see the failure-mode note above) fires instead.
 * This plugin's position — after masking, so the unmasker still sees it — is still correct;
 * the trade-off is between a loud, immediate 400 on a masking-mangled url and the chat path's
 * silent pass-through of the same, and it is accepted rather than solved here.
 */
import { Request, Response } from 'express';
import * as imageUtils from '../utils/imageUtils';

interface Logger {
  error: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void;
  info: (m: string, meta?: any) => void; debug: (m: string, meta?: any) => void;
  trace: (m: string, meta?: any) => void;
}
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
interface PluginResult { stop: boolean }

/**
 * The same "has a protocol" gate the chat path uses (openaiController.ts) before attempting
 * a download. A `data:image/…` url never matches — `data:` is not followed by `//` — so this
 * alone is enough to leave an already-inlined image untouched with no separate check.
 */
const REMOTE_URL_RE = /^[a-zA-Z]+:\/\//;

/** `input_image.image_url` is documented as either a plain string or `{url}` (see requestTranslator.ts). */
function extractUrl(part: any): string | undefined {
  return typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
}

/** Write a new url back onto a part, preserving whichever of the two shapes it arrived in. */
function setUrl(part: any, url: string): void {
  if (typeof part.image_url === 'string') part.image_url = url;
  else part.image_url = { ...part.image_url, url };
}

/**
 * A download failure ends the request with a 400 that names the real cause, rather than
 * letting a mangled/unreachable url ride through to the bridge's opaque
 * "Unsupported Responses input item type: input_image". See the file header's ROUTE SCOPE /
 * reuse note for why this deliberately differs from the chat path's log-and-keep-going.
 */
function sendImageDownloadError(res: Response, url: string, error: any): void {
  const detail = error?.message || String(error);
  res.status(400).json({
    error: {
      message: `Failed to download input_image from "${url}": ${detail}`,
      type: 'invalid_request_error',
      code: 'image_download_failed',
    },
  });
}

async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;
  try {
    // Only the orchestration bridge needs this; see ROUTE SCOPE above.
    if ((req as any).__responsesRoute !== 'orchestration') return { stop: false };

    const input = (req.body as any)?.input;
    if (!Array.isArray(input)) return { stop: false };

    for (const item of input) {
      const isMessage = item?.type === 'message' || (item?.type === undefined && item?.role);
      if (!isMessage || !Array.isArray(item.content)) continue;

      for (const part of item.content) {
        if (part?.type !== 'input_image') continue;
        const url = extractUrl(part);
        if (typeof url !== 'string' || !REMOTE_URL_RE.test(url)) continue;

        try {
          const dataUrl = await imageUtils.remoteUrlToDataUrl(url);
          setUrl(part, dataUrl);
          pluginLogger.info(`responsesImagePlugin: inlined a remote input_image (${url}) as a data URL`);
        } catch (error: any) {
          pluginLogger.error(`responsesImagePlugin: failed to download input_image from "${url}": ${error.message}`);
          sendImageDownloadError(res, url, error);
          return { stop: true };
        }
      }
    }

    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesImagePlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

const pluginRules = [
  { id: 'responsesImagePlugin', match: [], strategy: 'before', handler: beforeHandler },
];

export = pluginRules;
