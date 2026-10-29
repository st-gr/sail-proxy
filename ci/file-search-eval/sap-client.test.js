#!/usr/bin/env node
/**
 * Tests the question generator's SAP client with a fake HTTP layer and a fake clock: credential
 * failures stop the run at once, every HTTP attempt counts against the request cap, Retry-After is
 * honoured within its bound, missing usage is charged as an estimate, and error messages carry no
 * free text. No network.
 */
const assert = require('assert');
const { createSapClient, safeMessage, retryAfterMs, MAX_RETRY_AFTER_MS } = require('./sap-client');
const { generateQuestionSet, estimateTokens } = require('./question-set');

const ENV = { AUTH_URL: 'https://auth.invalid/oauth/token', CLIENT_ID: 'id', CLIENT_SECRET: 'secret', SAP_AI_CORE_URL: 'https://core.invalid' };
const FACT = 'The beta worker flushes its queue every thirty seconds by default.';
const docs = [{ file: 'pdf/b.pdf', kind: 'pdf', text: FACT }];
const mix = { markdown: 0, pdf: 1, table: 0, scanned: 0, multihop: 0 };
const httpError = (status, data, headers = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers } });
const answer = (usage) => ({ data: { final_result: { choices: [{ message: { content: JSON.stringify({ questions: [{ question: 'How often does the beta worker empty its queue?', quotes: [FACT] }] }) } }], usage } } });

/** completions: list of results (an Error to reject, an object to resolve) for successive completion POSTs. */
function fakeHttp({ token = () => ({ data: { access_token: 'tok', expires_in: 3600 } }), completions = [] } = {}) {
  const log = [];
  const next = [...completions];
  return {
    log,
    async post(url) {
      if (url === ENV.AUTH_URL) {
        log.push('token');
        const r = token();
        if (r instanceof Error) throw r;
        return r;
      }
      log.push('completion');
      const r = next.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    async get() {
      log.push('deployments');
      return { data: { resources: [
        { id: 'old', status: 'RUNNING', scenarioId: 'orchestration', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'new', status: 'RUNNING', scenarioId: 'orchestration', createdAt: '2026-06-01T00:00:00Z' },
        { id: 'x', status: 'STOPPED', scenarioId: 'orchestration', createdAt: '2026-09-01T00:00:00Z' },
      ] } };
    },
  };
}
const fakeClock = () => {
  const c = { t: Date.parse('2026-10-08T00:00:00Z'), sleeps: [] };
  c.now = () => c.t;
  c.sleep = async ms => { c.sleeps.push(ms); c.t += ms; };
  return c;
};

(async () => {
  // safeMessage: status plus a short code, never free text or headers.
  const tokenErr = httpError(401, { error: 'invalid_client', error_description: 'Bad credentials for client id' });
  assert.strictEqual(safeMessage(tokenErr), 'HTTP 401 invalid_client');
  assert.strictEqual(safeMessage(httpError(400, { error: { code: 400, message: 'Template has {{?x}} with secret' } })), 'HTTP 400 400');
  assert.strictEqual(safeMessage(httpError(502, '<html>Bad gateway on some.host</html>')), 'HTTP 502');
  assert.strictEqual(safeMessage(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  assert.strictEqual(safeMessage(new Error('socket hang up near 10.0.0.1')), 'network error');

  // Retry-After: seconds, HTTP date, bounded, absent.
  const clock = fakeClock();
  assert.strictEqual(retryAfterMs(httpError(429, {}, { 'retry-after': '7' }), clock.now), 7000);
  assert.strictEqual(retryAfterMs(httpError(429, {}, { 'retry-after': '120' }), clock.now), MAX_RETRY_AFTER_MS);
  assert.strictEqual(retryAfterMs(httpError(429, {}, { 'retry-after': new Date(clock.t + 4000).toUTCString() }), clock.now), 4000);
  assert.strictEqual(retryAfterMs(httpError(429, {}), clock.now), undefined);

  // A failed token request is fatal at once: one token request, nothing else, no retries.
  {
    const http = fakeHttp({ token: () => tokenErr });
    const c = fakeClock();
    const llm = createSapClient(ENV, 'gpt-4.1', { http, maxRequests: 50, sleep: c.sleep, now: c.now });
    await assert.rejects(generateQuestionSet({ docs, mix, llm, maxCalls: 50, maxTokens: 1e9 }), err => {
      assert(err.fatal && /token request failed: HTTP 401 invalid_client$/.test(err.message), err.message);
      return true;
    });
    assert.deepStrictEqual(http.log, ['token']);
    assert.deepStrictEqual(c.sleeps, []);
  }

  // Every HTTP attempt counts: token + deployments + two 503s spend a cap of 4, the run stops there.
  {
    const http = fakeHttp({ completions: [httpError(503, {}), httpError(503, {}), answer({ prompt_tokens: 10, completion_tokens: 5 })] });
    const c = fakeClock();
    const llm = createSapClient(ENV, 'gpt-4.1', { http, maxRequests: 4, sleep: c.sleep, now: c.now });
    const run = await generateQuestionSet({ docs, mix, llm, maxCalls: 50, maxTokens: 1e9 });
    assert.deepStrictEqual(http.log, ['token', 'deployments', 'completion', 'completion']);
    assert.strictEqual(llm.stats.requests, 4);
    assert.strictEqual(run.stats.stopped, 'max-calls');
    assert.deepStrictEqual(c.sleeps, [2000, 4000], 'exponential back-off between 5xx retries');
    assert(run.stats.estimatedTokens > 0 && run.stats.promptTokens === run.stats.estimatedTokens, 'the two failed attempts are charged');
  }

  // 429 with Retry-After waits that long (fake clock), then succeeds; the newest RUNNING deployment is used.
  {
    const http = fakeHttp({ completions: [httpError(429, {}, { 'retry-after': '9' }), answer({ prompt_tokens: 10, completion_tokens: 5 })] });
    const urls = [];
    const post = http.post;
    http.post = async (url, ...rest) => { urls.push(url); return post(url, ...rest); };
    const c = fakeClock();
    const llm = createSapClient(ENV, 'gpt-4.1', { http, maxRequests: 10, sleep: c.sleep, now: c.now });
    const run = await generateQuestionSet({ docs, mix, llm, maxCalls: 10, maxTokens: 1e9 });
    assert.deepStrictEqual(c.sleeps, [9000]);
    assert.strictEqual(run.questions.length, 1);
    assert(urls.includes('https://core.invalid/v2/inference/deployments/new/v2/completion'));
    assert.strictEqual(run.stats.completionTokens, 5, 'reported usage is used');
    assert(run.stats.promptTokens > 10, 'the 429 attempt is charged with an estimate on top');
  }

  // A response without usage is charged with an estimate, so --max-tokens still holds.
  {
    const http = fakeHttp({ completions: [answer(undefined)] });
    const llm = createSapClient(ENV, 'gpt-4.1', { http, maxRequests: 10, sleep: async () => {} });
    const run = await generateQuestionSet({ docs, mix, llm, maxCalls: 10, maxTokens: 1e9 });
    assert(run.stats.promptTokens > 0 && run.stats.completionTokens > 0, 'estimated, not 0');
    assert.strictEqual(run.stats.estimatedTokens, run.stats.promptTokens + run.stats.completionTokens);
    assert.strictEqual(run.stats.completionTokens, estimateTokens(answer().data.final_result.choices[0].message.content));
  }

  // Another 4xx on a completion is fatal without retries.
  {
    const http = fakeHttp({ completions: [httpError(400, { error: { code: 'invalid_model' } })] });
    const c = fakeClock();
    const llm = createSapClient(ENV, 'gpt-4.1', { http, maxRequests: 10, sleep: c.sleep, now: c.now });
    await assert.rejects(generateQuestionSet({ docs, mix, llm, maxCalls: 10, maxTokens: 1e9 }), /completion failed: HTTP 400 invalid_model$/);
    assert.deepStrictEqual(c.sleeps, []);
  }

  assert.throws(() => createSapClient({ ...ENV, CLIENT_SECRET: '' }, 'gpt-4.1', { http: fakeHttp(), maxRequests: 1 }), /CLIENT_SECRET is missing/);
  console.log('file-search-eval SAP client: fatal credentials, request cap, Retry-After, usage estimate - OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
