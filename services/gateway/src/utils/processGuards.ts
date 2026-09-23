/**
 * Process-level safety net for the gateway.
 *
 * An `async` express-4 handler that rejects never reaches `app.use(errorHandler)`;
 * the request hangs and Node raises `unhandledRejection`, which ends the process
 * under Node 20's default `--unhandled-rejections=throw`. Until 2026-09 the only
 * listener was installed lazily by the Bedrock response-cache plugin's request
 * hook, so a fresh gateway had none. This installs one at startup: the reason is
 * logged with its stack and the process stays up — the request in question is
 * already lost, taking every other in-flight request with it is not a remedy.
 */
import type { Logger } from '@libs/logger';

let installed = false;

export function installUnhandledRejectionLogger(logger: Logger): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Gateway', `Unhandled promise rejection: ${error.message}`, error);
  });
}
