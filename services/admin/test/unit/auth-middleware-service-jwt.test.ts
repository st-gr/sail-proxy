/**
 * In-cluster integrations call the admin service directly (not through nginx) with the gateway's service JWT:
 * HS256 under the shared VALIDATION_TOKEN_SECRET, issuer `gateway-service`. The Open WebUI per-user-key pipe does
 * exactly that to look up and create API keys. These tests pin the docker auth middleware's side of that
 * contract: the pipe's token becomes an admin, and a token that is not signed with the shared secret, is expired,
 * or is unsigned is refused.
 *
 * @see ../../src/middleware/authMiddleware.ts
 * @see ../../src/utils/gatewayServiceJwt.ts
 */
import jwt from 'jsonwebtoken';
import { AuthMiddleware } from '../../src/middleware/authMiddleware';

const SECRET = 'test-only-generated-validation-secret-3f9a1c7e5b2d4a60';

/** The token the Open WebUI pipe builds (_create_admin_jwt), with its exact claims. */
function pipeToken(secret = SECRET, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'gateway-service', sub: 'admin@test.com', aud: 'admin-service', iat: now, exp: now + 300,
    email: 'admin@test.com', scope: ['admin', 'user', 'gateway'], roles: ['admin', 'user', 'gateway'],
    service: 'gateway', requestId: 'req-1', ...overrides
  }, secret, { algorithm: 'HS256', noTimestamp: true });
}

function call(authorization?: string) {
  const req: any = { path: '/odata/v4/admin/createApiKey', url: '/odata/v4/admin/createApiKey', method: 'POST',
    headers: authorization ? { authorization } : {} };
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe('docker auth middleware: the gateway service JWT of in-cluster callers', () => {
  const env = { ...process.env };
  let middleware: AuthMiddleware;

  beforeEach(() => {
    Object.assign(process.env, { DEPLOY_TARGET: 'docker', VALIDATION_TOKEN_SECRET: SECRET, NODE_ENV: 'test' });
    delete process.env.ROLE_MAPPING;
    middleware = AuthMiddleware.create();
    // A token that is not a valid service JWT falls back to the Dex check; keep that offline and failing.
    jest.spyOn(AuthMiddleware.prototype as any, 'verifyDexJwt').mockRejectedValue(new Error('not a Dex token'));
  });
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

  it('the pipe\'s token is an admin (it creates keys for other users)', async () => {
    const { req, res, next } = call(`Bearer ${pipeToken()}`);
    await middleware.authenticate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.email).toBe('admin@test.com');
    expect(req.user.roles).toEqual(expect.arrayContaining(['admin', 'user', 'service']));
  });

  it.each([
    ['signed with another secret', () => pipeToken('some-other-secret-that-is-long-enough-123')],
    ['expired', () => pipeToken(SECRET, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['from another issuer', () => pipeToken(SECRET, { iss: 'somebody-else', service: 'gateway' })],
    ['unsigned (alg none)', () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'gateway-service', email: 'admin@test.com', scope: ['admin'], service: 'gateway', exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    }]
  ])('a token %s is refused with 401', async (_name, token) => {
    const { req, res, next } = call(`Bearer ${token()}`);
    await middleware.authenticate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it('a request without any credential is refused with 401', async () => {
    const { req, res, next } = call();
    await middleware.authenticate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
