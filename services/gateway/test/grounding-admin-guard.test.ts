import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// The real registry, unless a test takes grounding:admin away from the admin service key.
const registry = { withoutAdmin: false };
jest.mock('@libs/service-auth', () => {
  const actual = jest.requireActual('@libs/service-auth') as any;
  return {
    __esModule: true,
    ...actual,
    get SERVICE_KEYS() {
      if (!registry.withoutAdmin) return actual.SERVICE_KEYS;
      const key = actual.SERVICE_KEYS.ADMIN_TO_GATEWAY;
      return {
        ...actual.SERVICE_KEYS,
        ADMIN_TO_GATEWAY: { ...key, PERMISSIONS: key.PERMISSIONS.filter((p: string) => p !== 'grounding:admin') },
      };
    },
  };
});

import { SERVICE_KEYS } from '@libs/service-auth';
import { groundingAdmin } from '../src/middlewares/groundingAdmin';

function makeRes(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

const serviceAuth = { authType: 'service-key', isStandalone: false, permissions: [], serviceKey: { email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL } };

function run(overrides: Record<string, any>): { res: any; next: jest.Mock } {
  const req: any = { headers: {}, serviceAuth, groundingActor: { email: 'admin@test.com', role: 'admin' }, ...overrides };
  const res = makeRes();
  const next = jest.fn();
  groundingAdmin(req, res, next);
  return { res, next };
}

function expectRefused({ res, next }: { res: any; next: jest.Mock }): void {
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(403);
  expect(res.body).toEqual({
    error: { message: 'This operation requires a grounding administrator.', type: 'permission_error', code: 'grounding_admin_required' },
  });
}

beforeEach(() => { registry.withoutAdmin = false; });

describe('groundingAdmin', () => {
  it('lets the admin service key through when the acting role is admin', () => {
    const { res, next } = run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('403s the acting role user', () => {
    expectRefused(run({ groundingActor: { email: 'user@test.com', role: 'user' } }));
  });

  it('403s an admin role when the registry does not grant grounding:admin to the key', () => {
    registry.withoutAdmin = true;
    expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).not.toContain('grounding:admin');
    expectRefused(run({}));
  });

  it.each([
    ['no acting user', { groundingActor: undefined }],
    ['no service auth context', { serviceAuth: undefined }],
    ['standalone mode', { serviceAuth: { authType: 'standalone', isStandalone: true, permissions: ['*'] } }],
    ['a service key of another identity', { serviceAuth: { ...serviceAuth, serviceKey: { email: 'user@test.com' } } }],
    ['a role spelled differently', { groundingActor: { email: 'admin@test.com', role: 'Admin' } }],
  ])('403s %s', (_name, overrides) => {
    expectRefused(run(overrides));
  });
});
