// The recall stage's client-input error and the redaction of driver errors before they are logged
// (split out of repository.ts, which re-exports them).

/** Thrown for malformed/oversized client input (e.g. an invalid attribute
 *  filter, or a query embedding of the wrong dimension). Callers should map
 *  this to an HTTP 400 — never a 500. */
export class RecallInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RecallInputError';
  }
}

/**
 * The SQLSTATE a `pg` error carries (`22P02`, `22P05`, …), or the class name when there
 * is none (a socket error, say). Both are fixed tokens chosen by the driver or by Node —
 * never anything the caller supplied — which is what makes them safe to log.
 */
export function driverErrorCode(error: any): string {
  const code = error?.code;
  return typeof code === 'string' && code.length > 0 ? code : (error?.name ?? 'unknown_error');
}

/**
 * A stand-in for a driver error that is safe to hand to `logger.error`'s `error`
 * parameter, which serializes `name`, `message` and `stack`.
 *
 * The message is replaced by the SQLSTATE. The stack keeps only its FRAMES: V8 builds
 * `stack` as `${name}: ${message}\n    at …`, so shipping it verbatim would re-log the
 * message this function exists to withhold.
 */
export function redactDriverError(error: any): Error {
  const redacted = new Error(driverErrorCode(error));
  redacted.name = error?.name ?? 'Error';
  const frames = typeof error?.stack === 'string'
    ? error.stack.split('\n').filter((line: string) => /^\s+at\s/.test(line))
    : [];
  redacted.stack = [`${redacted.name}: ${redacted.message}`, ...frames].join('\n');
  return redacted;
}
