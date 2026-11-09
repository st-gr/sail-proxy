/**
 * modelIdIn/modelIdNotIn build the OData V4 `in` filter for a set of LibraryModels ids, used by
 * Catalogs.controller.ts's member-availability check and the "Add models" / "Exclude models"
 * pickers. Unlike the `modelId eq 'x' or modelId eq 'y' or ...` chain these replace, there is no
 * id-count cap: the whole entitlement or exclusion set travels in one `in (...)` clause.
 */
import { modelIdIn, modelIdNotIn } from '../webapp/model/idFilters';

describe('modelIdIn', () => {
  it('matches nothing for an empty list rather than matching everything', () => {
    expect(modelIdIn([])).toBe("modelId eq '__none__'");
  });
  it('builds a single-id in clause', () => {
    expect(modelIdIn(['m1'])).toBe("modelId in ('m1')");
  });
  it('builds a multi-id in clause, in the given order', () => {
    expect(modelIdIn(['m1', 'm2', 'm3'])).toBe("modelId in ('m1','m2','m3')");
  });
  it('escapes a single quote in an id by doubling it', () => {
    expect(modelIdIn(["o'brien"])).toBe("modelId in ('o''brien')");
  });
  it('has no cap: a large id list is not truncated', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    const filter = modelIdIn(ids);
    expect(filter).toBe(`modelId in (${ids.map((id) => `'${id}'`).join(',')})`);
    expect(filter).toContain("'m249'");
  });
});

describe('modelIdNotIn', () => {
  it('returns undefined for an empty list — nothing to exclude, so no filter is needed', () => {
    expect(modelIdNotIn([])).toBeUndefined();
  });
  it('builds a single-id not-in clause', () => {
    expect(modelIdNotIn(['m1'])).toBe("not (modelId in ('m1'))");
  });
  it('builds a multi-id not-in clause, in the given order', () => {
    expect(modelIdNotIn(['m1', 'm2', 'm3'])).toBe("not (modelId in ('m1','m2','m3'))");
  });
  it('escapes a single quote in an id by doubling it', () => {
    expect(modelIdNotIn(["o'brien"])).toBe("not (modelId in ('o''brien'))");
  });
  it('has no cap: a large id list is not truncated', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    expect(modelIdNotIn(ids)).toBe(`not (modelId in (${ids.map((id) => `'${id}'`).join(',')}))`);
  });
});
