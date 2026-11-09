import {
  tenantFromServiceKey,
  tenantFromAuthUrl
} from '../../service-key-parser/index';

const AI_URL = 'https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com';
const ZONE_ID = '3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b';

function key(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    serviceurls: { AI_API_URL: AI_URL },
    appname: 'acme-aicore!b1',
    clientid: 'sb-client-one',
    clientsecret: 'secret-one',
    identityzone: 'acme-dev',
    identityzoneid: ZONE_ID,
    url: 'https://acme-dev.authentication.us10.hana.ondemand.com',
    'credential-type': 'binding-secret',
    ...overrides
  });
}

describe('tenantFromServiceKey', () => {
  it('returns zone, zone id and region', () => {
    expect(tenantFromServiceKey(key())).toEqual({
      zone: 'acme-dev.us10',
      zoneId: ZONE_ID,
      region: 'prod.us-east-1'
    });
  });

  it('two keys of one subaccount give the same tenant key', () => {
    const a = tenantFromServiceKey(key());
    const b = tenantFromServiceKey(key({ clientid: 'sb-client-two', clientsecret: 'secret-two' }));
    expect(b.zone).toBe(a.zone);
  });

  it('zoneId is null when the key has none', () => {
    expect(tenantFromServiceKey(key({ identityzoneid: undefined })).zoneId).toBeNull();
  });

  it('throws the parseServiceKey messages', () => {
    expect(() => tenantFromServiceKey('{nope')).toThrow('Invalid JSON format');
    expect(() => tenantFromServiceKey(key({ serviceurls: {} }))).toThrow(
      'Missing required field: serviceurls.AI_API_URL'
    );
    expect(() => tenantFromServiceKey(key({ identityzone: undefined }))).toThrow(
      'Missing required field: identityzone'
    );
  });
});

describe('tenantFromAuthUrl', () => {
  it('the zone is the subdomain and the landscape', () => {
    expect(
      tenantFromAuthUrl('https://acme-dev.authentication.us10.hana.ondemand.com/oauth/token', AI_URL)
    ).toEqual({ zone: 'acme-dev.us10', zoneId: null, region: 'prod.us-east-1' });
  });

  it('one subdomain on two landscapes gives two tenant keys', () => {
    const us = tenantFromAuthUrl('https://acme.authentication.us10.hana.ondemand.com/oauth/token', AI_URL);
    const eu = tenantFromAuthUrl('https://acme.authentication.eu10.hana.ondemand.com/oauth/token', AI_URL);
    expect([us.zone, eu.zone]).toEqual(['acme.us10', 'acme.eu10']);
  });

  it('a rotated key (same url, another client) keeps the tenant key', () => {
    const a = tenantFromServiceKey(key());
    const b = tenantFromServiceKey(key({ clientid: 'sb-client-two', clientsecret: 'secret-two' }));
    expect(b.zone).toBe('acme-dev.us10');
    expect(b.zone).toBe(a.zone);
  });

  it('trims and lower-cases; a host without an authentication label falls back to the whole host', () => {
    expect(tenantFromAuthUrl('https://Acme-Dev.Authentication.US10.hana.ondemand.com/oauth/token', AI_URL).zone).toBe('acme-dev.us10');
    expect(tenantFromAuthUrl('https://Login.Example.invalid/oauth/token', AI_URL).zone).toBe('login.example.invalid');
  });

  it('matches the zone of the service key', () => {
    const fromKey = tenantFromServiceKey(key());
    const fromUrl = tenantFromAuthUrl(
      'https://acme-dev.authentication.us10.hana.ondemand.com/oauth/token',
      AI_URL
    );
    expect(fromUrl.zone).toBe(fromKey.zone);
  });

  it('a mixed-case, padded identityzone does not change the zone of the auth URL', () => {
    const fromKey = tenantFromServiceKey(key({ identityzone: ' Acme-Dev ' }));
    const fromUrl = tenantFromAuthUrl(
      'https://acme-dev.authentication.us10.hana.ondemand.com/oauth/token',
      AI_URL
    );
    expect(fromKey.zone).toBe('acme-dev.us10');
    expect(fromKey.zone).toBe(fromUrl.zone);
  });

  it('a host without an authentication label is capped at 100 characters', () => {
    const longHost = `${'a'.repeat(80)}.${'b'.repeat(80)}.invalid`;
    const zone = tenantFromAuthUrl(`https://${longHost}/oauth/token`, AI_URL).zone;
    expect(zone).toHaveLength(100);
    expect(zone).toBe(longHost.slice(0, 100));
  });

  it('the authentication branch is capped at 100 characters too', () => {
    const zone = tenantFromAuthUrl(
      `https://${'a'.repeat(80)}.authentication.${'b'.repeat(30)}.hana.ondemand.com/oauth/token`,
      AI_URL
    ).zone;
    expect(zone).toHaveLength(100);
  });

  it('throws on an unparseable auth URL', () => {
    expect(() => tenantFromAuthUrl('not a url', AI_URL)).toThrow('Invalid auth URL');
  });
});
