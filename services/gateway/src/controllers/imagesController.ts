/**
 * OpenAI Images API (generations, edits) served by Gemini image deployments on SAP AI Core.
 * Spec: docs/superpowers/specs/2026-09-15-image-generation-design.md §2, §4.
 *
 * One Gemini `generateContent` per requested image (Gemini returns one image per call), each
 * metered as its own usage event against the deployment id, like the /google native path.
 */
import { Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';
import { getDefaultLogger } from '@libs/logger';
import modelService from '../services/modelService';
import configService from '../services/configService';
import { geminiUrl } from '../services/googleGeminiService';
import { resolveDeployedTwin } from '../utils/deployedTwin';
import { createUsageMetrics, emitUsageEvent } from '../utils/usageTracker';
import { emitNotEntitled, entitlementFromRequest, isModelEntitled, logEntitlementDecision, respondNotEntitled } from '../utils/modelEntitlement';
import { extractBoundary, MalformedMultipartError, parseMultipartFields } from '../utils/multipart';
import { foldNativeGeminiUsage, geminiFailure } from './googleWire';
import { headersForSap, isGoogleProvider } from './googleController';
import {
  ImageRequestError, ImagesUsage, MAX_IMAGES, MAX_UPLOAD_BYTES, MappedImageRequest, UploadedImage,
  assembleImagesResponse, extractImages, mapImageRequest, openAiUsageFromGemini, sumUsages,
} from './imagesMapping';

const logger = getDefaultLogger();

/** Per text field on `/edits`, well above any real prompt; see `parseMultipartFields` below. */
const MAX_EDIT_TEXT_FIELD_BYTES = 32 * 1024;

function sendError(res: Response, e: ImageRequestError): void {
  res.status(e.status).json({ error: e.error });
}

const MODEL_HINT = 'a Google image model with a deployment on SAP AI Core, for example gemini-3.1-flash-image (or its --deployed id)';

/** Has the shape `geminiFailure` knows how to read (an axios error or an upstream HTTP response). */
function looksUpstream(error: any): boolean {
  return !!error?.response || typeof error?.code === 'string' || error?.isAxiosError === true;
}

/**
 * Safety net for both exported handlers: anything that escapes `serve()` (or the multipart/body
 * parsing ahead of it) without already having answered `res` would otherwise leave the client
 * hanging — Express 4 does not catch a rejected async handler. Never logs the token or the
 * image payload, only the failure message.
 */
async function respondInternalFailure(res: Response, error: any, where: string): Promise<void> {
  if (looksUpstream(error)) {
    const { status, message } = await geminiFailure(error);
    logger.error('imagesController', `${where} failed: ${message}`, undefined, { status });
    if (!res.headersSent) {
      const mapped502 = status === 503 ? 503 : 502;
      sendError(res, { status: mapped502, error: { message: `Could not reach SAP AI Core: ${message}`, type: 'upstream_error', code: 'upstream_error' } });
    }
    return;
  }
  logger.error('imagesController', `${where} failed: ${error?.message || error}`);
  if (!res.headersSent) {
    sendError(res, { status: 500, error: { message: 'Internal error', type: 'server_error' } });
  }
}

/** The deployment an image model id resolves to, or null when it is not a Google deployment. */
async function resolveImageDeployment(model: string): Promise<{ id: string; baseModel: string; deploymentUrl: string } | null> {
  const getDetails = (id: string) => modelService.getModelDetails(id);
  const twin = await resolveDeployedTwin(model, getDetails);
  if (!twin) return null;
  const details = await getDetails(twin.id);
  return isGoogleProvider(details) ? twin : null;
}

async function serve(req: Request, res: Response, mapped: MappedImageRequest): Promise<void> {
  const deployment = await resolveImageDeployment(mapped.model);
  if (!deployment) {
    sendError(res, { status: 404, error: { message: `Model ${mapped.model} is not available for image generation through this gateway; use ${MODEL_HINT}.`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } });
    return;
  }
  // Both ids, as on /google: the bare name the client asked for and the deployment it resolved to.
  const block = entitlementFromRequest(req);
  const refusedId = [mapped.model, deployment.id].find((id) => !isModelEntitled(block, id));
  if (refusedId !== undefined) {
    logEntitlementDecision(req, refusedId, false);
    respondNotEntitled(res, refusedId, block!);
    emitNotEntitled(req, refusedId, block!);
    return;
  }

  const url = geminiUrl(deployment.deploymentUrl, deployment.baseModel, 'generateContent');
  let headers: Record<string, string>;
  try {
    headers = await headersForSap();
  } catch (error: any) {
    // Fetching the SAP AI Core bearer token IS reaching SAP AI Core — distinct from the
    // catalog lookup above, which is this gateway's own model service. No model call was
    // attempted, so no usage event is raised.
    const { message } = await geminiFailure(error);
    logger.error('imagesController', `Could not obtain a SAP AI Core token for ${deployment.id}: ${message}`);
    sendError(res, { status: 502, error: { message: `Could not reach SAP AI Core: ${message}`, type: 'upstream_error', code: 'upstream_error' } });
    return;
  }
  const images: string[] = [];
  const usages: ImagesUsage[] = [];
  // Each upstream call is metered as its own usage event; with n > 1 they get distinct request
  // ids (connection id plus call number) so the admin's per-request views tell them apart.
  const baseRequestId = (req as any).debugRequestId as string | undefined;
  for (let i = 0; i < mapped.n; i++) {
    if (mapped.n > 1 && baseRequestId) (req as any).debugRequestId = `${baseRequestId}-${i + 1}`;
    const usage = createUsageMetrics();
    let upstream: AxiosResponse;
    try {
      upstream = await axios.post(url, mapped.geminiBody, { headers, timeout: configService.getTimeout(false) });
    } catch (error: any) {
      const { status, message } = await geminiFailure(error);
      logger.error('imagesController', `Image generation failed for ${deployment.id} (${i + 1}/${mapped.n}): ${message}`, undefined, { status });
      const mapped502 = status === 503 ? 503 : 502;
      emitUsageEvent(req, usage, deployment.id, mapped502);
      sendError(res, { status: mapped502, error: { message: `SAP AI Core refused the image request (HTTP ${status}): ${message}`, type: 'upstream_error', code: 'upstream_error', ...( { upstream_status: status } as any) } });
      return;
    }
    foldNativeGeminiUsage(usage, upstream.data?.usageMetadata);
    const produced = extractImages(upstream.data);
    if (produced.length === 0) {
      // The tokens are still recorded, but against the status the client actually receives
      // (502), matching the failed-call path above — not the 200 the upstream call itself got.
      const reason = upstream.data?.candidates?.[0]?.finishReason || 'no image part';
      emitUsageEvent(req, usage, deployment.id, 502);
      sendError(res, { status: 502, error: { message: `The model returned no image (finish reason ${reason})`, type: 'upstream_error', code: 'no_image' } });
      return;
    }
    emitUsageEvent(req, usage, deployment.id, upstream.status);
    images.push(produced[0]);
    usages.push(openAiUsageFromGemini(upstream.data?.usageMetadata));
  }
  res.status(200).json(assembleImagesResponse(images, sumUsages(usages), mapped.size));
}

export const generateImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const mapped = mapImageRequest({ body: req.body || {} });
    if (!mapped.ok) { sendError(res, mapped.error); return; }
    await serve(req, res, mapped.value);
  } catch (error: any) {
    await respondInternalFailure(res, error, 'generateImage');
  }
};

export const editImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const boundary = extractBoundary(req.headers['content-type']);
    if (!boundary) {
      sendError(res, { status: 400, error: { message: 'Content-Type must be multipart/form-data with a boundary.', type: 'invalid_request_error', code: 'invalid_content_type' } });
      return;
    }
    const parsed = await parseMultipartFields(req, boundary, {
      // At most MAX_IMAGES input images (mirroring `n`) plus slack for the text fields, and no
      // single upload over the per-file cap — both enforced while the body streams in, so an
      // over-sized upload is refused instead of being buffered whole first.
      maxBytes: MAX_UPLOAD_BYTES * MAX_IMAGES + 64 * 1024,
      maxFileBytes: MAX_UPLOAD_BYTES,
      // `prompt` is the primary input of an edit: the default per-field budget (1 KB) would
      // quietly shorten an ordinary instruction, so this endpoint allows 32 KB and refuses
      // anything longer rather than serving a truncated prompt.
      maxTextFieldBytes: MAX_EDIT_TEXT_FIELD_BYTES,
      fileFields: ['image', 'mask'],
      textFields: ['model', 'prompt', 'n', 'size', 'quality', 'response_format', 'output_format', 'background', 'moderation', 'style', 'input_fidelity', 'partial_images', 'stream', 'user', 'output_compression'],
    });
    if (parsed.error) {
      if (parsed.error instanceof MalformedMultipartError) {
        sendError(res, { status: 400, error: { message: 'The request body is not valid multipart/form-data.', type: 'invalid_request_error', code: 'invalid_multipart_body' } });
        return;
      }
      sendError(res, { status: 500, error: { message: 'Failed to read the upload.', type: 'server_error' } });
      return;
    }
    if (parsed.tooLarge) {
      // `tooLargeField` set means one part blew the per-file cap; unset means the whole body did.
      const message = parsed.tooLargeField
        ? `Uploads must be at most ${MAX_UPLOAD_BYTES} bytes each.`
        : `The upload is too large: at most ${MAX_IMAGES} images of ${MAX_UPLOAD_BYTES} bytes each.`;
      sendError(res, { status: 400, error: { message, type: 'invalid_request_error', param: parsed.tooLargeField || 'image', code: 'file_too_large' } });
      return;
    }
    if (parsed.truncated.length > 0) {
      sendError(res, { status: 400, error: { message: `${parsed.truncated[0]} is too long; text fields are limited to ${MAX_EDIT_TEXT_FIELD_BYTES / 1024} KB each.`, type: 'invalid_request_error', param: parsed.truncated[0], code: 'field_too_large' } });
      return;
    }
    const images: UploadedImage[] = parsed.files.filter((f) => f.field === 'image').map((f) => ({ contentType: f.contentType, bytes: f.bytes }));
    if (images.length > MAX_IMAGES) {
      sendError(res, { status: 400, error: { message: `At most ${MAX_IMAGES} image parts are accepted per request`, type: 'invalid_request_error', param: 'image', code: 'invalid_value' } });
      return;
    }
    // Belt and braces behind the streaming per-file cap above: a future caller that omits
    // `maxFileBytes` must still not reach a deployment with an over-sized upload.
    if (images.some((img) => img.bytes.length > MAX_UPLOAD_BYTES)) {
      sendError(res, { status: 400, error: { message: `Uploads must be at most ${MAX_UPLOAD_BYTES} bytes each.`, type: 'invalid_request_error', param: 'image', code: 'file_too_large' } });
      return;
    }
    const hasMask = parsed.files.some((f) => f.field === 'mask');
    // Multipart text fields arrive as strings; the numeric ones are coerced the way the JSON body carries them.
    const body: Record<string, any> = { ...parsed.fields };
    // An empty field is what an SDK sends for a parameter it did not set (`-F stream=` and the
    // `FormData` an unset option produces), so it means "absent", not "the empty string" —
    // otherwise `Number('')` would be 0 and `'' === 'true'` a silent false.
    for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
    for (const k of ['n', 'partial_images', 'output_compression']) if (body[k] !== undefined) body[k] = Number(body[k]);
    if (body.stream !== undefined) {
      // Only the two booleans the wire form can carry; anything else is a client mistake, not
      // an implicit `false` that would let `stream=1` through as "not streaming".
      if (body.stream !== 'true' && body.stream !== 'false') {
        sendError(res, { status: 400, error: { message: 'stream must be true or false', type: 'invalid_request_error', param: 'stream', code: 'invalid_value' } });
        return;
      }
      body.stream = body.stream === 'true';
    }
    const mapped = mapImageRequest({ body, images, hasMask });
    if (!mapped.ok) { sendError(res, mapped.error); return; }
    await serve(req, res, mapped.value);
  } catch (error: any) {
    await respondInternalFailure(res, error, 'editImage');
  }
};
