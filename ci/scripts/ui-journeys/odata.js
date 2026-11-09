'use strict';

const SERVICE_PATH = '/odata/v4/admin';

// Minimal OData V4 client for the seed script: Basic auth, JSON in/out, throws on non-2xx.
function createClient(baseUrl, credentials) {
  const authorization = 'Basic ' + Buffer.from(credentials).toString('base64');

  async function call(method, path, body) {
    const response = await fetch(baseUrl + SERVICE_PATH + path, {
      method,
      headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${SERVICE_PATH}${path} -> ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body || {}),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path)
  };
}

module.exports = { createClient };
