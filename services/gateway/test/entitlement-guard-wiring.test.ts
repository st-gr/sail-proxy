/**
 * Task 10 review finding 3: the helper test proves enforceEntitlement behaves, but nothing proved the
 * controllers actually CALL it — a deleted guard line would have left every other suite green.
 *
 * Part (a) pins the call-site count per controller against the source (the same filesystem-scan
 * approach as test/security-event-coverage.test.ts, and for the same reason: a guard that exists only
 * in a helper is not enforcement). Part (b) drives one controller end to end and asserts an
 * unentitled request is refused BEFORE any upstream call is made.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// (a) static wiring: every inference entry point calls the guard
// ---------------------------------------------------------------------------

const CONTROLLERS = path.join(__dirname, '..', 'src', 'controllers');

// Comment-stripping mirrors test/security-event-coverage.test.ts: without it a commented-out or
// "TODO: call enforceEntitlement(...) here" line would count as a live guard.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// One entry per model-resolution point that must refuse an unentitled model.
// openaiController: the --deployed branch and the non-deployed branch of handleChatCompletion.
// responsesController: the requested model, then again after the --deployed sibling swap.
const EXPECTED_CALL_SITES: Array<[string, number]> = [
  ['openaiController.ts', 2],
  ['anthropicController.ts', 1],
  ['responsesController.ts', 2],
  ['awsBedrockController.ts', 1],
  ['embeddingController.ts', 1],
];

describe('every inference controller is wired to the entitlement guard', () => {
  it.each(EXPECTED_CALL_SITES)('%s calls enforceEntitlement %i time(s)', (file, expected) => {
    const src = fs.readFileSync(path.join(CONTROLLERS, file), 'utf8');
    const cleaned = stripComments(src);

    expect(cleaned).toContain("import { enforceEntitlement } from '../utils/modelEntitlement';");

    const calls = [...cleaned.matchAll(/\benforceEntitlement\s*\(/g)];
    expect(calls).toHaveLength(expected);

    // Every call site must short-circuit the request; a guard whose result is discarded is not a guard.
    const guarded = [...cleaned.matchAll(/if\s*\(!enforceEntitlement\([^)]*\)\)\s*return;/g)];
    expect(guarded).toHaveLength(expected);
  });
});

// googleController is the one inference controller that cannot use `enforceEntitlement`:
// that helper writes the OpenAI 403 envelope, and a Gemini client only parses
// `{error:{code,message,status}}`. It composes the same guard out of the three primitives
// instead, so the invariant is pinned against those rather than against the wrapper.
describe('googleController is wired to the entitlement primitives', () => {
  it('reads the block, checks the model, logs the refusal and raises the security event', () => {
    const cleaned = stripComments(fs.readFileSync(path.join(CONTROLLERS, 'googleController.ts'), 'utf8'));
    expect(cleaned).toMatch(/import \{[^}]*\bemitNotEntitled\b[^}]*\bentitlementFromRequest\b[^}]*\bisModelEntitled\b[^}]*\blogEntitlementDecision\b[^}]*\} from '\.\.\/utils\/modelEntitlement';/);
    // Guarded on BOTH the requested and the accounted id (routing can move a request onto a
    // different catalog entry — the /openai/v1/responses parity) and short-circuiting: a check
    // whose result is discarded is not a guard.
    expect(cleaned).toMatch(/\[model, accountedId\]\.find\(\(id\) => !isModelEntitled\(block, id\)\)/);
    expect(cleaned).toMatch(/if\s*\(refusedId !== undefined\)\s*\{/);
    expect(cleaned).toMatch(/logEntitlementDecision\(req, refusedId, false\);/);
    // The SIEM event every other route gets through enforceEntitlement. Refusing silently
    // here would be invisible to every model_not_entitled query.
    expect(cleaned).toMatch(/emitNotEntitled\(req, refusedId, block!\);/);
    expect(cleaned).toMatch(/refuse\(res, 403,/);
    expect(cleaned).not.toContain('respondNotEntitled');
  });
});

// ---------------------------------------------------------------------------
// (b) behavioural round-trip through a real controller
// ---------------------------------------------------------------------------

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const emit = jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: (...a: any[]) => emit(...a) } }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));

// The two upstream calls the controller would make for an entitled model. Both are wrapped in
// arrows so the factories (hoisted above these declarations) resolve them lazily at call time.
const getModelById = jest.fn<any>();
const createEmbedding = jest.fn<any>();
jest.mock('../src/services/modelService', () => ({ __esModule: true, default: { getModelById: (...a: any[]) => getModelById(...a) } }));
jest.mock('../src/services/sapAIService', () => ({ __esModule: true, default: { createEmbedding: (...a: any[]) => createEmbedding(...a) } }));

import { handleEmbedding } from '../src/controllers/embeddingController';

describe('embeddingController refuses an unentitled model before calling upstream', () => {
  beforeEach(() => {
    emit.mockClear();
    getModelById.mockClear();
    createEmbedding.mockClear();
  });

  function fakeReq(model: string, include: string[]): any {
    return {
      body: { input: 'hello world', model },
      unifiedAuth: { authType: 'api_key', data: { entitlement: { mode: 'list', include, catalogId: 'c', catalogName: 'T' }, keyId: 'k1' } },
      originalUrl: '/v1/embeddings', method: 'POST', headers: {}, socket: { remoteAddress: '203.0.113.7' },
      ip: '203.0.113.7', get: () => 'jest'
    };
  }

  function fakeRes(): any {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  it('403s an empty-list catalog and never reaches modelService or sapAIService', async () => {
    const res = fakeRes();
    const next = jest.fn();

    await handleEmbedding(fakeReq('text-embedding-3-large', []) as any, res, next as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        type: 'model_not_entitled',
        message: expect.stringContaining('text-embedding-3-large'),
        model: 'text-embedding-3-large',
        catalog: 'T'
      }
    });
    // The point of guarding before the model lookup: no upstream work for a refused request.
    expect(getModelById).not.toHaveBeenCalled();
    expect(createEmbedding).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'k1', authType: 'api_key', model: 'text-embedding-3-large', catalog: 'T', endpoint: '/v1/embeddings'
    }));
  });

  it('lets an entitled model through to the model lookup', async () => {
    const res = fakeRes();
    // Fail the lookup straight away: this test only cares that the guard did not stop the request.
    getModelById.mockRejectedValue(new Error('not found'));

    await handleEmbedding(fakeReq('text-embedding-3-large', ['text-embedding-3-large']) as any, res, jest.fn() as any);

    expect(getModelById).toHaveBeenCalledWith('text-embedding-3-large');
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(emit).not.toHaveBeenCalled();
  });
});
