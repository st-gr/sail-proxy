/**
 * apiKeyController.listApiKeys used to mask keys with a "first 6 chars +
 * ****" scheme in the JSON response body — a prefix is still key material.
 * This is a response-body leak, not a log leak, but the same "never expose
 * a secret, not even part of one" bar applies (see
 * ../src/utils/secretLabel.ts doc comment).
 *
 * @see ../src/controllers/apiKeyController.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockListApiKeys: any = jest.fn();
jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: { listApiKeys: (...args: any[]) => mockListApiKeys(...args) },
}));

import { listApiKeys } from '../src/controllers/apiKeyController';

const FAKE_KEY = 'sk-test-FAKE-LISTED-KEY-1234567890abcdef';

describe('apiKeyController.listApiKeys never returns a prefix of the raw key', () => {
  beforeEach(() => {
    mockListApiKeys.mockReset();
  });

  it('never includes any 8+ char substring of the key in the response body', async () => {
    mockListApiKeys.mockResolvedValue([
      { id: 'id-1', key: FAKE_KEY, createdBy: 'tester', email: 'a@b.com', createdAt: new Date(), isActive: true },
    ]);

    const req: any = {};
    let body: any;
    const res: any = { json: (b: any) => { body = b; return res; } };
    const next = jest.fn();

    await listApiKeys(req, res, next);

    const serialized = JSON.stringify(body);
    for (let start = 0; start + 8 <= FAKE_KEY.length; start++) {
      const chunk = FAKE_KEY.slice(start, start + 8);
      expect(serialized.includes(chunk)).toBe(false);
    }
    // The id is still present, so a caller can still tell entries apart.
    expect(body[0].id).toBe('id-1');
    expect(typeof body[0].key).toBe('string');
    expect(body[0].key).toMatch(/^[0-9a-f]{8}$/);
  });
});
