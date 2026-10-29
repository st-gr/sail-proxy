/**
 * nginx decides for every protected admin route whether the request is signed in. It used to accept a bearer
 * JWT checked by an njs script, but njs has no crypto.createVerify, so the signature check always fell back to
 * a structural one and passed, and an unknown key id or a missing key set passed as well. The cockpit and the
 * gateway never used that path (the cockpit signs in through oauth2-proxy, the gateway uses its own routes), so
 * it is gone: every protected route asks oauth2-proxy, and the identity headers come from oauth2-proxy only.
 * Kyma renders the same template and runs the same image.
 *
 * @see ../../../docker/nginx/templates/nginx.conf.tmpl
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf8');
const TEMPLATE = read('docker', 'nginx', 'templates', 'nginx.conf.tmpl');
const AUTH_LOCATION = '/_cookie_auth';

/** The body of `location <match> { ... }`, braces matched. */
function locationBlock(conf: string, match: string): string {
  const start = conf.indexOf(`location ${match} {`);
  if (start < 0) throw new Error(`location ${match} not found`);
  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) return conf.slice(start, i + 1);
  }
  throw new Error(`location ${match} is not closed`);
}

describe('nginx decides sign-in through oauth2-proxy only', () => {
  it('loads no JavaScript and has no bearer-token variables', () => {
    expect(TEMPLATE).not.toMatch(/\bjs_(import|set|path|content)\b/);
    expect(TEMPLATE).not.toMatch(/load_module[^;]*njs/);
    expect(TEMPLATE).not.toMatch(/\$jwt_|\$is_bearer_token|\$is_valid_bearer|\/internal\/jwks/);
  });

  it('every admin route asks the cookie auth location; only gateway routes ask the gateway check', () => {
    // [location match, auth_request target] for every location that has one.
    const pairs: [string, string][] = [];
    const re = /location\s+([^{]+?)\s*\{|auth_request\s+([^;\s]+);/g;
    let current = '';
    for (const m of TEMPLATE.matchAll(re)) {
      if (m[1]) current = m[1]; else pairs.push([current, m[2]]);
    }
    expect(pairs.filter(([, t]) => t === AUTH_LOCATION).length).toBeGreaterThan(5);
    for (const [where, target] of pairs) {
      if (/gateway/.test(where)) expect([where, target]).toEqual([where, '/_gateway_auth_check']);
      else expect([where, target]).toEqual([where, AUTH_LOCATION]);
    }
  });

  it('the auth location only asks oauth2-proxy and never answers success itself', () => {
    const block = locationBlock(TEMPLATE, `= ${AUTH_LOCATION}`);
    expect(block).toMatch(/\binternal;/);
    expect(block).toMatch(/proxy_pass\s+http:\/\/oauth2_proxy/);
    expect(block).not.toMatch(/\breturn\s+20\d\b/);
    expect(block).not.toMatch(/\bif\s*\(/);
  });

  it('identity headers sent to the admin come from oauth2-proxy\'s answer only', () => {
    const headers = [...TEMPLATE.matchAll(/proxy_set_header\s+(X-Auth-Request-[A-Za-z-]+)\s+("[^"]*"|\S+);/g)];
    expect(headers.length).toBeGreaterThan(0);
    for (const [, name, value] of headers) {
      expect([name, value.replace(/"/g, '')]).toEqual([name, expect.stringMatching(/^(\$(user|email|groups|preferred_username))?$/)]);
    }
  });
});

describe('the image, Compose and Kyma carry no bearer-token pieces', () => {
  it('the nginx image installs no njs module and ships no JWT script', () => {
    const dockerfile = read('docker', 'nginx', 'Dockerfile');
    expect(dockerfile).not.toMatch(/njs|jwt/i);
    expect(read('docker', 'nginx', 'entrypoint.sh')).not.toMatch(/jwt\.js|JWKS|JWT_ISSUER_URL|JWT_AUDIENCE/);
  });

  it('Compose and the Kyma manifest pass no JWT settings to nginx', () => {
    // The nginx service: from `  nginx:` to the next service or top-level key.
    const nginxService = read('docker', 'docker-compose.yml').match(/\n {2}nginx:\n[\s\S]*?(?=\n {2}[a-z0-9-]+:\n|\n[a-z]+:|$)/)?.[0];
    expect(nginxService).toMatch(/sail-proxy-nginx/);
    expect(nginxService).not.toMatch(/JWT_ISSUER_URL|JWT_AUDIENCE|JWKS_ENDPOINT|ENABLE_JWKS_CACHE/);
    expect(read('kyma', 'templates', 'manifests', 'core', 'nginx.yaml')).not.toMatch(/JWT_ISSUER_URL|JWT_AUDIENCE|JWKS/);
  });

  it('the earlier JWT scripts are gone', () => {
    for (const f of ['docker/nginx/templates/njs/jwt.js.tmpl', 'docker/njs/jwt.js', 'docker/njs/jwt-crypto.js', 'docker/njs/jwks.js',
      'docker/configs/shared/njs/jwt.js', 'docker/populate-jwks.sh', 'docker/nginx-entrypoint.sh']) {
      expect([f, fs.existsSync(path.join(REPO_ROOT, f))]).toEqual([f, false]);
    }
  });
});
