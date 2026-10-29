import { describe, it, expect, jest } from '@jest/globals';
import { SERVICE_KEYS } from '@libs/service-auth';
import { groundingActingUser, ACTING_EMAIL_HEADER, ACTING_ROLE_HEADER } from '../src/middlewares/groundingActingUser';

function makeRes(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

const serviceAuth = { authType: 'service-key', isStandalone: false, permissions: [], serviceKey: { email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL } };

function makeReq(overrides: Record<string, any> = {}): any {
  return {
    headers: { [ACTING_EMAIL_HEADER]: 'user@test.com', [ACTING_ROLE_HEADER]: 'user' },
    serviceAuth,
    ...overrides
  };
}

describe('groundingActingUser', () => {
  it('turns the two headers of the admin service key into the owner identity', () => {
    const req = makeReq({ apiKey: { email: 'someone-else@test.com' } });
    const res = makeRes();
    const next = jest.fn();
    groundingActingUser(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.groundingActor).toEqual({ email: 'user@test.com', role: 'user', teamIds: [], adminTeamIds: [] });
    expect(req.apiKeyInfo).toEqual({ active: true, email: 'user@test.com', authSource: 'grounding' });
    expect(req.apiKey).toBeUndefined();
  });

  it('keeps the e-mail exactly as sent: it must equal the e-mail on the user\'s API keys', () => {
    const req = makeReq({ headers: { [ACTING_EMAIL_HEADER]: '  Mixed.Case@Test.com ', [ACTING_ROLE_HEADER]: 'admin' } });
    groundingActingUser(req, makeRes(), jest.fn());
    expect(req.groundingActor).toEqual({ email: 'Mixed.Case@Test.com', role: 'admin', teamIds: [], adminTeamIds: [] });
  });

  it.each([
    ['no service auth context', { serviceAuth: undefined }],
    ['standalone mode', { serviceAuth: { authType: 'standalone', isStandalone: true, permissions: ['*'] } }],
    ['a service key of another identity', { serviceAuth: { ...serviceAuth, serviceKey: { email: 'user@test.com' } } }],
  ])('403s %s, whatever the headers say', (_name, overrides) => {
    const req = makeReq(overrides);
    const res = makeRes();
    const next = jest.fn();
    groundingActingUser(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('grounding_service_key_required');
    expect(req.apiKeyInfo).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['no at sign', 'user.test.com'],
    ['two addresses joined by a repeated header', 'a@test.com, b@test.com'],
    ['a control character', 'a\u0000@test.com'],
    ['longer than 254 characters', `${'a'.repeat(250)}@test.com`],
    ['sent twice as an array', ['a@test.com', 'b@test.com']],
  ])('400s an acting e-mail that is %s', (_name, value) => {
    const res = makeRes();
    const next = jest.fn();
    groundingActingUser(makeReq({ headers: { [ACTING_EMAIL_HEADER]: value, [ACTING_ROLE_HEADER]: 'user' } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_acting_user');
  });

  it.each([undefined, '', 'root', 'Admin', ['user', 'admin']])('400s the acting role %p', (role) => {
    const res = makeRes();
    groundingActingUser(makeReq({ headers: { [ACTING_EMAIL_HEADER]: 'user@test.com', [ACTING_ROLE_HEADER]: role } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_acting_role');
  });
});
