import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const routesDir = path.join(__dirname, '..', 'src', 'routes');

describe('Responses route mounts', () => {
  it('mounts /responses on the OpenRouter router with the same handler as the OpenAI route', () => {
    const openRouter = fs.readFileSync(path.join(routesDir, 'openRouterRoutes.ts'), 'utf-8');

    expect(openRouter).toContain('handleResponses');
    expect(openRouter).toMatch(/router\.post\(\s*['"]\/responses['"]/);
  });

  it('keeps the OpenAI Responses route intact', () => {
    const responses = fs.readFileSync(path.join(routesDir, 'responsesRoutes.ts'), 'utf-8');
    expect(responses).toContain('handleResponses');
  });
});
