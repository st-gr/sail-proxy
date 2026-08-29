/**
 * CRITICAL 2: apiKeyAuth must never hand the raw, invalid API key to
 * securityEventEmitter.emitFailedAuth as credentialId — that value flows through the
 * siem-events Valkey stream into SiemEvent.actor.credential_id (services/admin/src/siem/siemEvent.ts)
 * and out to a third-party SIEM sink. Before the fix it passed the raw key verbatim.
 *
 * @see ../src/middlewares/apiKeyAuth.ts
 * @see ../src/utils/credentialIdentity.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitFailedAuth: any = (jest.fn() as any).mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => emitFailedAuth(...args) },
}));

const mockValidateApiKey: any = jest.fn();
jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: { validateApiKey: (...args: any[]) => mockValidateApiKey(...args), listApiKeys: jest.fn() },
}));

import apiKeyAuth from '../src/middlewares/apiKeyAuth';

// A canary value shaped like a real API key. Obviously fake (RFC-style placeholder), but
// long and high-entropy enough to exercise the hashing path the same way a real key would.
const CANARY_KEY = 'sk-canary-FAKE-0000000000000000000000000000';

function makeReq() {
  const headers: Record<string, any> = { 'x-api-key': CANARY_KEY };
  return {
    headers, query: {}, body: {}, method: 'POST', originalUrl: '/v1/chat/completions',
    ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
}

describe('apiKeyAuth never ships the raw canary key to the SIEM event pipeline', () => {
  beforeEach(() => {
    emitFailedAuth.mockClear();
    mockValidateApiKey.mockReset();
    mockValidateApiKey.mockResolvedValue(null); // the canary key never resolves to a row
  });

  it('emits a hashed credentialId, an 8-char hint, and never a bare credentialId equal to the raw key', async () => {
    await apiKeyAuth(makeReq(), makeRes(), jest.fn());

    expect(emitFailedAuth).toHaveBeenCalledTimes(1);
    const payload = emitFailedAuth.mock.calls[0][0];

    // credentialId (the field that flows unconditionally into SiemEvent.actor.credential_id
    // — services/admin/src/siem/siemEvent.ts — and out to every sink regardless of any
    // opt-in) must be a hash, never the raw key or a substring of it beyond the hint.
    expect(payload.credentialId).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.credentialId).not.toContain(CANARY_KEY);
    expect(payload.credentialHint).toBe(CANARY_KEY.slice(0, 8));

    // credentialMaterial legitimately carries the full value through the internal pipeline
    // (Valkey stream, the durable Postgres outbox) — it is the dispatcher (admin side,
    // siem/dispatcher.ts), not the gateway, that strips it from a sink's payload unless
    // that specific sink's include_credential_material opts in. Proven end-to-end in
    // services/admin/test/siem-dispatcher.test.ts.
    expect(payload.credentialMaterial).toBe(CANARY_KEY);
  });

  it('produces the same credentialId across two attempts with the same key, so correlation survives', async () => {
    await apiKeyAuth(makeReq(), makeRes(), jest.fn());
    await apiKeyAuth(makeReq(), makeRes(), jest.fn());

    expect(emitFailedAuth).toHaveBeenCalledTimes(2);
    const first = emitFailedAuth.mock.calls[0][0].credentialId;
    const second = emitFailedAuth.mock.calls[1][0].credentialId;
    expect(first).toBe(second);
  });
});
