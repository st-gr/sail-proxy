/**
 * authMiddleware's Docker "AUTH DEBUG" trace log builds `allAuthHeaders`
 * directly from raw request headers, including the raw Authorization
 * bearer value and the oauth2-proxy access token, then logs it under the
 * `allAuthHeaders` key. Because that key isn't literally `headers`, the
 * shared logger's own redaction (libs/logger, see C8) never saw it, so the
 * raw credential values reached the trace log verbatim.
 *
 * @see ../../src/middleware/authMiddleware.ts
 */
import { getDefaultLogger } from '@libs/logger';
import { AuthMiddleware } from '../../src/middleware/authMiddleware';

const FAKE_BEARER_TOKEN = 'FAKE-BEARER-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_ACCESS_TOKEN = 'FAKE-ACCESS-TOKEN-9876543210zyxwvutsrqponmlkjihgfedcba';

describe('AuthMiddleware docker trace log redacts credential headers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not log the raw Authorization or access-token value at trace level', async () => {
    const logger = getDefaultLogger();
    const traceCalls: Array<{ component: string; message: string; metadata?: any }> = [];
    jest.spyOn(logger, 'trace').mockImplementation(((component: string, message: string, metadata?: any) => {
      traceCalls.push({ component, message, metadata });
    }) as any);

    const middleware = new AuthMiddleware({ deployTarget: 'docker', roleMapping: {} });

    // x-auth-request-email takes the fast oauth2-proxy path (no network
    // calls), while authorization / x-auth-request-access-token are still
    // present so allAuthHeaders (built unconditionally) carries them.
    const req: any = {
      path: '/api/admin/config',
      url: '/api/admin/config',
      method: 'GET',
      headers: {
        authorization: `Bearer ${FAKE_BEARER_TOKEN}`,
        'x-auth-request-access-token': FAKE_ACCESS_TOKEN,
        'x-auth-request-email': 'someone@example.test',
        'user-agent': 'jest-test'
      }
    };
    const res: any = { status: () => ({ json: () => undefined }) };
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(next).toHaveBeenCalled();

    const serialized = JSON.stringify(traceCalls);
    expect(serialized).not.toContain(FAKE_BEARER_TOKEN);
    expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);

    const dockerDebugCall = traceCalls.find(c => c.message.includes('DOCKER AUTH DEBUG'));
    expect(dockerDebugCall).toBeDefined();
    // The redaction still leaves a usable preview behind (scheme + hash),
    // not just a wholesale drop of the field.
    expect(dockerDebugCall!.metadata.allAuthHeaders).toContain('[redacted:');
  });
});
