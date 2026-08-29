import Ajv from 'ajv';
import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { API_CONFIG_GROUPS, ApiConfigGroup, groupSections } from '../webapp/model/apiConfigGroups';
import { applyDescriptor, buildDescriptors, Descriptor, TABLE_CELL_KINDS } from '../webapp/model/schemaForm';
import { pluginFor } from '../webapp/model/formPlugins';
import { validateSection } from '../webapp/model/validateSection';
import { wrapAt } from './helpers/wrapAt';

const shipped = require('../../../../gateway/api_config.json').api_config;

/**
 * The shared "is this section actually deepened" gate every schema-deepening task (3-9) registers
 * against: it loads the real shipped section, builds its descriptor tree, writes every leaf
 * descriptor's own (unedited) value back onto a fresh clone via `applyDescriptor`, and asserts the
 * result is byte-identical to the original. That alone would pass for a thin schema too - an
 * `additionalProperties:false`-less object with no `properties` still round-trips, because
 * `buildDescriptors` degrades an unrecognized key to a `raw` descriptor that carries the untouched
 * JSON blob rather than dropping it. The second assertion is what actually distinguishes "thin" from
 * "deepened": a `raw` descriptor anywhere in the tree means some part of the shipped data was not
 * understood as a typed field, so the round trip proves nothing about whether the schema describes
 * the section - it fails for a thin schema and passes only once every field the shipped data
 * actually populates is a real, typed descriptor.
 *
 * The third assertion closes the blind spot the second one had: it reads descriptor KINDS, and
 * `table` is a typed kind, so a table whose cells no control can render passed a gate that was
 * meant to mean "an operator can see this". `hooks.defaults` shipped in exactly that state for one
 * commit. See `unhostableCells`.
 *
 * `group`/`section` are plain strings, not `ApiConfigGroup`, because a later task registering a
 * section this file has never heard of should get "shipped config has no X.Y" (a clear, actionable
 * failure) rather than a compile error naming this file.
 *
 * `opts.openMap`: a section may deliberately accept keys its schema does not declare at all -
 * `$defs/modelOverride` keeps `additionalProperties: true` because the merge that consumes it
 * (modelService.ts:434-438) copies every key it does not handle itself straight onto the model
 * object, so an undeclared key is passed through rather than ignored, and the schema must not
 * pretend to know it. Those keys cannot be held to the raw-free half of this gate: nothing
 * describes them, `buildChildren` degrades them to `raw` by design, and a JSON blob is the correct
 * rendering for a value the schema cannot type - not a defect the gate should report. Passing
 * `openMap: true` tolerates exactly those raws, the ones carrying `buildChildren`'s undeclared-key
 * reason, and nothing else: a raw for a key the schema DOES declare - a type mismatch, an
 * unsupported schema shape, a field that does not belong to its array variant - still fails the
 * gate, and the byte-identical round-trip assertion above stays unconditional either way. See
 * `unexplainedRaws`.
 *
 * This is NOT an allowance for dynamically-keyed maps. A schema-valued `additionalProperties` -
 * `models.overrides`' per-model entries, `providers`' per-provider entries, `param_renames`'
 * per-parameter strings - does build real typed descriptors (`buildChildren`'s third and last
 * matching step), so such a map is held to the full gate like any other section. Only the boolean
 * `additionalProperties: true` declares nothing at all, and `openMap` is for that alone.
 *
 * Only a descriptor whose pointer resolves to a key `data` already has is written back. This
 * matches the real form: `_document` mutates only inside `_applyChange` (Main.controller.ts),
 * reachable only from a control's own change event - rendering never writes back, so an untouched
 * control bound to a key the document never had is never the reason a save adds that key. A
 * genuinely-absent-but-typed optional leaf (e.g. observability.pseudonymization's
 * `enabled`/`method`/`allow_user_bypass` - force-activation lives one layer down, under
 * hooks.defaults/models.overrides) still gets a real, typed descriptor built from `undefined`
 * data, exactly as `schemaForm.test.ts`'s "leaves an optional field ... empty" test requires -
 * that descriptor is simply excluded from the write-back here, the same way an unedited control
 * never fires a change event. The rendered value itself (e.g. a `select`'s `schema.default`
 * fallback for a missing enum) is asserted separately, without touching this assertion - see the
 * dedicated test below the observability round trip.
 */
export function roundTrips(group: string, section: string, opts?: { openMap?: boolean }): void {
  it(`${group}.${section} round-trips byte-identically`, () => {
    const data = (shipped as any)[group]?.[section];
    if (data === undefined) {
      throw new Error(`shipped config has no ${group}.${section}`);
    }
    const { pointer, schema: sectionSchema } = resolveSection(group, section);
    const ds = buildDescriptors(sectionSchema, data, pointer, pluginFor);
    let out: unknown = wrapAt(pointer, JSON.parse(JSON.stringify(data)));
    for (const d of flatten(ds)) {
      if ('value' in d && pointerResolvesToPresentKey(data, d.pointer)) {
        out = applyDescriptor(out, d.pointer, (d as { value: unknown }).value);
      }
    }
    expect(out).toEqual(wrapAt(pointer, data));
    // The deepened gate: nothing degrades. See this module's header.
    expect(unexplainedRaws(ds, opts?.openMap)).toEqual([]);
    // ... and nothing degrades one layer further in, inside a table's cells. See `unhostableCells`.
    expect(unhostableCells(ds)).toEqual([]);
  });
}

/**
 * Table cells no control can render, as pointer + kind pairs.
 *
 * The raw-free assertion above reads descriptor KINDS, and a `table` is a typed kind - so a table
 * whose cells are `section`s passed the gate while every one of those cells rendered the placeholder
 * "This value cannot be shown in the form. Use the JSON editor." (`descriptorControls.ts`'s
 * `buildField` has no case for `section` or `table`, so both fall to its default). That is what
 * `hooks.defaults.<endpoint>.<subpath>` shipped as after the schema was deepened: no raws anywhere,
 * a green gate, and an operator still unable to see a single hook. The gate was blind one layer
 * below the kind it checked.
 *
 * Held to `TABLE_CELL_KINDS`, imported from the renderer rather than restated here, so the list the
 * renderer decides tables with and the list this gate measures them against cannot drift apart.
 *
 * Reported as `{pointer, kind}` rather than whole descriptors so a failure names the column that
 * cannot be shown instead of printing its entire subtree.
 */
function unhostableCells(descriptors: Descriptor[]): Array<{ pointer: string; kind: string }> {
  const out: Array<{ pointer: string; kind: string }> = [];
  for (const d of flatten(descriptors)) {
    if (d.kind !== 'table') {
      continue;
    }
    for (const row of d.rows) {
      for (const cell of row) {
        if (TABLE_CELL_KINDS.indexOf(cell.kind) === -1) {
          out.push({ pointer: cell.pointer, kind: cell.kind });
        }
      }
    }
  }
  return out;
}

/**
 * The opening of the reason `buildChildren` gives a `raw` descriptor it emits for a data key
 * NOTHING in the schema declares - `properties`, `patternProperties` and a schema-valued
 * `additionalProperties` all missed it, so the key fell through to the raw path (schemaForm.ts's
 * `unknownReason` default). Every other raw reason names a key the schema does declare and could
 * not render.
 *
 * Matched as a string rather than imported because `unknownReason` is a default parameter, not an
 * export. The coupling fails safe: if that wording ever changes, an undeclared key stops being
 * recognised here and `openMap` starts FAILING the gate - it cannot start passing one silently.
 */
const UNDECLARED_KEY_REASON = 'No schema defines property "';

/**
 * The raws that count against the gate: every `raw` descriptor in the tree, minus - when
 * `openMap` is set - the ones that exist only because the schema deliberately declares nothing for
 * that key. Shared by `roundTrips` and by the tests that prove this distinction is real, so those
 * tests exercise the gate's own predicate rather than a second copy of it.
 */
function unexplainedRaws(descriptors: Descriptor[], openMap?: boolean): Descriptor[] {
  return flatten(descriptors).filter(
    d => d.kind === 'raw' && !(openMap === true && d.reason.indexOf(UNDECLARED_KEY_REASON) === 0)
  );
}

/** Every descriptor in a tree, depth-first - `section` children and `table` rows included. */
function flatten(descriptors: Descriptor[]): Descriptor[] {
  const out: Descriptor[] = [];
  for (const d of descriptors) {
    out.push(d);
    if (d.kind === 'section') {
      out.push(...flatten(d.children));
    } else if (d.kind === 'table') {
      for (const row of d.rows) {
        out.push(...flatten(row));
      }
    }
  }
  return out;
}

/**
 * Whether `pointer` resolves to a key `data` actually has.
 *
 * `pointer` is absolute - `/api_config/<group>/<section>/...`, what the form addresses a control by
 * - while `data` here is the SECTION's own value, so the two are rebased before they can be
 * compared: the first suffix of the pointer that resolves inside `data` is the path into it.
 * `applyDescriptor` needs no such step and does no such search; it is anchored at the document root
 * and is handed the whole wrapped document (`wrapAt`), which is exactly why this rebasing lives
 * here, in the one place that holds a section apart from its document, rather than in the writer.
 *
 * The RFC 6901 unescaping is mirrored rather than imported because `applyDescriptor`'s own
 * segment-walk internals (`splitPointer`/`unescapeSegment`) are not exported.
 */
function pointerResolvesToPresentKey(data: unknown, pointer: string): boolean {
  const segments = pointer
    .split('/')
    .filter(s => s.length > 0)
    .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0) return false;

  for (let start = 0; start < segments.length; start++) {
    const path = segments.slice(start);
    let cursor: unknown = data;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      if (cursor !== null && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, path[i])) {
        cursor = (cursor as Record<string, unknown>)[path[i]];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cursor !== null && typeof cursor === 'object') {
      return Object.prototype.hasOwnProperty.call(cursor, path[path.length - 1]);
    }
  }
  return false;
}

/**
 * `group.section`'s own schema, `$ref`-resolved, and the pointer `buildDescriptors`/
 * `validateSection` address it at - `apiConfigGroups.ts`'s `groupSections`, the exact function
 * `ConfigFormTabs.buildTab` itself calls, reused rather than re-derived here (the pointer-template/
 * `resolveRef` duplication Task 2's own review caught once already - see that file's header).
 */
function resolveSection(group: string, section: string): { pointer: string; schema: object } {
  const found = groupSections(apiConfigSchema, group as ApiConfigGroup).find(s => s.key === section);
  if (!found) {
    throw new Error(`schema has no ${group}.${section} section`);
  }
  return { pointer: found.pointer, schema: found.schema as object };
}

/** A fresh, independently-mutable copy of one shipped section, for a negative test to corrupt. */
function shippedSection(group: string, section: string): any {
  return JSON.parse(JSON.stringify((shipped as any)[group][section]));
}

describe('platform section round trips', () => {
  roundTrips('platform', 'timeouts');
  roundTrips('platform', 'logging');
  roundTrips('platform', 'rate_limit_handling');
  roundTrips('platform', 'security');
});

describe('platform.timeouts - constraints getTimeout does not itself enforce', () => {
  it('rejects a negative default timeout', () => {
    const { pointer, schema } = resolveSection('platform', 'timeouts');
    const data = { ...shippedSection('platform', 'timeouts'), default: -1000 };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('default');
  });
});

describe('platform.logging - defaultLevel matches what the logger accepts, not the shipped instance', () => {
  it('rejects a lowercase level - the historical fallback-config defect', () => {
    const { pointer, schema } = resolveSection('platform', 'logging');
    const data = { ...shippedSection('platform', 'logging'), defaultLevel: 'info' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('defaultLevel');
  });

  // libs/logger's LOG_LEVELS is {error, warn, info, debug, trace} only - no 'fatal' - so a
  // component or defaultLevel value of "FATAL" is accepted by neither `isLevelEnabled` nor
  // `loadConfigurationFromFile`'s enum membership check; it is silently ignored, not applied. The
  // schema must not offer an operator a value the logger will quietly drop.
  it('rejects FATAL - the logger does not implement that level', () => {
    const { pointer, schema } = resolveSection('platform', 'logging');
    const data = { ...shippedSection('platform', 'logging'), defaultLevel: 'FATAL' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('defaultLevel');
  });
});

describe('platform.security - trust_forwarded_for is read as a strict boolean', () => {
  it('rejects a non-boolean trust_forwarded_for', () => {
    const { pointer, schema } = resolveSection('platform', 'security');
    const data = { ...shippedSection('platform', 'security'), trust_forwarded_for: 'yes' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('trust_forwarded_for');
  });
});

describe('platform.* - every section is closed (additionalProperties: false)', () => {
  it.each(['timeouts', 'logging', 'rate_limit_handling', 'security'])(
    'rejects an unknown key under platform.%s',
    section => {
      const { pointer, schema } = resolveSection('platform', section);
      const data = { ...shippedSection('platform', section), not_a_real_key: true };
      const errors = validateSection(schema, data, pointer);
      expect(errors.length).toBeGreaterThan(0);
    }
  );
});

describe('capabilities section round trips', () => {
  roundTrips('capabilities', 'web_search');
  roundTrips('capabilities', 'hosted_tools');
  roundTrips('capabilities', 'namespace_tools');
  roundTrips('capabilities', 'custom_tools');
  roundTrips('capabilities', 'tool_search');
  roundTrips('capabilities', 'file_search');
});

describe('capabilities.web_search - resolveMaxWebSearches bounds', () => {
  it('rejects a max_searches_per_request above the 10 the guard allows', () => {
    const { pointer, schema } = resolveSection('capabilities', 'web_search');
    const data = { ...shippedSection('capabilities', 'web_search'), max_searches_per_request: 11 };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('max_searches_per_request');
  });
});

describe('capabilities.hosted_tools - resultCacheConfig guard minima', () => {
  it('rejects a result_cache_ttl_seconds below the 60s the guard allows', () => {
    const { pointer, schema } = resolveSection('capabilities', 'hosted_tools');
    const data = { ...shippedSection('capabilities', 'hosted_tools'), result_cache_ttl_seconds: 59 };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('result_cache_ttl_seconds');
  });

  it('rejects a result_cache_max_entries below the 10 the guard allows', () => {
    const { pointer, schema } = resolveSection('capabilities', 'hosted_tools');
    const data = { ...shippedSection('capabilities', 'hosted_tools'), result_cache_max_entries: 9 };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('result_cache_max_entries');
  });
});

describe('capabilities.namespace_tools - mode matches NamespaceToolMode', () => {
  it('rejects a mode resolveNamespaceToolMode does not accept', () => {
    const { pointer, schema } = resolveSection('capabilities', 'namespace_tools');
    const data = { ...shippedSection('capabilities', 'namespace_tools'), mode: 'drop' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('mode');
  });
});

describe('capabilities.custom_tools - mode matches CustomToolMode', () => {
  it('rejects a mode resolveCustomToolMode does not accept', () => {
    const { pointer, schema } = resolveSection('capabilities', 'custom_tools');
    const data = { ...shippedSection('capabilities', 'custom_tools'), mode: 'passthrough' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('mode');
  });
});

describe('capabilities.tool_search - mode matches ToolSearchMode, hoist_discovered_tools is a strict boolean', () => {
  it('rejects a mode resolveToolSearchMode does not accept', () => {
    const { pointer, schema } = resolveSection('capabilities', 'tool_search');
    const data = { ...shippedSection('capabilities', 'tool_search'), mode: 'passthrough' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('mode');
  });

  it('rejects a non-boolean hoist_discovered_tools', () => {
    const { pointer, schema } = resolveSection('capabilities', 'tool_search');
    const data = { ...shippedSection('capabilities', 'tool_search'), hoist_discovered_tools: 'false' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('hoist_discovered_tools');
  });
});

// hybrid.rerank.enabled is the one tri-state in this document, and it used to be written as a
// `oneOf` - a keyword `validateSection.ts` has no implementation for at all, so the gate accepted
// ANY value there (fail-open) while the renderer, which has no `oneOf` rule either, degraded the
// whole field to a JSON blob. It is now `type: ["boolean","string"]` with `enum: [true,false,"auto"]`,
// which both of them do implement, and which Ajv reads identically - see the parity test below.
describe('capabilities.file_search - hybrid.rerank.enabled is the tri-state reranker.ts switches on', () => {
  const rerank = (enabled: unknown) => {
    const data = shippedSection('capabilities', 'file_search');
    data.hybrid.rerank.enabled = enabled;
    return data;
  };

  it.each([[true], [false], ['auto']])('accepts %p - all three are real modes', enabled => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    expect(validateSection(schema, rerank(enabled), pointer)).toEqual([]);
  });

  // "always"/"required"/"on" are the plausible spellings of `true`, and every one of them would
  // read as neither `=== true` nor `=== false` in reranker.ts - i.e. silently as "auto", the
  // opposite of the "fail loudly" the operator was asking for.
  it.each([['always'], ['on'], ['true']])('rejects the string %p - only "auto" is a string mode', enabled => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const errors = validateSection(schema, rerank(enabled), pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('rerank/enabled');
  });

  it('rejects a number - neither of the two declared types', () => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const errors = validateSection(schema, rerank(1), pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('rerank/enabled');
  });

  // The half that matters most: a mixed-type `enum` over a union `type` is the combination the
  // browser gate had never been asked for, so its verdict is measured against the backend's own
  // Ajv instance rather than assumed - the same shape the `not` parity test above takes.
  it('agrees with the backend Ajv instance on every one of those probes', () => {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema)));

    for (const accepted of [true, false, 'auto']) {
      expect(validate(rerank(accepted))).toBe(true);
      expect(validateSection(schema, rerank(accepted), pointer)).toEqual([]);
    }
    for (const rejected of ['always', 'on', 'true', 1, null]) {
      expect(validate(rerank(rejected))).toBe(false);
      expect(validateSection(schema, rerank(rejected), pointer).length).toBeGreaterThan(0);
    }
  });

  // What the operator sees, and what a save would write back. `options` are the Select's keys, so
  // they are text; `optionValues` is what makes the chosen key a boolean again on the way out.
  it('renders as a select over all three modes, with the booleans still booleans', () => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const enabledPointer = '/api_config/capabilities/file_search/hybrid/rerank/enabled';

    const shippedDescriptor = flatten(buildDescriptors(schema, shippedSection('capabilities', 'file_search'), pointer, pluginFor))
      .find(d => d.pointer === enabledPointer);
    expect(shippedDescriptor).toMatchObject({
      kind: 'select',
      value: 'auto',
      options: ['true', 'false', 'auto'],
      optionValues: [true, false, 'auto']
    });

    // No cast: `value` is typed to hold the member it read, so the compiler carries this too.
    const off = flatten(buildDescriptors(schema, rerank(false), pointer, pluginFor))
      .find(d => d.pointer === enabledPointer);
    if (off?.kind !== 'select') {
      throw new Error(`expected a select at ${enabledPointer}, got ${off?.kind}`);
    }
    expect(off.value).toBe(false);
  });
});

// Every clamp in this section is applied by a resolver that WARNS and substitutes rather than
// failing, so an out-of-range value is a setting the operator believes is in force and is not. The
// schema is the only place it can be refused while it can still be corrected.
describe('capabilities.file_search - the ranges the resolvers silently override', () => {
  const withField = (path: string[], value: unknown) => {
    const data = shippedSection('capabilities', 'file_search');
    let cursor = data;
    for (const key of path.slice(0, -1)) {
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
    return data;
  };

  it.each([
    // resolveMaxRetries: a negative count is not "fewer retries", it is unset - the default returns.
    [['ingestion', 'max_retries'], -1, 'max_retries'],
    [['ingestion', 'max_retries'], 1.5, 'max_retries'],
    // resolveMaxConcurrentWrites clamps to the 10-connection file_search pool.
    [['teacher_logging', 'max_concurrent_writes'], 11, 'max_concurrent_writes'],
    [['teacher_logging', 'max_concurrent_writes'], 0, 'max_concurrent_writes'],
    // rng() >= sample_rate is a probability comparison; 1.5 samples exactly as 1 does.
    [['teacher_logging', 'sample_rate'], 1.5, 'sample_rate'],
    [['teacher_logging', 'sample_rate'], -0.1, 'sample_rate'],
    // resolveMaxSearchesPerRequest: [1, 10], anything else falls back to 3.
    [['tool', 'max_searches_per_request'], 11, 'max_searches_per_request'],
    [['tool', 'max_searches_per_request'], 0, 'max_searches_per_request'],
    // resolveMaxNumResultsDefault: [1, 50], the bound the tool descriptor validates against too.
    [['tool', 'max_num_results_default'], 51, 'max_num_results_default'],
    [['tool', 'max_num_results_default'], 0, 'max_num_results_default'],
  ])('rejects %p = %p', (path, value, named) => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const errors = validateSection(schema, withField(path as string[], value), pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain(named as string);
  });

  // 0 is the one out-of-band value that is NOT refused: resolveMaxRetries reads it as an operator's
  // "do not retry" and clamps it to 1 rather than to the default, so the schema lets it through and
  // the field's description says what it will actually become.
  it('accepts max_retries 0, which the resolver reads as 1 rather than as garbage', () => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    expect(validateSection(schema, withField(['ingestion', 'max_retries'], 0), pointer)).toEqual([]);
  });
});

// Every consumer of this section is a closed TypeScript interface (FileSearchRawConfig,
// configService.ts:1611-1639) that reads named keys and nothing else, so a key none of them names
// is a typo whose setting would never be applied - at any depth, not only at the section root.
describe('capabilities.file_search - closed at every level, not only the root', () => {
  it.each([
    [[]],
    [['hybrid']],
    [['hybrid', 'rerank']],
    [['chunking']],
    [['limits']],
    [['ingestion']],
    [['blob_storage']],
    [['blob_storage', 's3']],
    [['teacher_logging']],
    [['tool']],
  ])('rejects an unknown key under file_search%s', path => {
    const { pointer, schema } = resolveSection('capabilities', 'file_search');
    const data = shippedSection('capabilities', 'file_search');
    let cursor = data;
    for (const key of path as string[]) {
      cursor = cursor[key];
    }
    cursor.not_a_real_key = true;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('capabilities.* (web_search, hosted_tools, namespace_tools, custom_tools, tool_search, file_search) - every section is closed (additionalProperties: false)', () => {
  it.each(['web_search', 'hosted_tools', 'namespace_tools', 'custom_tools', 'tool_search', 'file_search'])(
    'rejects an unknown key under capabilities.%s',
    section => {
      const { pointer, schema } = resolveSection('capabilities', section);
      const data = { ...shippedSection('capabilities', section), not_a_real_key: true };
      const errors = validateSection(schema, data, pointer);
      expect(errors.length).toBeGreaterThan(0);
    }
  );
});

// All five, not just the two the schema used to name: `providers` accepts any key through a
// schema-valued `additionalProperties`, but only the five in `PROVIDER_KEYS` (configService.ts) are
// read, so those five are declared and each is a section of its own. All five reach their common
// fields through an `allOf` on `$defs/providerCommon` rather than declaring them, and before that
// composition was folded in, a provider written that way rendered as a single `raw` JSON blob for
// the whole provider - which is exactly what the raw-free half of this gate refuses.
describe('providers section round trips', () => {
  roundTrips('providers', 'anthropic');
  roundTrips('providers', 'aws-bedrock');
  roundTrips('providers', 'openai');
  roundTrips('providers', 'openrouter');
  roundTrips('providers', 'perplexity');
});

// The defect this split fixes, held as a test: `$defs/providerConfig` was one shape shared by all
// five providers, so the Openai, Openrouter and Perplexity panels each offered an Anthropic Bedrock
// Version, Excluded Beta Headers and Supported Beta Headers field - three settings no request on
// those routes ever reads (getAnthropicBedrockVersion / getExcludedBetaHeaders /
// getSupportedBetaHeaders in gateway configService.ts read providers.anthropic and nothing else).
// A field on a form is a promise that editing it does something, so these have to be absent from
// those three panels and present on the two that are served by the Anthropic request path.
describe('providers.* - the Anthropic-only fields appear on the Anthropic-shaped providers only', () => {
  const ANTHROPIC_ONLY = ['anthropic_bedrock_version', 'excluded_beta_headers', 'supported_beta_headers'];

  /** Every descriptor pointer of one provider's panel, as bare field names. */
  const fieldsOf = (provider: string): string[] => {
    const { pointer, schema } = resolveSection('providers', provider);
    const ds = buildDescriptors(schema, shippedSection('providers', provider), pointer, pluginFor);
    return flatten(ds)
      .map(d => d.pointer)
      .filter(p => p.startsWith(`${pointer}/`))
      .map(p => p.slice(pointer.length + 1).split('/')[0]);
  };

  for (const provider of ['openai', 'openrouter', 'perplexity']) {
    it(`shows no Anthropic-only field on ${provider}`, () => {
      const fields = fieldsOf(provider);
      // Not vacuous: the panel does render its own fields.
      expect(fields).toContain('substitute_models');
      for (const field of ANTHROPIC_ONLY) {
        expect(fields).not.toContain(field);
      }
    });
  }

  for (const provider of ['anthropic', 'aws-bedrock']) {
    it(`still shows all three on ${provider}`, () => {
      const fields = fieldsOf(provider);
      for (const field of ANTHROPIC_ONLY) {
        expect(fields).toContain(field);
      }
    });
  }

  it('leaves every provider its common fields - the split removed nothing shared', () => {
    const common = Object.keys((apiConfigSchema as any).$defs.providerCommon.properties);
    for (const provider of ['anthropic', 'aws-bedrock', 'openai', 'openrouter', 'perplexity']) {
      expect(fieldsOf(provider)).toEqual(expect.arrayContaining(common));
    }
  });
});

describe('providers.* - substitute_models items are typed {from, to, description?}, not free objects', () => {
  it('rejects an entry missing the "to" it would substitute in', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = shippedSection('providers', 'anthropic');
    delete data.substitute_models[0].to;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain("must have required property 'to'");
  });

  it('rejects an empty "from" - it would match no model rather than every one', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = shippedSection('providers', 'anthropic');
    data.substitute_models[0].from = '';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('substitute_models/0/from');
  });

  // getSubstitutedModel reads `from`/`to` and nothing else, so a fourth key is a typo the operator
  // must be told about rather than a setting that quietly does nothing.
  it('rejects a key the substitution has no meaning for', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = shippedSection('providers', 'anthropic');
    data.substitute_models[0].fom = 'claude-3-5-haiku-20241022';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('substitute_models/0');
  });
});

describe('providers.anthropic - anthropic_bedrock_version is the wire version, not free text', () => {
  it('rejects a version that is not bedrock-YYYY-MM-DD', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = { ...shippedSection('providers', 'anthropic'), anthropic_bedrock_version: '2023-06-01' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic_bedrock_version');
  });
});

// getSupportsPromptCaching returns the value only when `typeof p === 'boolean'`, so a string "false"
// is not read as false - it falls through to the provider default, which for anthropic is true. The
// schema has to reject it rather than let an operator believe they opted a provider out.
describe('providers.* - supports_prompt_caching is a strict boolean', () => {
  it('rejects a non-boolean supports_prompt_caching', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = { ...shippedSection('providers', 'anthropic'), supports_prompt_caching: 'false' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('supports_prompt_caching');
  });

  it('accepts it as a boolean - the field is declared, not merely tolerated', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = { ...shippedSection('providers', 'anthropic'), supports_prompt_caching: false };
    expect(validateSection(schema, data, pointer)).toEqual([]);
    const descriptor = flatten(buildDescriptors(schema, data, pointer, pluginFor))
      .find(d => d.pointer.endsWith('/supports_prompt_caching'));
    expect(descriptor).toMatchObject({ kind: 'switch', value: false });
  });
});

// param_renames is itself a map declared only by a schema-valued additionalProperties, one level
// inside a section - the shape validateSection ignored entirely before this task.
describe('providers.* - param_renames values are the new parameter name, not any value', () => {
  it('rejects a rename target that is not a non-empty string', () => {
    const { pointer, schema } = resolveSection('providers', 'openai');
    const data = { ...shippedSection('providers', 'openai'), param_renames: { max_tokens: 7 } };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('param_renames/max_tokens');
  });
});

describe('providers.openai/openrouter - the allOf extension fields are typed, not waved through', () => {
  it('rejects an openai_deployment_api_version that is not an Azure api-version', () => {
    const { pointer, schema } = resolveSection('providers', 'openai');
    const data = { ...shippedSection('providers', 'openai'), openai_deployment_api_version: 'latest' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('openai_deployment_api_version');
  });

  it('rejects a default_pricing that is not a decimal string', () => {
    const { pointer, schema } = resolveSection('providers', 'openrouter');
    const data = shippedSection('providers', 'openrouter');
    data.default_pricing.completion = '$0.000005';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('default_pricing/completion');
  });

  it('rejects a default_pricing missing one of its three required prices', () => {
    const { pointer, schema } = resolveSection('providers', 'openrouter');
    const data = shippedSection('providers', 'openrouter');
    delete data.default_pricing.image;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain("must have required property 'image'");
  });

  it('rejects a model_mappings entry whose max_tokens is not a positive integer', () => {
    const { pointer, schema } = resolveSection('providers', 'openrouter');
    const data = shippedSection('providers', 'openrouter');
    data.model_mappings[0].max_tokens = 0;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('model_mappings/0/max_tokens');
  });

  it('rejects a model_mappings entry with a key nothing reads', () => {
    const { pointer, schema } = resolveSection('providers', 'openrouter');
    const data = shippedSection('providers', 'openrouter');
    data.model_mappings[0].maxTokens = 4096;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('model_mappings/0');
  });
});

// Each of the five providers is CLOSED to the settings its own code path does not read, and closed
// with `propertyNames` rather than `additionalProperties: false`. The distinction is not stylistic:
// every provider composes `$defs/providerCommon` through an `allOf`, and a draft-07
// `additionalProperties` only sees the properties of the schema object that declares it - never a
// sibling branch's - so `additionalProperties: false` on providers.openai would reject the shipped
// configuration itself, starting with the common `substitute_models` it carries. `propertyNames`
// judges the KEY instead, which needs no sight of the branches: the enum lists exactly the names
// that provider reads, so the fields stay defined once in `$defs` and are still not accepted
// anywhere they would be inert.
describe('providers.* - each provider is closed to the settings it does not read', () => {
  it('rejects an unknown key under a provider', () => {
    const { pointer, schema } = resolveSection('providers', 'anthropic');
    const data = { ...shippedSection('providers', 'anthropic'), not_a_real_key: true };
    expect(validateSection(schema, data, pointer).length).toBeGreaterThan(0);
  });

  it('rejects an Anthropic-only setting under openai, openrouter and perplexity', () => {
    for (const provider of ['openai', 'openrouter', 'perplexity']) {
      const { pointer, schema } = resolveSection('providers', provider);
      for (const field of ['anthropic_bedrock_version', 'excluded_beta_headers', 'supported_beta_headers']) {
        const data = { ...shippedSection('providers', provider), [field]: field === 'anthropic_bedrock_version' ? 'bedrock-2023-05-31' : [] };
        expect(validateSection(schema, data, pointer).length).toBeGreaterThan(0);
      }
    }
  });

  it('still accepts those settings on anthropic and aws-bedrock, which is where they are declared', () => {
    for (const provider of ['anthropic', 'aws-bedrock']) {
      const { pointer, schema } = resolveSection('providers', provider);
      const data = {
        ...shippedSection('providers', provider),
        anthropic_bedrock_version: 'bedrock-2023-05-31',
        excluded_beta_headers: ['some-beta'],
        supported_beta_headers: ['some-beta']
      };
      expect(validateSection(schema, data, pointer)).toEqual([]);
    }
  });

  it('accepts every provider extension on its own provider - what a blanket close would have cost', () => {
    const openai = resolveSection('providers', 'openai');
    const openaiData = shippedSection('providers', 'openai');
    expect(openaiData.openai_deployment_api_version).toBe('2024-10-01-preview');
    expect(validateSection(openai.schema, openaiData, openai.pointer)).toEqual([]);

    const openrouter = resolveSection('providers', 'openrouter');
    const openrouterData = shippedSection('providers', 'openrouter');
    expect(openrouterData.default_pricing).toBeDefined();
    expect(openrouterData.model_mappings).toBeDefined();
    expect(validateSection(openrouter.schema, openrouterData, openrouter.pointer)).toEqual([]);
  });

  // The common set is defined once, in `$defs/providerCommon`, and each provider's `propertyNames`
  // enum has to keep naming all of it or that provider would reject a field it does read. This is
  // the pin that catches a name added to the def and not to an enum (or the reverse).
  it('names, on every provider, exactly the common set plus that provider extension', () => {
    const defs = (apiConfigSchema as any).$defs;
    const common = Object.keys(defs.providerCommon.properties);
    const anthropicOnly = Object.keys(defs.anthropicCompatibleProvider.properties);
    const extras: Record<string, string[]> = {
      anthropic: anthropicOnly,
      'aws-bedrock': anthropicOnly,
      openai: ['openai_deployment_api_version'],
      openrouter: ['default_pricing', 'model_mappings'],
      perplexity: []
    };

    for (const provider of Object.keys(extras)) {
      const node = defs.providersGroup.properties[provider];
      expect(node.propertyNames.enum).toEqual([...common, ...extras[provider]]);
      // ... and the enum is the node's real property set, not a list that drifted off it: what the
      // renderer composes out of the `allOf` branches has to be the same names.
      const composed = node.allOf.reduce((names: string[], branch: any) => {
        const resolved = branch.$ref ? defs[branch.$ref.replace('#/$defs/', '')] : branch;
        return names.concat(Object.keys(resolved.properties ?? {}));
      }, [] as string[]);
      expect(composed.sort()).toEqual([...node.propertyNames.enum].sort());
    }
  });
});

// `openMap: true` because `$defs/modelOverride` keeps `additionalProperties: true` - see this
// module's header for what that does and does not excuse. It excuses nothing on today's data: every
// key the shipped 24 entries populate is declared, so this section has no tolerated raw at all and
// would pass the strict gate too. The flag is what keeps that honest for an operator's own
// passthrough key - a key the merge really does copy onto the model, which the form must show as a
// blob rather than refuse - instead of letting this section quietly go thin again. The two tests
// below prove the tolerance is exactly that narrow.
describe('models section round trips', () => {
  roundTrips('models', 'overrides', { openMap: true });
});

describe('models.overrides - openMap tolerates an undeclared key and nothing else', () => {
  it('tolerates a key $defs/modelOverride does not declare - the merge passes it through', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-3-haiku--deployed'].some_passthrough_key = { copied: 'onto the model' };
    const ds = buildDescriptors(schema, data, pointer, pluginFor);

    // It really does degrade to raw - the tolerance is not vacuous ...
    const raws = flatten(ds).filter(d => d.kind === 'raw');
    expect(raws).toHaveLength(1);
    expect(raws[0].pointer).toBe(
      '/api_config/models/overrides/anthropic--claude-3-haiku--deployed/some_passthrough_key'
    );
    // ... `openMap` is what lets it through ...
    expect(unexplainedRaws(ds, true)).toEqual([]);
    // ... and without the flag the very same tree fails the gate.
    expect(unexplainedRaws(ds, false)).toEqual(raws);
  });

  it('still fails for a DECLARED key that renders raw', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    // subpaths_native is declared as an array; an object cannot be rendered as one.
    data['anthropic--claude-3-haiku--deployed'].subpaths_native = { invoke: true };
    const ds = buildDescriptors(schema, data, pointer, pluginFor);

    const unexplained = unexplainedRaws(ds, true);
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0].pointer).toBe(
      '/api_config/models/overrides/anthropic--claude-3-haiku--deployed/subpaths_native'
    );
  });
});

// The camelCase is deliberate (configService.ts:90-93's CachePricing) and so are the string types:
// modelService.ts:467-481 pushes these values verbatim into every version's `cost` array, so a
// number here would travel all the way into a price the gateway reports.
describe('models.overrides - cachePricing values are decimal cost strings, not numbers', () => {
  it('rejects a numeric cacheReadInputCostPer1K', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4-sonnet--deployed'].cachePricing.cacheReadInputCostPer1K = 0.0002;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('cachePricing/cacheReadInputCostPer1K');
  });

  it('rejects a cost string that is not a plain decimal', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4-sonnet--deployed'].cachePricing.cacheCreationInputCostPer1K = '$0.00254';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('cachePricing/cacheCreationInputCostPer1K');
  });

  // Unlike the override entry around it, cachePricing itself is closed: getCachePricingForModel
  // returns the object and modelService reads exactly these two keys off it, so a third is a typo
  // that would price nothing rather than a setting the merge passes on.
  it('rejects a cachePricing key nothing reads', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4-sonnet--deployed'].cachePricing.cacheWriteInputCostPer1K = '0.001';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('cachePricing');
  });

  it('renders both prices as typed text fields, not one JSON blob', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    const ds = flatten(buildDescriptors(schema, data, pointer, pluginFor));
    const read = ds.find(
      d => d.pointer === '/api_config/models/overrides/anthropic--claude-4-sonnet--deployed/cachePricing/cacheReadInputCostPer1K'
    );
    expect(read).toMatchObject({ kind: 'text', value: '0.00020' });
  });
});

// getModelContextLength (openRouterService.ts:338-350) falsy-checks this value and halves it into
// max_completion_tokens, so a zero is silently ignored rather than applied and a fraction would
// report a non-integer token count.
describe('models.overrides - contextLength is a positive integer', () => {
  it('rejects a fractional contextLength', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4.6-sonnet--deployed'].contextLength = 1048576.5;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('contextLength');
  });

  it('rejects 0 - the read is a falsy check, so it would be ignored rather than honoured', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4.6-sonnet--deployed'].contextLength = 0;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('contextLength');
  });

  it('renders as a number field, not a JSON blob', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    const ds = flatten(buildDescriptors(schema, data, pointer, pluginFor));
    const descriptor = ds.find(
      d => d.pointer === '/api_config/models/overrides/anthropic--claude-4.6-sonnet--deployed/contextLength'
    );
    expect(descriptor).toMatchObject({ kind: 'number', value: 1048576 });
  });
});

// awsBedrockService.ts:184-186 maps these through String() into the anthropic-beta assembly, so a
// number would be injected as its own decimal spelling and an empty string as a nameless flag.
describe('models.overrides - inject_beta_features is a list of beta flag names', () => {
  it('rejects a non-string entry', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4.6-sonnet--deployed'].inject_beta_features = [1];
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('inject_beta_features');
  });

  it('rejects an empty flag name', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-4.6-sonnet--deployed'].inject_beta_features = [''];
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('inject_beta_features/0');
  });
});

// modelService.ts:439 reads `typeof changeEntry.streamingSupported === 'boolean'`, so a string
// "false" is not read as false - it falls through to the deployment default, which for a model with
// an overrides entry is also false, but for a foundation model leaves the AI-Core value untouched.
// Either way the operator did not set what they wrote.
describe('models.overrides - streamingSupported is a strict boolean', () => {
  it('rejects a non-boolean streamingSupported', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-3-haiku--deployed'].streamingSupported = 'false';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('streamingSupported');
  });
});

// The counterpart to the openMap tests above, stated as validation rather than rendering: the entry
// itself must stay open, because the merge really does copy an undeclared key onto the model.
describe('models.overrides - a model entry stays open, and the merge is why', () => {
  it('accepts a key nothing declares under one model', () => {
    const { pointer, schema } = resolveSection('models', 'overrides');
    const data = shippedSection('models', 'overrides');
    data['anthropic--claude-3-haiku--deployed'].some_passthrough_key = { copied: 'onto the model' };
    expect(validateSection(schema, data, pointer)).toEqual([]);
  });
});

// Neither section takes `openMap`: both are closed all the way down. `defaults` is the one that
// was actually thin - its endpoint entries declared only `pseudonymization` and left
// `additionalProperties: true`, so every subpath the shipped configuration carries (anthropic's
// `invoke` and `invoke-with-response-stream`, openai's four, aws-bedrock's two) rendered as one
// opaque JSON blob per subpath, reason "No schema defines property ...". `definitions` was deep
// already except for `equals`, which carried no `type` at all and degraded all twelve rules.
describe('hooks section round trips', () => {
  roundTrips('hooks', 'definitions');
  roundTrips('hooks', 'defaults');
});

// What the operator actually sees under Hooks -> Defaults -> Anthropic -> Invoke. Before this, the
// same panel was a one-column table reading "This value cannot be shown in the form. Use the JSON
// editor." in every row: the schema described the hook, and no control could show it.
describe('hooks.defaults - a hook list renders as one section per hook, not a table', () => {
  const invoke = () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    return flatten(buildDescriptors(schema, shippedSection('hooks', 'defaults'), pointer, pluginFor))
      .filter(d => d.pointer.indexOf('/api_config/hooks/defaults/anthropic/invoke/') === 0
        || d.pointer === '/api_config/hooks/defaults/anthropic/invoke');
  };

  it('is a section holding an element section, not a table', () => {
    const list = invoke();
    expect(list.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/invoke'))
      .toMatchObject({ kind: 'section', label: 'Invoke' });
    expect(list.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/invoke/0'))
      .toMatchObject({ kind: 'section', label: '#0', collapsed: true });
    expect(list.filter(d => d.kind === 'table')).toEqual([]);
  });

  it('shows every field of the hook, each as its own control', () => {
    expect(invoke().map(d => `${d.kind} ${d.pointer}`)).toEqual([
      'section /api_config/hooks/defaults/anthropic/invoke',
      'section /api_config/hooks/defaults/anthropic/invoke/0',
      'section /api_config/hooks/defaults/anthropic/invoke/0/request',
      'section /api_config/hooks/defaults/anthropic/invoke/0/request/callback',
      'text /api_config/hooks/defaults/anthropic/invoke/0/request/callback/id',
      'select /api_config/hooks/defaults/anthropic/invoke/0/request/callback/strategy',
      'list /api_config/hooks/defaults/anthropic/invoke/0/request/match',
    ]);
    const list = invoke();
    expect(list.find(d => d.pointer.endsWith('/callback/id')))
      .toMatchObject({ label: 'ID', value: 'pseudonymizationPlugin', required: true });
    expect(list.find(d => d.pointer.endsWith('/request/match')))
      .toMatchObject({ label: 'Match', values: ['header:contentTypeJson'], required: true });
  });

  // The array is marked appendable, says what a new hook would be, and every element of it says
  // which index it sits at - the [-]'s own marker. Task 2 pinned the opposite here, deliberately:
  // `ConfigForm.onRemoveItem` served `SINKS_POINTER` alone at the time, so a [-] on a hook would
  // have been a button that did nothing when pressed. It is honoured now, for every appendable
  // array, so the pin is inverted rather than dropped.
  it('is marked appendable with a hook skeleton, and every element carries the index its [-] removes', () => {
    const list = invoke().filter(d => d.kind === 'section');
    expect(list.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/invoke'))
      .toMatchObject({ arrayItems: { discriminated: false, skeleton: { request: { callback: { id: '' }, match: [] } } } });

    // One segment past the array, not everything under it: `/invoke/0/request` is a field of the
    // element, and the assertion below says it carries no index of its own.
    const elements = list.filter(d => /^\/api_config\/hooks\/defaults\/anthropic\/invoke\/\d+$/.test(d.pointer));
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.map(d => (d as { arrayIndex?: number }).arrayIndex))
      .toEqual(elements.map((_, index) => index));
    // The pointer each [-] acts on is the element's own, so `removeAt` splices exactly it.
    expect(elements[0].pointer).toBe('/api_config/hooks/defaults/anthropic/invoke/0');
    // Nothing INSIDE an element is removable - `request` is a field of the hook, not an element.
    expect(list.filter(d => d.pointer.endsWith('/request'))
      .every(d => (d as { arrayIndex?: number }).arrayIndex === undefined)).toBe(true);
  });
});

// The other half of the renderer change: an array whose item fields all fit in a cell must STAY a
// table. Both of these are scalar-only, and a section per element would be a worse rendering of
// fourteen two-field rows.
describe('an array of scalar-only objects still renders as a table', () => {
  it.each([
    ['providers', 'anthropic', '/api_config/providers/anthropic/substitute_models', ['from', 'to', 'description']],
    ['providers', 'openrouter', '/api_config/providers/openrouter/model_mappings',
      ['default_context_length', 'id_prefix', 'provider', 'max_tokens']],
  ])('%s.%s %s', (group, section, pointer, columns) => {
    const resolved = resolveSection(group, section);
    const ds = flatten(buildDescriptors(resolved.schema, shippedSection(group, section), resolved.pointer, pluginFor));
    const table = ds.find(d => d.pointer === pointer);
    expect(table).toMatchObject({ kind: 'table', columns });
    expect(unhostableCells(ds)).toEqual([]);
  });
});

describe('hooks.definitions - type is what matchRuleOptimized switches on', () => {
  // The default case of that switch logs "Unknown hook type" and returns false, so a rule with an
  // unrecognised type does not match loosely - it matches nothing, and every hook naming it stops
  // firing. That is silent, so the schema has to catch it.
  it('rejects a type the matcher has no case for', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['header:contentTypeJson'].type = 'body-regex';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('header:contentTypeJson/type');
  });
});

// matchHeader falsy-checks `name`, and both regex matchers falsy-check `regex`: an empty one is
// not "match anything", it is a rule that can never fire. An operator who clears the field has
// disabled every hook that names the rule without being told.
describe('hooks.definitions - the fields the matcher falsy-checks cannot be empty', () => {
  it('rejects an empty header name', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['header:contentTypeJson'].name = '';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('header:contentTypeJson/name');
  });

  it('rejects an empty json path', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['payload:maxTokens512'].path = '';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('payload:maxTokens512/path');
  });

  it('rejects an empty regex', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['anthropic:all'].regex = '';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic:all/regex');
  });
});

// `new RegExp(source, flags)` throws on a flag letter it does not know; pluginLoader catches that,
// logs it and reports no match, so "global" instead of "g" disables the rule rather than failing
// the save.
describe('hooks.definitions - flags are RegExp flag letters, not a word', () => {
  it('rejects a flags value RegExp would throw on', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['anthropic:all'].flags = 'global';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic:all/flags');
  });
});

// The one union in this schema, and it is not a convenience: a `header` rule's `equals` is compared
// as a media type against a header string, a `json-path` rule's with `===` against the parsed body,
// where the shipped `payload:maxTokens512` compares against the number 512. Typing it as either one
// alone would reject the shipped configuration; leaving it untyped is what made it render raw.
describe('hooks.definitions - equals is the scalar the comparison actually uses', () => {
  it('renders a string equals as text and a numeric one as a number, not as JSON blobs', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    const ds = flatten(buildDescriptors(schema, data, pointer, pluginFor));
    expect(ds.find(d => d.pointer === '/api_config/hooks/definitions/header:contentTypeJson/equals'))
      .toMatchObject({ kind: 'text', value: 'application/json' });
    expect(ds.find(d => d.pointer === '/api_config/hooks/definitions/payload:maxTokens512/equals'))
      .toMatchObject({ kind: 'number', value: 512 });
  });

  it('rejects an object - matchJsonPath compares with ===, which no two objects satisfy', () => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data['payload:maxTokens512'].equals = { value: 512 };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('payload:maxTokens512/equals');
  });
});

// matchJsonPathRegexOptimized and matchUrlRegexOptimized compare with the compiled expression and
// never read `equals`, so a value set there is configuration that does nothing - and the form now
// offers the field on every rule (an absent union leaf still renders a control), which is exactly
// when a schema has to say the value would be ignored. No shipped rule of either type carries one.
describe('hooks.definitions - equals is refused where the matcher would ignore it', () => {
  it.each(['anthropic:all', 'system:whimsicalPrompt'])('rejects equals on %s', ruleId => {
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const data = shippedSection('hooks', 'definitions');
    data[ruleId].equals = 'ignored by the regex matchers';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain(`definitions/${ruleId}`);
  });

  // `not` is a keyword the browser gate had no implementation for, so this pins the half that
  // matters: the gate's verdict on the probe is the backend's verdict, not a fail-open pass.
  it('agrees with the backend Ajv instance on that probe, and on the shipped rules', () => {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const { pointer, schema } = resolveSection('hooks', 'definitions');
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema)));

    const clean = shippedSection('hooks', 'definitions');
    expect(validate(clean)).toBe(true);
    expect(validateSection(schema, clean, pointer)).toEqual([]);

    const probe = shippedSection('hooks', 'definitions');
    probe['anthropic:all'].equals = 'ignored by the regex matchers';
    expect(validate(probe)).toBe(false);
    expect(validateSection(schema, probe, pointer).length).toBeGreaterThan(0);
  });
});

// The typing gap this task closed: `hooks.defaults.<endpoint>` declared `pseudonymization` and
// nothing else, so the subpath keys - the hook lists the executor actually runs - were undeclared.
describe('hooks.defaults - a subpath entry is a hook list, not an untyped blob', () => {
  it('rejects a subpath whose value is not an array of hooks', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic.invoke = { request: { callback: { id: 'pseudonymizationPlugin' }, match: ['payload:any'] } };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic/invoke');
  });

  it('rejects a hook with no match - pluginExecutor skips it, so it would never run', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    delete data.anthropic.invoke[0].request.match;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain("must have required property 'match'");
  });

  it('rejects an empty match - that would fire the hook on every request', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic.invoke[0].request.match = [];
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic/invoke/0/request/match');
  });

  it('rejects an empty rule id - hooks.definitions can define no such rule', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic.invoke[0].request.match = [''];
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic/invoke/0/request/match/0');
  });

  it('rejects a callback key nothing reads', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic.invoke[0].request.callback.plugin = 'pseudonymizationPlugin';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic/invoke/0/request/callback');
  });

  // Closed at the endpoint level too: getHookConfig reads any other key as a subpath, and no route
  // asks for a subpath the endpoint does not serve, so a typo here is a hook list that never runs.
  it('rejects a key that is neither pseudonymization nor a subpath', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic['not a subpath'] = [];
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// The one place in this document where a named property and a `patternProperties` regex share an
// object. Draft-07 applies both to a key they both match, so a subpath pattern that also matched
// `pseudonymization` would demand the force-activation block be a hook array - which is why the
// pattern excludes it by name. This pins that: the block is still validated as a pseudonymization
// config and still renders as its own section.
describe('hooks.defaults - pseudonymization is not swallowed by the subpath pattern', () => {
  it('accepts the shipped force-activation block, which is an object rather than a hook list', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    expect(data.anthropic.pseudonymization.enabled).toBe(true);
    expect(validateSection(schema, data, pointer)).toEqual([]);
  });

  it('still holds it to $defs/pseudonymizationConfig, not to the hook-list shape', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    data.anthropic.pseudonymization.method = 'redaction';
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('anthropic/pseudonymization/method');
    expect(errors.join(' ')).not.toContain('must be array');
  });

  it('renders it as its own section beside the subpath lists', () => {
    const { pointer, schema } = resolveSection('hooks', 'defaults');
    const data = shippedSection('hooks', 'defaults');
    const ds = flatten(buildDescriptors(schema, data, pointer, pluginFor));
    expect(ds.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/pseudonymization'))
      .toMatchObject({ kind: 'section' });
    expect(ds.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/invoke/0/request/callback/id'))
      .toMatchObject({ kind: 'text', value: 'pseudonymizationPlugin' });
  });
});

// getHookConfig returns either branch to the same executor, so the two must describe the same
// shape. They do so by construction now - one `$defs/hookEntryArray`, referenced from both - and
// this measures it from the outside: the identical malformed hook is rejected in either place.
describe('hooks.defaults and models.overrides.*.hooks are one shape', () => {
  it.each([
    ['hooks', 'defaults', (d: any) => d.anthropic.invoke[0]],
    ['models', 'overrides', (d: any) => d['anthropic--claude-3-haiku--deployed'].hooks.invoke[0]],
  ])('rejects a hook with no callback under %s.%s', (group, section, hook) => {
    const { pointer, schema } = resolveSection(group, section);
    const data = shippedSection(group, section);
    delete hook(data).request.callback;
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain("must have required property 'callback'");
  });
});

describe('observability section round trips', () => {
  roundTrips('observability', 'pseudonymization');
  roundTrips('observability', 'siem');
});

describe('observability.pseudonymization - method renders schema.default when absent, never an invalid enum value', () => {
  it('an unset method descriptor is the select "pseudonymization", not \'\'', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = shippedSection('observability', 'pseudonymization');
    expect(Object.prototype.hasOwnProperty.call(data, 'method')).toBe(false);
    const ds = buildDescriptors(schema, data, pointer, pluginFor);
    const methodDescriptor = flatten(ds).find(d => d.pointer.endsWith('/method'));
    expect(methodDescriptor).toMatchObject({ kind: 'select', value: 'pseudonymization' });
  });
});

describe('observability.pseudonymization - entities keys match KNOWN_ENTITY_TYPES, not a loose profile-* pattern', () => {
  it('rejects an entities key outside KNOWN_ENTITY_TYPES (entityToggles.ts)', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = {
      ...shippedSection('observability', 'pseudonymization'),
      entities: { ...shippedSection('observability', 'pseudonymization').entities, 'profile-bogus': true },
    };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('entities');
  });
});

describe('observability.pseudonymization - method matches what afterHandler/index.ts switches on', () => {
  it('rejects a method neither pseudonymization nor anonymization', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = { ...shippedSection('observability', 'pseudonymization'), method: 'redaction' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('method');
  });
});

describe('observability.pseudonymization - allow_user_bypass is a strict boolean (isBypassRequested reads === true)', () => {
  it('rejects a non-boolean allow_user_bypass', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = { ...shippedSection('observability', 'pseudonymization'), allow_user_bypass: 'true' };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('allow_user_bypass');
  });
});

describe('observability.pseudonymization - org_suffixes/location_gazetteer are string arrays', () => {
  it('rejects a non-string org_suffixes entry', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = { ...shippedSection('observability', 'pseudonymization'), org_suffixes: [123] };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('org_suffixes');
  });

  it('rejects a non-string location_gazetteer entry', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = { ...shippedSection('observability', 'pseudonymization'), location_gazetteer: [123] };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('location_gazetteer');
  });
});

describe('observability.pseudonymization - closed (additionalProperties: false)', () => {
  it('rejects an unknown key under observability.pseudonymization', () => {
    const { pointer, schema } = resolveSection('observability', 'pseudonymization');
    const data = { ...shippedSection('observability', 'pseudonymization'), not_a_real_key: true };
    const errors = validateSection(schema, data, pointer);
    expect(errors.length).toBeGreaterThan(0);
  });
});

/**
 * The same gate, on the document the owner actually had: `api_config` with two platform sections in
 * it and nothing else.
 *
 * The registrations above all load the SHIPPED configuration, which carries every section, so they
 * measure the renderer against a document that has an answer for everything. On a minimal document
 * the form was wrong in two directions at once - a section the document did not carry rendered its
 * whole field set at schema defaults (a section that looks configured and is not), and editing one
 * of those fields wrote at the document root. The root anchoring is Task 1's; this is the other
 * half, held to two assertions per section:
 *
 * - an ABSENT section produces exactly one descriptor, marked `absent`, with no children and no
 *   `value`-carrying descriptor anywhere beneath it. Zero controls at defaults, measured rather
 *   than described.
 * - a PRESENT section still round-trips byte-identically, exactly as it does on the shipped
 *   document - the absent ruling must not have cost the sections that ARE there anything.
 *
 * Every group and every section of the schema, enumerated from `API_CONFIG_GROUPS`/`groupSections`
 * rather than listed here, so a section added to the schema later is covered without an edit.
 */
describe('minimal document', () => {
  const MINIMAL_DOCUMENT = {
    api_config: {
      platform: {
        timeouts: { default: 30000, streaming: 60000 },
        logging: { defaultLevel: 'DEBUG' }
      }
    }
  };

  /** `[group, section]` for every section of the schema. */
  const everySection: Array<[ApiConfigGroup, string]> = API_CONFIG_GROUPS.reduce<Array<[ApiConfigGroup, string]>>(
    (all, group) => all.concat(groupSections(apiConfigSchema, group).map(s => [group, s.key] as [ApiConfigGroup, string])),
    []
  );

  /** What the minimal document carries at `group.section`, which for most of them is nothing. */
  const minimalData = (group: string, section: string): unknown =>
    ((MINIMAL_DOCUMENT.api_config as Record<string, any>)[group] || {})[section];

  it('covers every section of every group', () => {
    expect(everySection.length).toBeGreaterThanOrEqual(20);
    expect(everySection.filter(([group, section]) => minimalData(group, section) !== undefined))
      // The schema's own declaration order - `groupSections` is called here with no document, so
      // there is none to follow; see `documentOrderedKeys`.
      .toEqual([['platform', 'timeouts'], ['platform', 'logging']]);
  });

  it.each(everySection)('%s.%s renders without inventing settings', (group, section) => {
    const { pointer, schema } = resolveSection(group, section);
    const data = minimalData(group, section);
    const ds = buildDescriptors(schema, data, pointer, pluginFor);

    if (data === undefined) {
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ kind: 'section', pointer, absent: true, children: [] });
      // The assertion that matters: not one control on this panel carries a value, so nothing on
      // it can look like a setting that is in force.
      expect(flatten(ds).filter(d => 'value' in d)).toEqual([]);
      return;
    }

    // The section itself renders - it is not the one-marker form. A map container INSIDE it may
    // still be absent and marked so (`platform.logging.components` is, on this document): a
    // container is a container wherever it sits, and it too must not render entries that are not
    // there. What must not happen is the section as a whole standing in for its fields.
    expect(ds.length === 1 && (ds[0] as { absent?: true }).absent === true).toBe(false);
    expect(flatten(ds).filter(d => (d as { absent?: true }).absent === true)
      .every(d => (d as { mapEntries?: unknown }).mapEntries !== undefined)).toBe(true);
    expect(unexplainedRaws(ds)).toEqual([]);
    let out: unknown = wrapAt(pointer, JSON.parse(JSON.stringify(data)));
    for (const d of flatten(ds)) {
      if ('value' in d && pointerResolvesToPresentKey(data, d.pointer)) {
        out = applyDescriptor(out, d.pointer, (d as { value: unknown }).value);
      }
    }
    expect(out).toEqual(wrapAt(pointer, data));
  });

  // The whole document at once, not section by section: every descriptor the form would render for
  // this document, written back onto the document itself. Byte-identical, and in particular still
  // two sections deep - an absent section that had rendered its defaults would have added its keys
  // here, which is exactly the save the owner measured landing at the root.
  it('writes every rendered control back and leaves the whole document byte-identical', () => {
    let out: unknown = JSON.parse(JSON.stringify(MINIMAL_DOCUMENT));
    for (const [group, section] of everySection) {
      const { pointer, schema } = resolveSection(group, section);
      const data = minimalData(group, section);
      for (const d of flatten(buildDescriptors(schema, data, pointer, pluginFor))) {
        if ('value' in d && pointerResolvesToPresentKey(data, d.pointer)) {
          out = applyDescriptor(out, d.pointer, (d as { value: unknown }).value);
        }
      }
    }
    expect(out).toEqual(MINIMAL_DOCUMENT);
    expect(JSON.stringify(out)).toBe(JSON.stringify(MINIMAL_DOCUMENT));
  });
});
