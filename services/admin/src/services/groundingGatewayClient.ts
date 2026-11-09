/**
 * Admin → gateway calls for the cockpit's Grounding screens (spec 2026-10-01 §4.1, §4.2).
 * The admin service authenticates the cockpit user; the gateway owns every file_search rule.
 * Each call carries the platform service key and names the acting user in two headers the
 * gateway honours for that key only.
 */
import axios from 'axios';
import type { Readable } from 'stream';
import { getDefaultLogger } from '@libs/logger';
import { modelCostService } from './modelCostService';

const logger = getDefaultLogger();

export interface GroundingActor {
  email: string;
  role: 'user' | 'admin';
  /** The user's teams and the teams they administer (store visibility and sharing, spec 2026-10-14 §8). */
  teamIds?: string[];
  adminTeamIds?: string[];
}

export interface GatewayReply {
  status: number;
  headers: Record<string, any>;
  data: any;
}

export const GROUNDING_GATEWAY_PATH = '/api/admin/grounding';

const gatewayUrl = () => process.env.GATEWAY_URL || 'http://localhost:3000';

export async function gatewayHeaders(actor: GroundingActor): Promise<Record<string, string>> {
  const key = await modelCostService.getGatewayServiceKey();
  return {
    Accept: 'application/json',
    'X-API-Key': key,
    'X-Grounding-Acting-Email': actor.email,
    'X-Grounding-Acting-Role': actor.role,
    ...(actor.teamIds ? { 'X-Grounding-Acting-Teams': actor.teamIds.join(',') } : {}),
    ...(actor.adminTeamIds ? { 'X-Grounding-Acting-Admin-Teams': actor.adminTeamIds.join(',') } : {}),
    'User-Agent': 'admin-service/grounding'
  };
}

export function gatewayTarget(subPath: string, query?: URLSearchParams): string {
  const queryString = query ? query.toString() : '';
  return `${gatewayUrl()}${GROUNDING_GATEWAY_PATH}${subPath}${queryString ? `?${queryString}` : ''}`;
}

export function unreachable(error: any): GatewayReply {
  logger.error('GroundingGatewayClient', `gateway unreachable: ${error?.message}`);
  return { status: 502, headers: {}, data: { error: 'gateway_unreachable', message: 'The gateway could not be reached.' } };
}

/** One JSON call. Never throws: the gateway's status and body are the answer, whatever they are. */
export async function callGateway(
  actor: GroundingActor,
  method: 'get' | 'post' | 'delete',
  subPath: string,
  opts: { query?: URLSearchParams; body?: unknown } = {}
): Promise<GatewayReply> {
  try {
    const headers = await gatewayHeaders(actor);
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await axios.request({
      method,
      url: gatewayTarget(subPath, opts.query),
      data: opts.body,
      headers,
      timeout: 60000,
      validateStatus: () => true
    });
    return { status: response.status, headers: response.headers as Record<string, any>, data: response.data };
  } catch (error) {
    return unreachable(error);
  }
}

const STATUS_CACHE_MS = 60000;
let limitCache: { url: string; at: number; maxFileBytes: number | null } | undefined;

/**
 * The gateway's per-file size limit from GET /status, cached for 60 s per process (per gateway URL).
 * Null when it is unknown (status call failed or carried no limit): callers then do not block.
 */
export async function getMaxFileBytes(actor: GroundingActor): Promise<number | null> {
  const url = gatewayUrl();
  if (limitCache && limitCache.url === url && Date.now() - limitCache.at < STATUS_CACHE_MS) return limitCache.maxFileBytes;
  const reply = await callGateway(actor, 'get', '/status');
  const value = reply.status === 200 ? Number(reply.data?.limits?.maxFileBytes) : NaN;
  const maxFileBytes = Number.isFinite(value) && value > 0 ? value : null;
  if (maxFileBytes !== null) limitCache = { url, at: Date.now(), maxFileBytes };
  return maxFileBytes;
}

/** Test-only: forget the cached limit. */
export function __resetGroundingLimitCacheForTests(): void {
  limitCache = undefined;
}

export interface UploadHeaders {
  contentType: string;
  contentLength?: string;
}

/**
 * Pipes an upload to the gateway. `maxRedirects: 0` matters: with redirects enabled axios buffers
 * the whole request body so it could replay it, and a 32 MiB file would sit in memory per upload.
 * Never throws. The gateway closes the connection when it refuses a file that is too large, which
 * can surface here as a reset instead of its 413; that case is reported as upload_interrupted.
 */
export async function streamToGateway(actor: GroundingActor, subPath: string, source: Readable, upload: UploadHeaders): Promise<GatewayReply> {
  try {
    const headers = await gatewayHeaders(actor);
    headers['Content-Type'] = upload.contentType;
    if (upload.contentLength) headers['Content-Length'] = upload.contentLength;
    const response = await axios.request({
      method: 'post',
      url: gatewayTarget(subPath),
      data: source,
      headers,
      maxRedirects: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
      validateStatus: () => true
    });
    return { status: response.status, headers: response.headers as Record<string, any>, data: response.data };
  } catch (error: any) {
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') return unreachable(error);
    logger.error('GroundingGatewayClient', `upload interrupted: ${error?.message}`);
    return {
      status: 502,
      headers: {},
      data: { error: 'upload_interrupted', message: 'The upload was interrupted. The file may exceed the allowed size.' }
    };
  }
}

/** Opens a download. Throws when the gateway cannot be reached; the caller answers 502. */
export async function streamFromGateway(actor: GroundingActor, subPath: string): Promise<{ status: number; headers: Record<string, any>; stream: Readable }> {
  const response = await axios.request({
    method: 'get',
    url: gatewayTarget(subPath),
    headers: await gatewayHeaders(actor),
    responseType: 'stream',
    timeout: 120000,
    validateStatus: () => true
  });
  return { status: response.status, headers: response.headers as Record<string, any>, stream: response.data as Readable };
}
