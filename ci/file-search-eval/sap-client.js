/**
 * A minimal SAP AI Core orchestration client for the question generator. `http` is axios (or a fake
 * with the same post/get), `sleep` is injectable for tests.
 *
 * - OAuth client credentials as modelService.getAuthToken does; a failed token request is fatal at once.
 * - The newest RUNNING deployment of scenario `orchestration` from GET /v2/lm/deployments.
 * - The openaiController request shape: system prompt as the template, the document in
 *   messages_history (the placeholder parser reads only the template), placeholder_values {}.
 * - Every HTTP request (token, deployment list, completion, retries included) counts against
 *   maxRequests; once spent, an error with `budget: true` stops the run.
 * - 429, 5xx, 401 (with a token refresh) and network errors are retried; 429 honours Retry-After up to
 *   30 s. Any other 4xx is fatal.
 * - Error messages carry only the HTTP status and a short error code from the body: never request
 *   config, headers, tokens or free text.
 */
const HTTP_TIMEOUT_MS = 180000;
const RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30000;

function fatal(message) {
  return Object.assign(new Error(message), { fatal: true });
}

/** "HTTP <status> <code>", the code only when it is a short identifier. */
function safeMessage(err) {
  if (!err.response) return /^[A-Z_]{2,32}$/.test(err.code || '') ? err.code : 'network error';
  const body = err.response.data && typeof err.response.data === 'object' ? err.response.data : {};
  const nested = body.error && typeof body.error === 'object' ? body.error : {};
  const code = [nested.code, nested.type, body.error, body.code, body.type]
    .map(c => (typeof c === 'number' ? String(c) : c))
    .find(c => typeof c === 'string' && /^[\w.-]{1,64}$/.test(c));
  return `HTTP ${err.response.status}${code ? ` ${code}` : ''}`;
}

/** Retry-After in milliseconds (seconds or an HTTP date), bounded; undefined when absent or invalid. */
function retryAfterMs(err, now) {
  const value = err.response && err.response.headers && err.response.headers['retry-after'];
  if (value === undefined) return undefined;
  const ms = /^\d+$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value) - now();
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : undefined;
}

function createSapClient(env, model, { http, maxRequests, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, log = () => {} }) {
  for (const k of ['AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_CORE_URL']) {
    if (!env[k]) throw fatal(`${k} is missing from the env file`);
  }
  const resourceGroup = env.SAP_AI_RESOURCE_GROUP || 'default';
  const stats = { requests: 0 };
  let token = null;
  let tokenExpiresAt = 0;
  let completionUrl = null;

  function spend() {
    if (stats.requests >= maxRequests) throw Object.assign(new Error(`${maxRequests} HTTP requests spent`), { budget: true });
    stats.requests++;
  }

  async function authHeaders() {
    if (!token || now() > tokenExpiresAt - 60000) {
      spend();
      const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET });
      try {
        const res = await http.post(env.AUTH_URL, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
        token = res.data.access_token;
        tokenExpiresAt = now() + res.data.expires_in * 1000;
      } catch (err) {
        throw fatal(`token request failed: ${safeMessage(err)}`);
      }
      if (!token) throw fatal('token request returned no access token');
    }
    return { Authorization: `Bearer ${token}`, 'AI-Resource-Group': resourceGroup };
  }

  async function findDeployment() {
    const headers = { ...(await authHeaders()), Accept: 'application/json' };
    spend();
    let res;
    try {
      res = await http.get(`${env.SAP_AI_CORE_URL}/v2/lm/deployments`, { headers, timeout: 30000 });
    } catch (err) {
      throw fatal(`deployment list failed: ${safeMessage(err)}`);
    }
    const running = (res.data.resources || [])
      .filter(d => d.status === 'RUNNING' && d.scenarioId === 'orchestration')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (running.length === 0) throw fatal('no RUNNING orchestration deployment in this resource group');
    log('using the newest RUNNING orchestration deployment');
    return `${env.SAP_AI_CORE_URL}/v2/inference/deployments/${running[0].id}/v2/completion`;
  }

  /** Resolves { text, usage, attempts }; a non-fatal failure carries `attempts` for the token estimate. */
  async function complete({ system, user }) {
    if (!completionUrl) completionUrl = await findDeployment();
    const payload = {
      config: {
        modules: {
          prompt_templating: {
            prompt: { template: [{ role: 'system', content: system }] },
            model: { name: model, version: 'latest', params: { max_tokens: 6000 } },
          },
        },
      },
      placeholder_values: {},
      messages_history: [{ role: 'user', content: user }],
    };
    for (let attempt = 1; ; attempt++) {
      const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
      try {
        spend();
      } catch (err) {
        throw Object.assign(err, { attempts: attempt - 1 });
      }
      try {
        const res = await http.post(completionUrl, payload, { headers, timeout: HTTP_TIMEOUT_MS });
        const result = res.data.final_result || {};
        const choice = (result.choices || [])[0] || {};
        return { text: (choice.message && choice.message.content) || '', usage: result.usage, attempts: attempt };
      } catch (err) {
        const status = err.response && err.response.status;
        if (status === 401) token = null;
        const retryable = !status || status === 401 || status === 429 || status >= 500;
        if (!retryable) throw fatal(`completion failed: ${safeMessage(err)}`);
        if (attempt >= RETRIES) {
          throw Object.assign(new Error(`completion failed after ${RETRIES} attempts: ${safeMessage(err)}`), { attempts: attempt });
        }
        const wait = status === 429 ? retryAfterMs(err, now) : undefined;
        await sleep(wait !== undefined ? wait : 2000 * 2 ** (attempt - 1));
      }
    }
  }
  return { complete, stats };
}

module.exports = { createSapClient, safeMessage, retryAfterMs, MAX_RETRY_AFTER_MS };
