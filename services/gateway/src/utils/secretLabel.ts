/**
 * Turn a secret (API key, AWS access key ID, bearer token, etc.) into a short,
 * stable, non-reversible label suitable for log lines.
 *
 * A prefix or suffix of a key is STILL key material — truncating a secret to
 * "first 3 / last 3 characters" or "first 10 characters" does not make it
 * safe to log. Several sites in this codebase logged exactly that, believing
 * a partial key was safe to print; it is not. The only thing that is safe to
 * log is a one-way hash of the secret, which is what this helper produces.
 *
 * The label is stable for a given input (same secret -> same label), so log
 * lines remain correlatable ("which credential hit this rate limit / failed
 * this auth check") without ever exposing the secret itself, in full or in
 * part.
 */
import { createHash } from 'crypto';

const LABEL_HASH_LENGTH = 8;

/**
 * Return a short SHA-256-derived label for `secret`. Never returns any
 * substring of the input.
 */
export const secretLabel = (secret: string): string => {
  return createHash('sha256').update(secret).digest('hex').slice(0, LABEL_HASH_LENGTH);
};
