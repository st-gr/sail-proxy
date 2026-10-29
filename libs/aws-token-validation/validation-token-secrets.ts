/**
 * Values known to be public for VALIDATION_TOKEN_SECRET: the built-in default this codebase
 * falls back to when the env var is unset, and the placeholder both services' .env.sample files
 * show for it. Shared by the admin (isGatewayServiceCaller, services/admin/src/utils/gatewayServiceJwt.ts)
 * and the gateway (adminServiceClient's own signing fallback, services/gateway/src/clients/adminServiceClient.ts)
 * so an unedited copy of either sample, or an unset secret, is treated the same way in both.
 */
export const DEFAULT_VALIDATION_TOKEN_SECRET = 'dev-secret-change-in-production';
export const PLACEHOLDER_VALIDATION_TOKEN_SECRET = 'generate-a-secure-64-character-hex-string';

export const REJECTED_VALIDATION_TOKEN_SECRETS: readonly string[] = [
  DEFAULT_VALIDATION_TOKEN_SECRET,
  PLACEHOLDER_VALIDATION_TOKEN_SECRET
];

/**
 * True when VALIDATION_TOKEN_SECRET is unset (every signer then falls back to the default) or
 * one of the publicly known values above: anyone can sign a token with it.
 */
export function isPubliclyKnownValidationTokenSecret(secret: string | undefined): boolean {
  return !secret || REJECTED_VALIDATION_TOKEN_SECRETS.includes(secret);
}
