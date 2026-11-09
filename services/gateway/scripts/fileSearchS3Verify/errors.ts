/**
 * Errors the verification script raises itself. Their messages are written by the script, name no
 * bucket or credential, and are printed as they are (after the output scrub): unlike a library
 * error, which is reduced to a code before printing.
 */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}
