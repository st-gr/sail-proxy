/**
 * nginx's /admin/odata/v4/validation/ location has an IP allowlist and no auth_request, so it
 * used to forward whatever X-Auth-Request-* headers the client sent. The admin's docker auth
 * middleware trusts those as an oauth2-proxy identity (X-Auth-Request-Groups: gateway even maps
 * to role `service`). The location must blank every X-Auth-Request-* header the admin reads; the
 * gateway authenticates with its service JWT instead. Kyma renders the same template.
 *
 * @see ../../../docker/nginx/templates/nginx.conf.tmpl
 * @see ../src/middleware/authMiddleware.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE = path.join(REPO_ROOT, 'docker', 'nginx', 'templates', 'nginx.conf.tmpl');
const AUTH_MIDDLEWARE = path.join(REPO_ROOT, 'services', 'admin', 'src', 'middleware', 'authMiddleware.ts');

/** The body of `location <prefix> { ... }`, braces matched. */
function locationBlock(conf: string, prefix: string): string {
  const start = conf.indexOf(`location ${prefix} {`);
  if (start < 0) throw new Error(`location ${prefix} not found`);
  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) return conf.slice(start, i + 1);
  }
  throw new Error(`location ${prefix} is not closed`);
}

// /admin/recordUsage has the same shape: an IP allowlist, no auth_request, the gateway calls it
// with its service JWT.
describe.each([['/admin/odata/v4/validation/'], ['/admin/recordUsage']])('nginx %s location drops client identity headers', prefix => {
  const block = locationBlock(fs.readFileSync(TEMPLATE, 'utf8'), prefix);
  // Every x-auth-request-* header the admin's auth middleware reads.
  const readByAdmin = [...new Set(
    [...fs.readFileSync(AUTH_MIDDLEWARE, 'utf8').matchAll(/req\.headers\['(x-auth-request-[a-z-]+)'\]/g)].map(m => m[1])
  )];

  it('the admin still reads oauth2-proxy identity headers (else this test checks nothing)', () => {
    expect(readByAdmin).toEqual(expect.arrayContaining(['x-auth-request-email', 'x-auth-request-groups']));
  });

  it.each(readByAdmin.map(h => [h]))('blanks %s', header => {
    const directive = new RegExp(`^\\s*proxy_set_header\\s+${header}\\s+""\\s*;`, 'im');
    expect(block).toMatch(directive);
  });

  it('keeps the IP allowlist', () => {
    expect(block).toMatch(/deny all;/);
  });
});

// A SigV4 client of https://host/gateway/aws-bedrock signs /gateway/... and host[:port]; nginx
// strips /gateway and proxy_params sends Host without the port. The gateway's verifier rebuilds
// what the client signed from these two headers.
describe('nginx /gateway/ location forwards what a SigV4 client signed', () => {
  const block = locationBlock(fs.readFileSync(TEMPLATE, 'utf8'), '/gateway/');

  it('strips /gateway (else the forwarded prefix is not needed)', () => {
    expect(block).toMatch(/proxy_pass\s+http:\/\/gateway_service\/;/);
  });

  it('sets X-Forwarded-Prefix /gateway', () => {
    expect(block).toMatch(/^\s*proxy_set_header\s+X-Forwarded-Prefix\s+\/gateway\s*;/m);
  });

  it('sets X-Forwarded-Host to the client Host header, port included', () => {
    expect(block).toMatch(/^\s*proxy_set_header\s+X-Forwarded-Host\s+\$http_host\s*;/m);
  });
});
