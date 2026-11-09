import { describe, it, expect } from '@jest/globals';
import { signAwsRequest } from '@libs/aws-signing/sigV4';
import { deriveSigningKey, parseSigV4AuthHeader, verifySigV4Request } from '../../src/utils/sigv4Verifier';

// AWS's documented example credentials (sigv4Verifier.test.ts) - not real.
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
const VANILLA_AUTH =
  'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';

describe('signAwsRequest', () => {
  it('get-vanilla vector', () => {
    const h = signAwsRequest({
      method: 'GET', url: 'https://example.amazonaws.com/', body: '', service: 'service', region: 'us-east-1',
      ...creds, amzDate: '20150830T123600Z', contentSha256Header: false,
    });
    expect(h.authorization).toBe(VANILLA_AUTH);
    expect(h['x-amz-date']).toBe('20150830T123600Z');
    expect(h['x-amz-content-sha256']).toBeUndefined();
  });

  it('query is sorted and encoded', () => {
    const sign = (q: string) =>
      signAwsRequest({
        method: 'GET', url: `https://bedrock.us-east-1.amazonaws.com/inference-profiles?${q}`, body: '',
        service: 'bedrock', region: 'us-east-1', ...creds, amzDate: '20260926T120000Z',
      }).authorization;
    expect(sign('typeEquals=SYSTEM_DEFINED&maxResults=1000')).toBe(sign('maxResults=1000&typeEquals=SYSTEM_DEFINED'));
    expect(sign('a=b c')).toBe(sign('a=b%20c'));
  });

  it('path is double-encoded (round-trips through the inbound verifier)', async () => {
    const url = 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke';
    const body = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16}';
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const h = signAwsRequest({ method: 'POST', url, body, service: 'bedrock', region: 'us-east-1', ...creds, amzDate });
    const parsed = parseSigV4AuthHeader(h.authorization);
    expect(parsed).not.toBeNull();
    const req = {
      method: 'POST',
      originalUrl: new URL(url).pathname,
      rawBody: body,
      headers: { host: 'bedrock-runtime.us-east-1.amazonaws.com', ...h },
    };
    const provider = { getSigningKey: async (_id: string, scope: any) => deriveSigningKey(SECRET, scope) };
    expect(await verifySigV4Request(req, parsed!, provider)).toBe(true);
    expect(await verifySigV4Request({ ...req, rawBody: body + ' ' }, parsed!, provider)).toBe(false);
  });

  it('session token is signed', () => {
    const h = signAwsRequest({
      method: 'GET', url: 'https://bedrock.us-east-1.amazonaws.com/foundation-models', body: '', service: 'bedrock',
      region: 'us-east-1', ...creds, sessionToken: 'TOKEN123', amzDate: '20260926T120000Z',
    });
    expect(h['x-amz-security-token']).toBe('TOKEN123');
    expect(h.authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  });
});
