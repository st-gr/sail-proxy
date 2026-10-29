// Local stand-in for nginx + oauth2-proxy in front of the demo admin (127.0.0.1:14004): /admin/<path> is
// forwarded as /<path> with the X-Auth-Request-* identity headers nginx would set after a sign-in.
// No groups header is sent: the admin's local identity provider then maps the e-mail through
// LOCAL_USER_MAPPING (see stack/grant-identities.mjs). :4010 = the admin identity, :4011 = a user
// identity (IDENTITY_INDEX picks which). Loopback only.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_PORT = Number(process.env.TARGET_PORT || 14004);

export function identityHeaders(id) {
  return {
    'x-auth-request-user': id.email,
    'x-auth-request-email': id.email,
    'x-auth-request-preferred-username': id.name,
    'x-forwarded-prefix': '/admin'
  };
}

export function startProxy({ port, targetPort, identity }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/admin' || req.url === '/admin/') { res.writeHead(302, { Location: '/admin/app/shell/' }); return res.end(); }
    const path = req.url.startsWith('/admin/') ? req.url.slice('/admin'.length) : req.url;
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    for (const h of Object.keys(headers)) if (h.startsWith('x-auth-request-')) delete headers[h];
    Object.assign(headers, identityHeaders(identity));
    const up = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path, headers }, (r) => {
      const out = { ...r.headers };
      if (typeof out.location === 'string' && out.location.startsWith('/') && !out.location.startsWith('/admin/')) out.location = '/admin' + out.location;
      res.writeHead(r.statusCode, out); r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ids = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'identities.json'), 'utf8'));
  const user = ids.users[Number(process.env.IDENTITY_INDEX || 0)];
  Promise.all([
    startProxy({ port: 4010, targetPort: TARGET_PORT, identity: ids.admin }),
    startProxy({ port: 4011, targetPort: TARGET_PORT, identity: user })
  ]).then(() => console.log(`proxy :4010 as ${ids.admin.email} (admin), :4011 as ${user.email} (user) -> 127.0.0.1:${TARGET_PORT}`));
}
