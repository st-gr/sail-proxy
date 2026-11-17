/**
 * docker/setup-flow/docker-config.js: the shared reader of the files setup-docker.js writes
 * under docker/ (used by setup-docker's re-run and by setup-kyma for values shared with Docker).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readDockerConfigValues, parseEnvText, isExternalLdap, usesImageRegistry, githubTeam } = require('../../../docker/setup-flow/docker-config');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-config-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

describe('readDockerConfigValues', () => {
  it('returns undefined everywhere when nothing was written', () => {
    const values = readDockerConfigValues(dir);
    expect(values.groups).toEqual({ admin: undefined, user: undefined });
    const { groups, ...rest } = values;
    expect(Object.values(rest).every((v) => v === undefined)).toBe(true);
  });

  it('reads the raw values from every file', () => {
    write('.env', '# db\nPOSTGRES_USER=gh_user\nPOSTGRES_PASSWORD=never-returned-1\n');
    write('.env.docker', 'DOCKER_REGISTRY=reg.example.invalid\nDOCKER_ORGANIZATION=org1\nDOCKER_IMAGE_MODE=registry\n');
    write('.env.nginx', 'BASE_URL=https://gw.example.invalid\nLOGOUT_REDIRECT_URL=auto-shell\n');
    write(
      '.env.auth',
      'IDENTITY_PROVIDER=github\nROLE_MAPPING={"acme:admins":"admin","acme:other":"admin","acme:users":"user"}\n' +
        'LDAP_HOST=LDAP_HOST\n'
    );
    write(
      'dex.config.yaml',
      'connectors:\n- type: github\n  config:\n    clientID: "id-1"  # quoted\n    clientSecret: secret-1\n    ssoURL: OKTA_SSO_URL\n    orgs:\n    - name: acme \n'
    );
    const values = readDockerConfigValues(dir);
    expect(values).toEqual({
      POSTGRES_USER: 'gh_user',
      IDENTITY_PROVIDER: 'github',
      groups: { admin: 'acme:admins', user: 'acme:users' },
      LOGOUT_REDIRECT_URL: 'auto-shell',
      BASE_URL: 'https://gw.example.invalid',
      GITHUB_CLIENT_ID: 'id-1',
      GITHUB_CLIENT_SECRET: 'secret-1',
      GITHUB_ORG: 'acme',
      OKTA_SSO_URL: 'OKTA_SSO_URL',
      LDAP_HOST: 'LDAP_HOST',
      LDAP_BIND_DN: undefined,
      LDAP_BIND_PASSWORD: undefined,
      LDAP_USER_BASE_DN: undefined,
      LDAP_GROUP_BASE_DN: undefined,
      DOCKER_REGISTRY: 'reg.example.invalid',
      DOCKER_ORGANIZATION: 'org1',
      DOCKER_IMAGE_MODE: 'registry',
    });
    expect(JSON.stringify(values)).not.toContain('never-returned-1');
  });

  it('reads an IAS (OIDC) connector: the tenant issuer, not Dex\'s own, and the quoted client secret exactly', () => {
    const secret = 's3:cr#t "q" \\ $& [x]';
    write('.env.auth', 'IDENTITY_PROVIDER=ias\nROLE_MAPPING={"ias-admins":"admin","ias-users":"user"}\n');
    write(
      'dex.config.yaml',
      'issuer: https://gw.example.invalid/dex\nconnectors:\n- type: oidc\n  id: sap-ias\n  config:\n' +
        '    issuer: "https://tenant.example.invalid"\n    clientID: "client-1"\n' +
        `    clientSecret: ${JSON.stringify(secret)}\n    redirectURI: https://gw.example.invalid/dex/callback\n`
    );
    const values = readDockerConfigValues(dir);
    expect(values).toMatchObject({
      IDENTITY_PROVIDER: 'ias',
      groups: { admin: 'ias-admins', user: 'ias-users' },
      IAS_ISSUER_URL: 'https://tenant.example.invalid',
      IAS_CLIENT_ID: 'client-1',
      IAS_CLIENT_SECRET: secret,
    });
  });

  it('a GitHub connector yields no IAS values', () => {
    write('dex.config.yaml', 'issuer: https://gw.example.invalid/dex\nconnectors:\n- type: github\n  config:\n    clientID: id-1\n    clientSecret: secret-1\n');
    const values = readDockerConfigValues(dir);
    expect(values.IAS_ISSUER_URL).toBeUndefined();
    expect(values.IAS_CLIENT_ID).toBeUndefined();
    expect(values.IAS_CLIENT_SECRET).toBeUndefined();
  });

  it('an unreadable ROLE_MAPPING yields no groups', () => {
    write('.env.auth', 'IDENTITY_PROVIDER=okta\nROLE_MAPPING={not json\n');
    expect(readDockerConfigValues(dir).groups).toEqual({ admin: undefined, user: undefined });
  });
});

describe('docker-config helpers', () => {
  it('parseEnvText trims, skips comments and keeps quotes', () => {
    expect(parseEnvText(' A = 1 \n# B=2\n\nC="x=y"\n=bad\n')).toEqual({ A: '1', C: '"x=y"' });
  });

  it('isExternalLdap: the LDAP_HOST placeholder means a local server', () => {
    expect(isExternalLdap({ LDAP_HOST: 'LDAP_HOST' })).toBe(false);
    expect(isExternalLdap({})).toBe(false);
    expect(isExternalLdap({ LDAP_HOST: 'ldap.example.invalid:636' })).toBe(true);
  });

  it('usesImageRegistry: the marker or any non-default registry', () => {
    expect(usesImageRegistry({ DOCKER_REGISTRY: 'ghcr.io', DOCKER_ORGANIZATION: 'st-gr' })).toBe(false);
    expect(usesImageRegistry({ DOCKER_REGISTRY: 'ghcr.io', DOCKER_ORGANIZATION: 'st-gr', DOCKER_IMAGE_MODE: 'registry' })).toBe(true);
    expect(usesImageRegistry({ DOCKER_REGISTRY: 'ghcr.io', DOCKER_ORGANIZATION: 'other' })).toBe(true);
  });

  it('githubTeam strips the organization prefix', () => {
    expect(githubTeam('acme', 'acme:admins')).toBe('admins');
    expect(githubTeam('acme', 'other:admins')).toBeUndefined();
    expect(githubTeam('acme', undefined)).toBeUndefined();
  });
});
