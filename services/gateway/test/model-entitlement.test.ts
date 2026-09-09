/**
 * Entitlement block semantics on the gateway side (spec section 5): absent block = unrestricted;
 * mode 'all' excludes; mode 'list' includes; filtering never mutates the input.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { entitlementFromRequest, isModelEntitled, filterModels, respondNotEntitled } from '../src/utils/modelEntitlement';
import type { EntitlementBlock } from '../src/clients/adminServiceClient';

const all: EntitlementBlock = { catalogId: 'd', catalogName: 'Default', mode: 'all' };
const allMinus: EntitlementBlock = { ...all, exclude: ['gpt-5.4', 'gpt-5.4--deployed'] };
const list: EntitlementBlock = { catalogId: 'c', catalogName: 'Team', mode: 'list', include: ['anthropic--claude-4.5-haiku'] };

describe('isModelEntitled', () => {
  it('null block is unrestricted', () => expect(isModelEntitled(null, 'anything')).toBe(true));
  it('mode all without exclusions admits everything', () => expect(isModelEntitled(all, 'gpt-5.4')).toBe(true));
  it('mode all with exclusions refuses the excluded ids only', () => {
    expect(isModelEntitled(allMinus, 'gpt-5.4')).toBe(false);
    expect(isModelEntitled(allMinus, 'gpt-5.4--deployed')).toBe(false);
    expect(isModelEntitled(allMinus, 'gpt-5-mini')).toBe(true);
  });
  it('mode list admits only the included ids', () => {
    expect(isModelEntitled(list, 'anthropic--claude-4.5-haiku')).toBe(true);
    expect(isModelEntitled(list, 'anthropic--claude-4.5-haiku--deployed')).toBe(false);
  });
  it('an empty list admits nothing', () => expect(isModelEntitled({ ...list, include: [] }, 'x')).toBe(false));
});

describe('filterModels', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('returns the same array content for null / all', () => {
    expect(filterModels(null, models)).toEqual(models);
    expect(filterModels(all, models)).toEqual(models);
  });
  it('filters by exclusion and inclusion', () => {
    expect(filterModels({ ...all, exclude: ['b'] }, models).map(m => m.id)).toEqual(['a', 'c']);
    expect(filterModels({ ...list, include: ['c', 'zzz'] }, models).map(m => m.id)).toEqual(['c']);
    expect(models).toHaveLength(3);
  });
});

describe('entitlementFromRequest', () => {
  it('prefers unifiedAuth, then apiKeyInfo, then apiKeyInfo.metadata, then awsAuth', () => {
    // entitlementFromRequest returns a normalised copy, not the original object, so these
    // compare by value rather than by reference.
    expect(entitlementFromRequest({ unifiedAuth: { data: { entitlement: list } }, apiKeyInfo: { entitlement: all } })).toEqual(list);
    expect(entitlementFromRequest({ apiKeyInfo: { entitlement: all } })).toEqual(all);
    expect(entitlementFromRequest({ apiKeyInfo: { metadata: { entitlement: allMinus } } })).toEqual(allMinus);
    expect(entitlementFromRequest({ awsAuth: { entitlement: list } })).toEqual(list);
    expect(entitlementFromRequest({})).toBeNull();
    expect(entitlementFromRequest({ unifiedAuth: { data: { entitlement: { mode: 'weird' } } } })).toBeNull();
  });

  it('normalises a non-array include to empty, failing closed for a list block', () => {
    const block = entitlementFromRequest({ apiKeyInfo: { entitlement: { catalogId: 'c', catalogName: 'C', mode: 'list', include: 'gpt-5.4' } } })!;
    expect(isModelEntitled(block, 'gpt-5.4')).toBe(false);
    expect(isModelEntitled(block, 'gpt')).toBe(false);
  });

  it('normalises a non-array exclude to omitted, falling back to "all" semantics', () => {
    const block = entitlementFromRequest({ apiKeyInfo: { entitlement: { catalogId: 'd', catalogName: 'Default', mode: 'all', exclude: 42 } } })!;
    expect(isModelEntitled(block, 'anything')).toBe(true);
  });

  it('filters a mixed include array down to its string entries', () => {
    const block = entitlementFromRequest({ apiKeyInfo: { entitlement: { catalogId: 'c', catalogName: 'C', mode: 'list', include: ['a', 7, null, 'b'] } } })!;
    expect(isModelEntitled(block, 'a')).toBe(true);
    expect(isModelEntitled(block, 'b')).toBe(true);
    expect(isModelEntitled(block, '7')).toBe(false);
  });
});

describe('respondNotEntitled', () => {
  it('sends a 403 with the model_not_entitled body', () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const block: EntitlementBlock = { catalogId: 'd', catalogName: 'Default', mode: 'all', exclude: ['m'] };
    respondNotEntitled(res, 'm', block);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        type: 'model_not_entitled',
        message: expect.stringContaining('m'),
        model: 'm',
        catalog: block.catalogName
      }
    });
  });
});
