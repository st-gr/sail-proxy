import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { listExpressRoutes } from '@libs/test-utils';
import { ConfigLoader } from '../../../libs/config';
import { createApp } from '../src/app';

describe('createApp', () => {
  it('mounts routes without listening', async () => {
    const config = new ConfigLoader('gateway').loadConfig();
    const { app } = createApp(config);

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);

    const routes = listExpressRoutes(app).map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain('post /openai/v1/chat/completions');
    expect(routes).toContain('post /anthropic/v1/messages');
  });
});
