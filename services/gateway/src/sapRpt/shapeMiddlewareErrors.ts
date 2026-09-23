/**
 * `createUnifiedTokenAuth()` and `quotaEnforcement` answer 401/429 in the OpenAI
 * `{error:{message,type}}` envelope everywhere else in the gateway, but the SAP-RPT route must
 * answer in the SAP shape throughout (spec: gateway errors in SAP shape). Mounted FIRST on the
 * router, this patches `res.json` for the request and reshapes any OpenAI-enveloped 401/429 those
 * two middlewares send before it reaches the client. `quotaEnforcement`'s real 429 body carries no
 * `message` (it is `{type,scope,dimension,window,limit,used,resets_at}`), so the reshaped `msg` is
 * composed from whichever of those fields are present, and the original `error` object is kept on
 * `detail[0].quota` so nothing is lost. The controller relays SAP's OWN responses - including SAP's
 * own 401/429 - and marks that with `res.locals.sapRelay`; when that flag is set this middleware
 * calls the original `json` untouched, whatever the status.
 */
import type { NextFunction, Request, Response } from 'express';
import { rptError, RptErrorType } from './errors';

const DEFAULT_MSG: Record<number, string> = { 401: 'Unauthorized', 429: 'Quota exceeded' };

function composeQuotaMessage(error: Record<string, any>): string {
  if (typeof error.message === 'string' && error.message) return error.message;
  let msg = DEFAULT_MSG[429];
  const bits: string[] = [];
  if (error.dimension) bits.push(String(error.dimension));
  if (error.window) bits.push(`per ${error.window}`);
  if (bits.length) msg += `: ${bits.join(' ')}`;
  if (error.used !== undefined && error.limit !== undefined) msg += ` (${error.used}/${error.limit})`;
  if (error.resets_at) msg += `, resets at ${error.resets_at}`;
  return msg;
}

export function shapeMiddlewareErrors(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    const status = res.statusCode;
    if (res.locals.sapRelay) return originalJson(body);
    if ((status === 401 || status === 429) && body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      const type: RptErrorType = status === 401 ? 'gateway_auth' : 'quota_exceeded';
      const msg = status === 429 ? composeQuotaMessage(body.error) : (body.error.message ?? DEFAULT_MSG[status]);
      const shaped = rptError(status, type, msg);
      if (status === 429) (shaped.body.detail[0] as any).quota = body.error;
      return originalJson(shaped.body);
    }
    return originalJson(body);
  };
  next();
}
