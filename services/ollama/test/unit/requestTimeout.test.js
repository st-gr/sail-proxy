/**
 * The non-streaming client to the main proxy waits for the whole completion, so its timeout is
 * the ceiling on any non-streaming answer. A 10 s default failed one-word gpt-4.1-nano answers
 * with a 500 when SAP AI Core took 15 s (private CI 2026-09-30). The default is now two minutes;
 * REQUEST_TIMEOUT still overrides it.
 *
 * The assertions read the timeout out of the axios config on purpose: matching the whole config
 * would print the x-api-key header into a failure message.
 */

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('axios', () => ({ create: jest.fn() }));

const axios = require('axios');

const ENV_KEYS = ['REQUEST_TIMEOUT', 'MAIN_PROXY_API_KEY', 'OPENAI_API_KEY'];
const savedEnv = {};

function loadSharedWith(requestTimeoutEnv) {
  let shared;
  jest.isolateModules(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    if (requestTimeoutEnv !== undefined) {
      process.env.REQUEST_TIMEOUT = requestTimeoutEnv;
    }
    shared = require('../../services/shared');
  });
  return shared;
}

function timeoutGivenToAxios() {
  expect(axios.create).toHaveBeenCalledTimes(1);
  return axios.create.mock.calls[0][0].timeout;
}

describe('non-streaming main-proxy client timeout', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  beforeEach(() => {
    axios.create.mockReset();
    axios.create.mockReturnValue({ post: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }) });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('waits two minutes for a non-streaming completion by default', async () => {
    const shared = loadSharedWith(undefined);
    await shared.callMainProxy('/openai/v1/chat/completions', { model: 'gpt-4.1-nano' });
    expect(timeoutGivenToAxios()).toBe(120000);
  });

  it('honours REQUEST_TIMEOUT', async () => {
    const shared = loadSharedWith('5000');
    await shared.callMainProxy('/openai/v1/chat/completions', { model: 'gpt-4.1-nano' });
    expect(timeoutGivenToAxios()).toBe(5000);
  });
});
