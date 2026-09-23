/**
 * Same idea as entitlement-guard-wiring.test.ts: the middleware test proves quotaEnforcement
 * behaves, this pins that every LLM-serving router actually mounts it — and that nothing mounts
 * the retired limiters any more.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const ROUTES = path.join(__dirname, '..', 'src', 'routes');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// file → number of guard positions that must name quotaEnforcement
const EXPECTED: Array<[string, number]> = [
  ['chatRoutes.ts', 1], ['responsesRoutes.ts', 1], ['embeddingRoutes.ts', 1], ['filesRoutes.ts', 1],
  ['vectorStoresRoutes.ts', 1], ['anthropicRoutes.ts', 3], ['awsBedrockRoutes.ts', 1],
  // openRouterRoutes: one guard position per tool-carrying route chain (the router-level mount
  // that covers the remaining endpoints takes no comma and is not counted).
  ['openRouterRoutes.ts', 3],
  ['googleRoutes.ts', 1], ['imagesRoutes.ts', 1]
];

describe('every LLM-serving router mounts quotaEnforcement', () => {
  it.each(EXPECTED)('%s mounts it %i time(s) and nothing else', (file, expected) => {
    const cleaned = stripComments(fs.readFileSync(path.join(ROUTES, file), 'utf8'));
    expect(cleaned).toContain("import quotaEnforcement from '../middlewares/quotaEnforcement';");
    const mounts = [...cleaned.matchAll(/,\s*quotaEnforcement\s*[,\]\)]/g)];
    expect(mounts).toHaveLength(expected);
    expect(cleaned).not.toMatch(/rateLimiter|createUnifiedRateLimitMiddleware/);
  });
  it('the retired limiter is gone', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'middlewares', 'rateLimiter.ts'))).toBe(false);
    const proxy = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'unifiedAuthProxyService.ts'), 'utf8');
    expect(proxy).not.toContain('createUnifiedRateLimitMiddleware');
  });
});
