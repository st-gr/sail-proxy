/**
 * Payload logs write request headers to disk. A provider connection's credential travels in a
 * header of its own (Azure `api-key`, an AWS session token, a Google API key), so each must be
 * redacted like `authorization` already is.
 */
import { filterSensitiveHeaders } from '../src/utils/payloadLogger';

describe('payload logger header redaction', () => {
  it.each(['api-key', 'Api-Key', 'x-amz-security-token', 'x-goog-api-key', 'authorization', 'x-api-key'])(
    'redacts %s', (header) => {
      expect(filterSensitiveHeaders({ [header]: 'secret-value' })[header]).toBe('[REDACTED]');
    });

  it('keeps non-secret headers', () => {
    expect(filterSensitiveHeaders({ 'anthropic-version': '2023-06-01' })['anthropic-version']).toBe('2023-06-01');
  });
});
