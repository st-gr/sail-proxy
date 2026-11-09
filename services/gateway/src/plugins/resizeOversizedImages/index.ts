/**
 * Resize Oversized Images Plugin
 *
 * Resizes images that exceed the max allowed dimension for multi-image requests
 * before forwarding to SAP AI Core / AWS Bedrock.
 *
 * Background:
 * SAP AI Core enforces a per-model max long-edge dimension on images when multiple
 * images are present in a single request. Claude Code CLI sends screenshots as
 * base64-encoded images, and in long conversations these can exceed the limit,
 * resulting in: "At least one of the image dimensions exceed max allowed size for
 * many-image requests: N pixels"
 *
 * Single-image requests have a much higher limit (~8MP) and are not affected.
 *
 * Two-phase design for performance:
 * - Phase 1: Fast pre-scan — counts images, collects refs without decoding
 * - Phase 2: Resize — only runs if multiple images found; decodes, checks dimensions,
 *   resizes oversized images maintaining aspect ratio
 *
 * Applied to: Claude 4.6 Opus (via api_config.json hooks, matched on header:x-app=cli)
 * Strategy: before (modifies request before sending upstream)
 *
 * @see api_config.json - Hook configuration
 */

import { Request, Response } from 'express';
import sharp from 'sharp';

interface PluginContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
}

interface PluginUtils {
  logger: Logger;
}

interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

interface ImageRef {
  messageIndex: number;
  contentIndex: number;
  nestedContentIndex?: number; // for images inside tool_result content arrays
  mediaType: string;
}

interface ScanResult {
  needsResize: boolean;
  imageRefs: ImageRef[];
}

/**
 * Max long-edge dimension per model for multi-image requests.
 * These are SAP AI Core / Bedrock hard limits.
 */
const MODEL_MAX_DIMENSIONS: Record<string, number> = {
  'claude-opus-4-6': 1568,
  'claude-opus-4-7': 2576,
};
const DEFAULT_MAX_DIMENSION = 1568;

/**
 * Map Anthropic media_type to sharp output format
 */
function getSharpOutputFormat(mediaType: string): 'png' | 'jpeg' | 'gif' | 'webp' {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpeg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'jpeg';
  }
}

/**
 * Check if a content block is a base64 image
 */
function isBase64Image(block: any): boolean {
  return (
    block.type === 'image' &&
    block.source &&
    block.source.type === 'base64' &&
    block.source.data
  );
}

/**
 * Phase 1: Fast pre-scan — counts image blocks and collects references.
 * Checks both top-level content blocks and images nested inside tool_result blocks.
 * No image decoding happens here.
 */
function scanForOversizedImages(messages: any[]): ScanResult {
  const imageRefs: ImageRef[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];

      // Direct image block: messages[i].content[j]
      if (isBase64Image(block)) {
        imageRefs.push({
          messageIndex: i,
          contentIndex: j,
          mediaType: block.source.media_type || 'image/jpeg',
        });
      }

      // Images nested inside tool_result: messages[i].content[j].content[k]
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let k = 0; k < block.content.length; k++) {
          const nested = block.content[k];
          if (isBase64Image(nested)) {
            imageRefs.push({
              messageIndex: i,
              contentIndex: j,
              nestedContentIndex: k,
              mediaType: nested.source.media_type || 'image/jpeg',
            });
          }
        }
      }
    }
  }

  return {
    needsResize: imageRefs.length > 1,
    imageRefs,
  };
}

/**
 * Phase 2: Resize oversized images.
 * Processes sequentially to avoid memory spikes.
 */
async function resizeImages(
  messages: any[],
  imageRefs: ImageRef[],
  maxDimension: number,
  logger: Logger,
): Promise<number> {
  let resizedCount = 0;

  for (const ref of imageRefs) {
    const topBlock = messages[ref.messageIndex].content[ref.contentIndex];
    const block = ref.nestedContentIndex !== undefined
      ? topBlock.content[ref.nestedContentIndex]
      : topBlock;
    const base64Data = block.source.data;
    const refPath = ref.nestedContentIndex !== undefined
      ? `messages[${ref.messageIndex}].content[${ref.contentIndex}].content[${ref.nestedContentIndex}]`
      : `messages[${ref.messageIndex}].content[${ref.contentIndex}]`;

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const metadata = await sharp(buffer).metadata();

      const width = metadata.width || 0;
      const height = metadata.height || 0;

      if (width <= maxDimension && height <= maxDimension) {
        continue;
      }

      logger.info(
        `Resizing image at ${refPath}: ` +
        `${width}x${height} exceeds ${maxDimension}px limit`
      );

      const format = getSharpOutputFormat(ref.mediaType);
      const resizedBuffer = await sharp(buffer)
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(format)
        .toBuffer();

      block.source.data = resizedBuffer.toString('base64');
      resizedCount++;

      const newMeta = await sharp(resizedBuffer).metadata();
      logger.info(
        `Resized to ${newMeta.width}x${newMeta.height} (${format}), ` +
        `size: ${Math.round(base64Data.length / 1024)}KB → ${Math.round(block.source.data.length / 1024)}KB`
      );
    } catch (imageError: any) {
      logger.warn(
        `Failed to process image at ${refPath}: ` +
        `${imageError.message} — skipping`
      );
    }
  }

  return resizedCount;
}

async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const logger = utils.logger;

  try {
    if (!req.body || !Array.isArray((req.body as any).messages)) {
      logger.debug('No messages array found in request body');
      return { stop: false };
    }

    const messages = (req.body as any).messages;
    const model = (req.body as any).model || '';
    const maxDimension = MODEL_MAX_DIMENSIONS[model] || DEFAULT_MAX_DIMENSION;

    // Phase 1: Fast scan
    const scanResult = scanForOversizedImages(messages);

    if (!scanResult.needsResize) {
      if (scanResult.imageRefs.length === 0) {
        logger.debug('No images found in request');
      } else {
        logger.debug('Single image in request — skipping (higher single-image limit applies)');
      }
      return { stop: false };
    }

    logger.info(
      `Multi-image request detected: ${scanResult.imageRefs.length} images, ` +
      `model=${model}, maxDimension=${maxDimension}px`
    );

    // Phase 2: Resize
    const resizedCount = await resizeImages(messages, scanResult.imageRefs, maxDimension, logger);

    if (resizedCount > 0) {
      logger.info(
        `Resized ${resizedCount} of ${scanResult.imageRefs.length} image(s) ` +
        `to fit ${maxDimension}px limit`
      );
    } else {
      logger.debug(
        `All ${scanResult.imageRefs.length} images within ${maxDimension}px limit`
      );
    }

    return { stop: false };
  } catch (error: any) {
    logger.error(`Error in resizeOversizedImages plugin: ${error.message}`, {
      stack: error.stack,
    });
    return { stop: false };
  }
}

const pluginRules = [
  {
    id: "resizeOversizedImages",
    match: [],
    strategy: "before",
    handler: beforeHandler,
  },
];

export = pluginRules;
