// Minimal client for the admin's OData v4 service and its REST endpoints, signed with the
// X-Auth-Request-* headers the proxy would add (no groups header: the admin maps the e-mail to a role).
// Talks to the admin directly (no proxy needed).
export function createClient({ baseUrl, identity, servicePath = '/odata/v4/admin' }) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-auth-request-user': identity.email,
    'x-auth-request-email': identity.email,
    'x-auth-request-preferred-username': identity.name
  };
  async function call(method, path, body) {
    const r = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: r.status, json };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    action: (name, params = {}) => call('POST', `${servicePath}/${name}`, params),
    boundAction: (entityPath, name, params = {}) => call('POST', `${servicePath}/${entityPath}/AdminService.${name}`, params),
    entity: (set, query = '') => call('GET', `${servicePath}/${set}${query}`)
  };
}
