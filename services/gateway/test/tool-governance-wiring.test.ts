import fs from 'fs';
import path from 'path';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

describe('tool governance wiring', () => {
  it('every REST family router mounts the middleware after service auth and before quota enforcement', () => {
    for (const [file, adapter] of [
      ['routes/anthropicRoutes.ts', 'anthropicAdapter'], ['routes/chatRoutes.ts', 'openaiChatAdapter'],
      ['routes/responsesRoutes.ts', 'responsesAdapter'], ['routes/googleRoutes.ts', 'geminiAdapter']
    ] as const) {
      const text = src(file);
      const mount = text.indexOf(`toolGovernance(${adapter})`);
      expect(mount).toBeGreaterThan(-1);
      expect(text.indexOf('ServiceAuth', 0)).toBeLessThan(mount);
      expect(text.indexOf('quotaEnforcement', mount)).toBeGreaterThan(mount);
    }
  });
  it('the OpenRouter router governs its three tool-carrying paths, after service auth and before quota enforcement', () => {
    const text = src('routes/openRouterRoutes.ts');
    const auth = text.indexOf('router.use(openRouterAuth, openRouterServiceAuth)');
    expect(auth).toBeGreaterThan(-1);
    for (const [path, adapter] of [
      ['/chat/completions', 'openaiChatAdapter'], ['/completions', 'openaiChatAdapter'], ['/responses', 'responsesAdapter']
    ] as const) {
      const mount = text.indexOf(`router.post('${path}', toolGovernance(${adapter}), quotaEnforcement,`);
      expect(mount).toBeGreaterThan(-1);
      expect(auth).toBeLessThan(mount);
      expect(text.indexOf('quotaEnforcement', mount)).toBeGreaterThan(mount);
    }
  });
  it('every controller records invoked tools at its usage sites', () => {
    expect((src('controllers/anthropicController.ts').match(/recordInvokedTools\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((src('controllers/openaiController.ts').match(/recordInvokedTools\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((src('controllers/responsesController.ts').match(/recordInvokedTools\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src('controllers/googleDispatch.ts').match(/recordInvokedTools\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it('the usage event carries the tools fold', () => {
    expect(src('utils/usageTracker.ts')).toContain('tools: toolsForEvent(req)');
  });
  it('the Bedrock router governs tools after both authentications and before quota enforcement', () => {
    const text = src('routes/awsBedrockRoutes.ts');
    const mount = text.indexOf('toolGovernance(bedrockAdapter)');
    expect(mount).toBeGreaterThan(-1);
    expect(text.indexOf('conditionalUnifiedAuth')).toBeLessThan(mount);
    expect(text.indexOf('bedrockServiceAuth')).toBeLessThan(mount);
    expect(text.indexOf('quotaEnforcement', mount)).toBeGreaterThan(mount);
  });
  it('the Bedrock controller records invoked tools for complete and streamed responses', () => {
    const text = src('controllers/awsBedrockController.ts');
    expect(text).toContain('recordInvokedTools(req, bedrockAdapter.invokedTools(');
    expect(text).toContain('tapStreamedTools(req, res, bedrockAdapter)');
    expect(text).not.toMatch(/rawBody/);
  });
});
