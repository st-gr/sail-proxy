/**
 * The shape an acting user's e-mail must have (groundingActingUser.ts). Dependency-free, so the
 * admin's parity test can import it without loading gateway runtime modules.
 */

// One address: no whitespace, no control characters, exactly one "@" with something on each side.
// eslint-disable-next-line no-control-regex
export const ACTING_EMAIL_PATTERN = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/;
