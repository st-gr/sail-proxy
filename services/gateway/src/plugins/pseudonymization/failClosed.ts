/**
 * Refusal for a request whose forced pseudonymization could not be applied.
 *
 * When the configuration forces masking for the route (hooks.defaults.<endpoint>) or for the
 * model (models.overrides.<model>), a request the plugin could not mask must not reach the
 * upstream unmasked. The plugin (and the plugin executor, should an error escape the plugin)
 * answers 503 here and returns `{ stop: true }`; every controller treats a stop as "response
 * already sent" and returns before the upstream call.
 *
 * The refusal is in the gateway's error format on every route, like the other gateway-level
 * refusals (authentication, entitlement, quota, `pseudonymization_hook_missing`).
 */
import { Response } from 'express';

export const PSEUDONYMIZATION_FAILED_CODE = 'pseudonymization_failed';

/** The callback id the pseudonymization plugin is registered under in the hook chains. */
export const PSEUDONYMIZATION_RULE_ID = 'pseudonymizationPlugin';

/** Set on the request by the plugin while masking is forced for it; read by the executor. */
export const FORCED_FLAG = '__pseudonymizationForced';

/** Set by the controller's forced check (forcedRun.checkForcedPseudonymization) on a forced
 *  request; the executor refuses it if the pseudonymization plugin never ran in the before-chain. */
export const MUST_RUN_FLAG = '__pseudonymizationMustRun';

/** Set on an embedding request (forcedRun.exemptFromPseudonymization): embeddings are never
 *  pseudonymized, so the executor's forced backstop does not apply to it. */
export const EXEMPT_FLAG = '__pseudonymizationExempt';

const MESSAGE = 'Pseudonymization is enforced for this request but could not be applied, so the request was '
  + 'not sent. Try again; if the problem persists, contact your administrator.';

export function pseudonymizationFailedBody(): { error: { message: string; type: string; code: string } } {
  return { error: { message: MESSAGE, type: 'api_error', code: PSEUDONYMIZATION_FAILED_CODE } };
}

/** Answer 503 `pseudonymization_failed`, or end the response when its headers already went out. */
export function refuseUnmasked(res: Response | undefined): void {
  if (!res) return;
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(503).json(pseudonymizationFailedBody());
}

/**
 * An error described without its message: a detector's message can quote the request (a regex
 * error quotes the caller's pattern, a parse error the text), so only the error's name and its
 * stack frames are logged.
 */
export function describeErrorWithoutContent(error: unknown): string {
  const name = String((error as any)?.name || typeof error);
  let stack = typeof (error as any)?.stack === 'string' ? (error as any).stack as string : '';
  // The stack opens with "<name>: <message>", and the message can span lines that look like
  // frames ("\n    at <request text>"): cut it off before reading the frames.
  const message = typeof (error as any)?.message === 'string' ? (error as any).message as string : '';
  if (message) {
    const at = stack.indexOf(message);
    if (at !== -1) stack = stack.slice(at + message.length);
  }
  const frames = stack.split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 8).join('\n');
  return frames ? `${name}\n${frames}` : name;
}
