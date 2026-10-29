/**
 * The gateway's service JWT (adminServiceClient.createAuthToken): HS256 under the shared
 * VALIDATION_TOKEN_SECRET, issuer `gateway-service`. The docker auth middleware verifies it for
 * every request that carries it; the validation service checks it again before it hands out AWS
 * signing keys, whatever the deploy target and whatever else authenticated the request.
 */
import jwt from 'jsonwebtoken';
import { getDefaultLogger } from '@libs/logger';
// Re-exported for existing callers (this module used to define these itself); the gateway
// imports the same values from the shared lib (services/gateway/src/clients/adminServiceClient.ts),
// so admin and gateway stay in sync.
import {
  DEFAULT_VALIDATION_TOKEN_SECRET,
  PLACEHOLDER_VALIDATION_TOKEN_SECRET,
  REJECTED_VALIDATION_TOKEN_SECRETS,
  isPubliclyKnownValidationTokenSecret
} from '@libs/aws-token-validation/validation-token-secrets';
export { DEFAULT_VALIDATION_TOKEN_SECRET, PLACEHOLDER_VALIDATION_TOKEN_SECRET, REJECTED_VALIDATION_TOKEN_SECRETS };

const logger = getDefaultLogger();

/**
 * The secret tokens signed with VALIDATION_TOKEN_SECRET are verified against. Outside
 * NODE_ENV=development an unset or publicly known secret throws instead: anyone who knows the
 * default or the .env.sample placeholder could sign a token that verifies under it.
 */
export function verificationValidationTokenSecret(): string {
  const secret = process.env.VALIDATION_TOKEN_SECRET;
  if (process.env.NODE_ENV !== 'development' && isPubliclyKnownValidationTokenSecret(secret)) {
    throw new Error('VALIDATION_TOKEN_SECRET is unset, the default, or the .env.sample placeholder: tokens signed with it are refused outside development');
  }
  return secret || DEFAULT_VALIDATION_TOKEN_SECRET;
}

/**
 * Verify a gateway service JWT; throws when the signature, algorithm, issuer or expiry is wrong,
 * or when the configured secret is publicly known outside development.
 */
export function verifyGatewayServiceJwt(token: string): jwt.JwtPayload {
  const secret = verificationValidationTokenSecret();
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'gateway-service'
  }) as jwt.JwtPayload;
}

let weakSecretLogged = false;

/**
 * True only when the request carries a valid gateway service JWT as its Bearer token. Outside
 * NODE_ENV=development an unset or publicly known VALIDATION_TOKEN_SECRET never qualifies:
 * anyone who knows the default or the .env.sample placeholder could mint the token.
 */
export function isGatewayServiceCaller(authorization: unknown): boolean {
  if (process.env.NODE_ENV !== 'development' && isPubliclyKnownValidationTokenSecret(process.env.VALIDATION_TOKEN_SECRET)) {
    if (!weakSecretLogged) {
      weakSecretLogged = true;
      logger.error('gateway-service-jwt', 'VALIDATION_TOKEN_SECRET is unset, the default, or the .env.sample placeholder: AWS signing keys are refused until the admin and gateway share a generated secret');
    }
    return false;
  }
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return false;
  }
  try {
    verifyGatewayServiceJwt(authorization.substring(7));
    return true;
  } catch {
    return false;
  }
}
