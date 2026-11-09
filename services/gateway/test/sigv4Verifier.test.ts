/**
 * The gateway's own AWS SigV4 verifier.
 *
 * The first block checks it against AWS's published SigV4 test suite, copied verbatim from
 *   https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
 *   (get-vanilla, post-vanilla, get-vanilla-query-order-key-case: request.txt,
 *   header-signed-request.txt, context.json; fetched 2026-09-26)
 * so the canonicalisation and key derivation are anchored to values this code did not produce.
 *
 * The variant block uses Bedrock requests signed by botocore 1.34.98 (SigV4Auth, service
 * `bedrock`, region us-east-1, clock fixed at 2026-09-26T12:00:00Z) with the same example
 * secret: once against the gateway URL (with and without the port) and once against the real
 * bedrock-runtime host without the /aws-bedrock mount prefix.
 *
 * @see ../src/utils/sigv4Verifier.ts
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import {
  isAwsSigV4Request,
  parseSigV4AuthHeader,
  deriveSigningKey,
  isAmzDateFresh,
  verifySigV4Request,
  SigningKeyProvider,
  SigningScope,
} from '../src/utils/sigv4Verifier';

// AWS's documented example secret (context.json of every vector above) — not a real credential.
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';

function exampleProvider(): SigningKeyProvider & { scopes: SigningScope[] } {
  const scopes: SigningScope[] = [];
  return {
    scopes,
    async getSigningKey(accessKeyId: string, scope: SigningScope) {
      scopes.push(scope);
      return accessKeyId === EXAMPLE_ACCESS_KEY_ID ? deriveSigningKey(EXAMPLE_SECRET, scope) : null;
    },
  };
}

async function verify(req: any, provider: SigningKeyProvider = exampleProvider()): Promise<boolean> {
  const parsed = parseSigV4AuthHeader(req.headers.authorization);
  expect(parsed).not.toBeNull();
  return verifySigV4Request(req, parsed!, provider);
}

function suiteRequest(method: string, originalUrl: string, signature: string) {
  return {
    method,
    originalUrl,
    headers: {
      host: 'example.amazonaws.com',
      'x-amz-date': '20150830T123600Z',
      authorization: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`,
    },
  };
}

describe('AWS SigV4 test suite vectors', () => {
  it('get-vanilla', async () => {
    expect(await verify(suiteRequest('GET', '/', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'))).toBe(true);
  });

  it('post-vanilla', async () => {
    expect(await verify(suiteRequest('POST', '/', '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b'))).toBe(true);
  });

  it('get-vanilla-query-order-key-case (query is sorted before signing)', async () => {
    expect(await verify(suiteRequest('GET', '/?Param2=value2&Param1=value1', 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'))).toBe(true);
  });

  it('rejects a vector whose signature differs in one hex digit', async () => {
    expect(await verify(suiteRequest('GET', '/', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf30'))).toBe(false);
  });

  it('rejects a vector replayed with a different method', async () => {
    expect(await verify(suiteRequest('POST', '/', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'))).toBe(false);
  });

  it('rejects when the provider has no key for the access key id', async () => {
    const req = suiteRequest('GET', '/', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    const noKey: SigningKeyProvider = { getSigningKey: async () => null };
    expect(await verify(req, noKey)).toBe(false);
  });

  it('rejects when the credential scope date is not the x-amz-date day', async () => {
    const req = suiteRequest('GET', '/', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    req.headers['x-amz-date'] = '20150831T123600Z';
    expect(await verify(req)).toBe(false);
  });
});

const BEDROCK_BODY = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}';
const BEDROCK_URL = '/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke';
const SIG_GATEWAY_HOST_WITH_PORT = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b0';
const SIG_GATEWAY_HOST_NO_PORT = 'f8a280f3996a167ae4f02747e85f40f438deef483a8a2241779bd94fab3f6ebb';
const SIG_AWS_HOST_NO_PREFIX = '50cb8bb3b0dcf397d16dd1ae4c9fdb4cfa999a09442c59c3c0fc22faeab689e9';

function bedrockRequest(signature: string, overrides: { rawBody?: string; host?: string; headers?: Record<string, string> } = {}) {
  return {
    method: 'POST',
    originalUrl: BEDROCK_URL,
    rawBody: overrides.rawBody ?? BEDROCK_BODY,
    headers: {
      host: overrides.host ?? 'localhost:3000',
      'content-type': 'application/json',
      'x-amz-date': '20260926T120000Z',
      authorization: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260926/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
      ...overrides.headers,
    },
  };
}

describe('gateway variants (botocore-signed Bedrock requests)', () => {
  it('accepts a request signed for the gateway host and /aws-bedrock path', async () => {
    expect(await verify(bedrockRequest(SIG_GATEWAY_HOST_WITH_PORT))).toBe(true);
  });

  it('accepts a request signed for the gateway host without its port', async () => {
    expect(await verify(bedrockRequest(SIG_GATEWAY_HOST_NO_PORT))).toBe(true);
  });

  it('accepts a request signed for bedrock-runtime.<region>.amazonaws.com without the mount prefix', async () => {
    expect(await verify(bedrockRequest(SIG_AWS_HOST_NO_PREFIX))).toBe(true);
  });

  it('rejects a tampered body', async () => {
    expect(await verify(bedrockRequest(SIG_GATEWAY_HOST_WITH_PORT, { rawBody: BEDROCK_BODY.replace('"hi"', '"ho"') }))).toBe(false);
  });

  it('rejects a tampered body even when x-amz-content-sha256 carries the original hash', async () => {
    const originalHash = crypto.createHash('sha256').update(BEDROCK_BODY).digest('hex');
    const req = bedrockRequest(SIG_GATEWAY_HOST_WITH_PORT, {
      rawBody: BEDROCK_BODY.replace('"hi"', '"ho"'),
      headers: { 'x-amz-content-sha256': originalHash },
    });
    expect(await verify(req)).toBe(false);
  });

  it('rejects a host that is not one of the accepted variants', async () => {
    expect(await verify(bedrockRequest(SIG_GATEWAY_HOST_WITH_PORT, { host: 'elsewhere.example:3000' }))).toBe(false);
  });

  it('asks the provider only for the header scope and the bedrock <-> bedrock-runtime alternative', async () => {
    const provider = exampleProvider();
    await verify(bedrockRequest('0'.repeat(64)), provider);
    const unique = new Set(provider.scopes.map((s) => `${s.date}/${s.region}/${s.service}`));
    expect([...unique].sort()).toEqual(['20260926/us-east-1/bedrock', '20260926/us-east-1/bedrock-runtime']);
  });
});

// botocore 1.34.98 again (same body, clock, secret and scope), signed for the endpoints a client
// uses through nginx: https://gw.example/gateway/aws-bedrock and
// http://localhost:8080/gateway/aws-bedrock. nginx strips /gateway and sends Host without the
// port; it passes both on as X-Forwarded-Prefix and X-Forwarded-Host.
const SIG_NGINX_GW_EXAMPLE = '05fc4d5b0145af50a080a9f85a25735a2745af1f9fcb7d71d37689fb0bc3ccdc';
const SIG_NGINX_LOCALHOST_8080 = '30898d3495cacae4399491a99fd884ae227b3fed2e27912f896bf3c3dbeb79f7';

describe('requests forwarded by nginx under /gateway', () => {
  it('accepts a request signed for https://gw.example/gateway/aws-bedrock', async () => {
    const req = bedrockRequest(SIG_NGINX_GW_EXAMPLE, {
      host: 'gw.example',
      headers: { 'x-forwarded-prefix': '/gateway', 'x-forwarded-host': 'gw.example' },
    });
    expect(await verify(req)).toBe(true);
  });

  it('accepts a request signed for http://localhost:8080/gateway/aws-bedrock', async () => {
    const req = bedrockRequest(SIG_NGINX_LOCALHOST_8080, {
      host: 'localhost',
      headers: { 'x-forwarded-prefix': '/gateway', 'x-forwarded-host': 'localhost:8080' },
    });
    expect(await verify(req)).toBe(true);
  });

  it('rejects the same requests without the forwarded headers', async () => {
    expect(await verify(bedrockRequest(SIG_NGINX_GW_EXAMPLE, { host: 'gw.example' }))).toBe(false);
    expect(await verify(bedrockRequest(SIG_NGINX_LOCALHOST_8080, { host: 'localhost' }))).toBe(false);
    // The prefix alone is not enough when the signed host carried a port nginx dropped.
    const prefixOnly = bedrockRequest(SIG_NGINX_LOCALHOST_8080, { host: 'localhost', headers: { 'x-forwarded-prefix': '/gateway' } });
    expect(await verify(prefixOnly)).toBe(false);
  });

  it('ignores a malformed X-Forwarded-Prefix', async () => {
    for (const prefix of ['gateway', '/gateway/', '/gateway, /gateway', '/gate way', '//gateway', '/gateway?x=1']) {
      const req = bedrockRequest(SIG_NGINX_GW_EXAMPLE, {
        host: 'gw.example',
        headers: { 'x-forwarded-prefix': prefix, 'x-forwarded-host': 'gw.example' },
      });
      expect(await verify(req)).toBe(false);
    }
  });

  it('ignores a malformed X-Forwarded-Host', async () => {
    for (const host of ['localhost:8080, localhost:8080', 'localhost:8080/x', 'local host:8080', 'localhost:123456']) {
      const req = bedrockRequest(SIG_NGINX_LOCALHOST_8080, {
        host: 'localhost',
        headers: { 'x-forwarded-prefix': '/gateway', 'x-forwarded-host': host },
      });
      expect(await verify(req)).toBe(false);
    }
  });
});

// botocore 1.34.98 again (same body, clock, secret and scope), signed for shapes that must be
// rejected even though a piece of them looks well-formed on its own: a real signature for a
// mount prefix nginx never sends, and a real signature for a Host nginx's forwarded-host
// validation must never let through. Unlike the malformed-value guard tests above, these
// signatures are real for the value under test, so removing the corresponding check would flip
// them to accepted.
const SIG_NGINX_OTHER_PREFIX = 'c7063d1c9c1d7b8c87fcf66c00959915e1557de22fc512e804783d4d69b7a902';
const SIG_SIGNED_FOR_SPACE_HOST = '44bea466437d9175fdf9c30d41d555c5c8f55bf52957bb201fba617197420a87';

describe('X-Forwarded-Prefix is restricted to the allowed list', () => {
  it('rejects a request signed for /other/aws-bedrock even though /other is well-formed', async () => {
    const req = bedrockRequest(SIG_NGINX_OTHER_PREFIX, {
      host: 'gw.example',
      headers: { 'x-forwarded-prefix': '/other', 'x-forwarded-host': 'gw.example' },
    });
    expect(await verify(req)).toBe(false);
  });
});

describe('X-Forwarded-Host validation cannot be bypassed by a valid signature', () => {
  it('rejects a request validly signed for a Host containing a space, arriving as that X-Forwarded-Host', async () => {
    const req = bedrockRequest(SIG_SIGNED_FOR_SPACE_HOST, {
      host: 'gw.example',
      headers: { 'x-forwarded-prefix': '/gateway', 'x-forwarded-host': 'gw example.com' },
    });
    expect(await verify(req)).toBe(false);
  });
});

// Also botocore 1.34.98, same body, URL, clock and secret; these sign x-amz-content-sha256
// (UNSIGNED-PAYLOAD, or the body's real sha256) or leave host out of SignedHeaders.
const SIG_UNSIGNED_PAYLOAD = 'bf6eca79418c96a989bb5a943a808f58b096ad21e9e435b9a1aab8e79a07fdba';
const SIG_DECLARED_HEX = 'eef73a52b1c9d35b8a86536d70cfb3cc7f0cd69c734eb2f615444ea544b863f1';
const SIG_NO_HOST = '6d6a44486c7b1081fe37f22be6ae24117e17d2608cd299744aa2cecb950a1535';
const BODY_SHA256 = crypto.createHash('sha256').update(BEDROCK_BODY).digest('hex');

function withSignedHeaders(signedHeaders: string, signature: string) {
  return `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260926/us-east-1/bedrock/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

describe('payload binding', () => {
  const signedWithSha = 'content-type;host;x-amz-content-sha256;x-amz-date';

  it('accepts a declared x-amz-content-sha256 that is the real body hash', async () => {
    const req = bedrockRequest(SIG_DECLARED_HEX, {
      headers: { 'x-amz-content-sha256': BODY_SHA256, authorization: withSignedHeaders(signedWithSha, SIG_DECLARED_HEX) },
    });
    expect(await verify(req)).toBe(true);
  });

  it('rejects a validly signed declared hash once the body no longer matches it', async () => {
    const req = bedrockRequest(SIG_DECLARED_HEX, {
      rawBody: BEDROCK_BODY.replace('"hi"', '"ho"'),
      headers: { 'x-amz-content-sha256': BODY_SHA256, authorization: withSignedHeaders(signedWithSha, SIG_DECLARED_HEX) },
    });
    expect(await verify(req)).toBe(false);
  });

  it('rejects a validly signed UNSIGNED-PAYLOAD request with a changed body', async () => {
    const req = bedrockRequest(SIG_UNSIGNED_PAYLOAD, {
      rawBody: BEDROCK_BODY.replace('"hi"', '"ho"'),
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', authorization: withSignedHeaders(signedWithSha, SIG_UNSIGNED_PAYLOAD) },
    });
    expect(await verify(req)).toBe(false);
  });

  it('rejects UNSIGNED-PAYLOAD even with the original body: a captured body is always bound', async () => {
    const req = bedrockRequest(SIG_UNSIGNED_PAYLOAD, {
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', authorization: withSignedHeaders(signedWithSha, SIG_UNSIGNED_PAYLOAD) },
    });
    expect(await verify(req)).toBe(false);
  });

  it('rejects a request with a body the gateway did not capture, even with a validly signed declared hash', async () => {
    const authorization = withSignedHeaders(signedWithSha, SIG_DECLARED_HEX);
    const req: any = bedrockRequest(SIG_DECLARED_HEX, { headers: { 'x-amz-content-sha256': BODY_SHA256, authorization, 'content-length': '102' } });
    delete req.rawBody;
    expect(await verify(req)).toBe(false);
    const chunked: any = bedrockRequest(SIG_DECLARED_HEX, { headers: { 'x-amz-content-sha256': BODY_SHA256, authorization, 'transfer-encoding': 'chunked' } });
    delete chunked.rawBody;
    expect(await verify(chunked)).toBe(false);
  });
});

describe('signed headers', () => {
  it('rejects a validly signed request whose SignedHeaders leave out host', async () => {
    const req = bedrockRequest(SIG_NO_HOST, { headers: { authorization: withSignedHeaders('content-type;x-amz-date', SIG_NO_HOST) } });
    expect(await verify(req)).toBe(false);
  });
});

describe('isAwsSigV4Request', () => {
  it('accepts only the exact algorithm prefix followed by a space', () => {
    expect(isAwsSigV4Request('AWS4-HMAC-SHA256 Credential=a/b/c/d/e')).toBe(true);
    expect(isAwsSigV4Request('X AWS4-HMAC-SHA256 Credential=a/b/c')).toBe(false);
    expect(isAwsSigV4Request('Bearer AWS4-HMAC-SHA256 Credential=a/b/c')).toBe(false);
    expect(isAwsSigV4Request(' AWS4-HMAC-SHA256 Credential=a/b/c')).toBe(false);
    expect(isAwsSigV4Request('aws4-hmac-sha256 Credential=a/b/c')).toBe(false);
    expect(isAwsSigV4Request('AWS4-HMAC-SHA256Credential=a/b/c')).toBe(false);
    expect(isAwsSigV4Request(undefined)).toBe(false);
    expect(isAwsSigV4Request(['AWS4-HMAC-SHA256 Credential=a/b/c'])).toBe(false);
  });
});

describe('isAmzDateFresh', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);

  it('accepts a timestamp within 15 minutes either side', () => {
    expect(isAmzDateFresh('20260926T120000Z', now)).toBe(true);
    expect(isAmzDateFresh('20260926T114500Z', now)).toBe(true);
    expect(isAmzDateFresh('20260926T121500Z', now)).toBe(true);
  });

  it('rejects a timestamp more than 15 minutes away', () => {
    expect(isAmzDateFresh('20260926T114459Z', now)).toBe(false);
    expect(isAmzDateFresh('20260926T121501Z', now)).toBe(false);
  });

  it('rejects a missing or malformed timestamp', () => {
    expect(isAmzDateFresh(undefined, now)).toBe(false);
    expect(isAmzDateFresh('', now)).toBe(false);
    expect(isAmzDateFresh('x', now)).toBe(false);
    expect(isAmzDateFresh('2026-09-26T12:00:00Z', now)).toBe(false);
    expect(isAmzDateFresh(['20260926T120000Z'], now)).toBe(false);
  });
});

/**
 * The AWS JS SDK sends Bedrock Runtime requests over HTTP/2 and signs the `:authority`
 * pseudo-header instead of `host` (as AWS accepts). nginx forwards them as HTTP/1.1 with a Host
 * header, so the signed `:authority` is checked against the same host variants as a signed `host`.
 * Vector: @smithy/signature-v4 5.7.2 (also 1.1.0, same result), service `bedrock`, region
 * us-east-1, clock 2026-09-26T12:00:00Z, the example secret, POST
 * https://gw.example/gateway/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke.
 */
const SIG_H2_AUTHORITY_GW_EXAMPLE = '252b3e4b3d6be90c3f39182217470ffeb31ff994cc313ff1e3d9097c88af22af';

function h2Request(host: string) {
  return bedrockRequest('', {
    host,
    headers: {
      'x-forwarded-prefix': '/gateway',
      'x-forwarded-host': host,
      'x-amz-content-sha256': '616eb59224eb795b641b4c541ad9ee8b939a1e8798f73b54fce66bb79ddbb992',
      authorization: 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260926/us-east-1/bedrock/aws4_request, '
        + `SignedHeaders=:authority;content-type;x-amz-content-sha256;x-amz-date, Signature=${SIG_H2_AUTHORITY_GW_EXAMPLE}`,
    },
  });
}

describe('HTTP/2 clients that sign :authority instead of host', () => {
  it('accepts the AWS JS SDK request forwarded by nginx', async () => {
    expect(await verify(h2Request('gw.example'))).toBe(true);
  });

  it('rejects it arriving for another host', async () => {
    expect(await verify(h2Request('other.example'))).toBe(false);
  });
});
