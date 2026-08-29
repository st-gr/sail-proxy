/**
 * Resolves a JSON pointer to a plugin name, or `undefined` if no plugin owns it. Typically
 * `pluginFor` from `./formPlugins`, but required as an explicit argument (see `buildDescriptors`)
 * rather than imported ambient module state, so a caller cannot silently forget to wire up
 * plugin resolution and get a credential slot rendered as a plain text input by default.
 */
export type PluginResolver = (pointer: string) => string | undefined;

/**
 * A section whose children are the DOCUMENT's own keys rather than the schema's: a map node, i.e.
 * an object whose children are declared by a schema-valued `additionalProperties` or by
 * `patternProperties` (`buildChildren`'s second and third matching steps). Carried on the section
 * descriptor so the control layer can offer add/remove/filter over the entries without reading a
 * schema itself - the renderer stays the only thing that does - and so those affordances are
 * derived from the schema rather than from a hand-kept list of pointers.
 *
 * `mapNodesOf` enumerates every pointer in this schema that produces one.
 */
export interface MapEntries {
  /**
   * What a key of this map must look like, as the schema's own regex source (unanchored text, not
   * a `RegExp`, so a descriptor stays plain JSON): the single `patternProperties` regex when the
   * node declares exactly one, else the node's `propertyNames.pattern` if it has one. Undefined
   * where the schema constrains keys in neither way (`providers`, `models.overrides`,
   * `hooks.defaults`, `param_renames`) - there the key rule is the form's own, not the schema's.
   */
  keyPattern?: string;
  /**
   * What one entry IS, and therefore what the add affordance has to create for a new key: an
   * object (`{}`), an array (`[]`, e.g. one subpath's hook list) or a single scalar control.
   */
  valueKind: 'object' | 'scalar' | 'array';
  /**
   * The value a newly added key of a SCALAR-valued map starts at - set only when `valueKind` is
   * `'scalar'`. See `scalarSeed` for how it is derived.
   */
  scalarDefault?: unknown;
  /**
   * The value a newly added key of an OBJECT-valued map starts at - set only when `valueKind` is
   * `'object'`, and built by the same `skeletonOf` an array element uses: every REQUIRED leaf of the
   * entry's own schema and nothing else.
   *
   * `{}` would do for `providers` and `models.overrides`, whose entry schemas require nothing - and
   * for those two this IS `{}`. It does not do for `hooks.definitions`, whose entries require a
   * `type`: an entry added as `{}` matches all four of that schema's `if` branches vacuously and
   * arrives carrying five validation errors instead of the one ("a header rule needs a name") the
   * operator can actually act on. An `'array'`-valued map needs no field: a new key there is `[]`.
   */
  valueSkeleton?: unknown;
  /**
   * A non-restrictive convenience list for an OPEN map's Add dialog: the known keys worth offering
   * as suggestions, in the schema's own order, so an operator can pick one rather than typing a
   * component name from memory. Its source is the map node's own `x-keySuggestions` keyword.
   *
   * Deliberately DISTINCT from the schema's closed key enumeration (`MapSpec.keyChoices`, derived
   * from an anchored alternation of literals, which RESTRICTS keys). This list restricts nothing:
   * the key rule stays the node's `patternProperties` shape, and `mapKeyProblem` accepts any key
   * matching it - the suggestions are what the ComboBox seeds itself with, not the set of legal
   * keys. Set only for a map whose node declares `x-keySuggestions` (today, the logging.components
   * map, whose keys are the gateway's own component names).
   */
  keySuggestions?: string[];
}

/**
 * A section that is an array, and what appending to it means.
 *
 * `discriminated` is the old boolean marker: an array whose elements pick their fields from an
 * `if`/`then` variant (the SIEM sinks), which is the case the sink dialog serves. It is no longer
 * the condition for being addable at all - a hook list is just as addable - so the two facts are
 * carried separately: what kind of array this is, and what a new element of it looks like.
 */
export interface ArrayItems {
  /** Elements select their fields by a discriminator - see `discriminationOf`. */
  discriminated: boolean;
  /**
   * A new element, built from the item schema alone: every REQUIRED leaf and nothing else, so an
   * added element carries what the schema insists on and invents nothing the operator did not
   * choose. See `skeletonOf`.
   */
  skeleton: unknown;
}

/**
 * A schema-driven, UI-agnostic control descriptor. `buildDescriptors` walks a JSON schema
 * alongside a matching data value and emits a tree of these; a later renderer binds them to
 * concrete UI5 controls. This module imports no UI5 and never touches the DOM, so its
 * correctness is unit-testable headlessly.
 *
 * `description` on a descriptor is the schema's own text for that property, carried through so
 * the control layer can show it as a tooltip without reading a schema itself - the renderer
 * stays the only thing that does.
 *
 * It is set on every descriptor kind whose control has nothing better to say, and left OFF
 * entirely where the schema has no text, so a control renders no tooltip rather than an empty
 * one. `raw` and `plugin` are the two exceptions: a `raw` snippet's tooltip is the reason it
 * could not be represented, and a `plugin` descriptor is built before its schema is even
 * resolved (its value must never be read) and carries its own row tooltip instead.
 *
 * The `siem` schema writes these descriptions to explain exactly these settings, and two of
 * them are the reason this exists at all: `allow_unmasked_content` (raw conversations leaving
 * the box) and `include_credential_material` (a credential value leaving it) must not be
 * flippable without their risk being readable at the control. A label alone cannot say that.
 */
export type Descriptor =
  | { kind: 'switch'; pointer: string; label: string; value: boolean; description?: string; required?: boolean }
  | {
      kind: 'number';
      pointer: string;
      label: string;
      value: number;
      /**
       * The schema said `type: "integer"`, not `type: "number"`. The control renders every number
       * as a `StepInput`, whose default `step: 1`/`displayValuePrecision: 0` silently ROUNDS a
       * float to an integer - so `min_confidence: 0.5` could not be typed at all. The descriptor
       * carries the distinction the two JSON-Schema types make so the control can offer decimals
       * for a float and keep whole-number stepping for an integer.
       */
      integer: boolean;
      /**
       * The schema's own `multipleOf`, when it declares one - it fixes both the StepInput's `step`
       * and its display precision. No field in this schema uses it today; carried so the control
       * honours it the day one does, rather than defaulting a `multipleOf: 0.1` field to 0.01 steps.
       */
      multipleOf?: number;
      minimum?: number;
      maximum?: number;
      description?: string;
      required?: boolean;
    }
  | {
      kind: 'select';
      pointer: string;
      label: string;
      /**
       * The chosen enum member itself, not a rendering of it - which is why this is not `string`.
       * The round trip writes a descriptor's own `value` straight back into the document, so a
       * boolean member has to survive as a boolean all the way through; typing it `string` made
       * that guarantee something a cast had to assert rather than something the compiler checks.
       * `options` below is what the control shows and keys on.
       */
      value: string | boolean;
      options: string[];
      /**
       * The enum's own members, in the same order as `options`, carried only when one of them is not
       * a string. A Select's key is a string, so `options` alone cannot say that `hybrid.rerank.enabled`
       * chooses between the BOOLEANS true/false and the STRING "auto": the control would hand back the
       * text "true", and `reranker.ts` compares with `=== true`/`=== false`, so the saved document
       * would read as neither. The control layer maps the chosen key back through this array.
       */
      optionValues?: unknown[];
      readOnly?: boolean;
      description?: string;
      required?: boolean;
    }
  | { kind: 'text'; pointer: string; label: string; value: string; pattern?: string; minLength?: number; maxLength?: number; description?: string; required?: boolean }
  | {
      kind: 'section';
      pointer: string;
      label: string;
      children: Descriptor[];
      collapsed?: boolean;
      description?: string;
      /** This section is an array: its children are its elements, and elements may be appended. */
      arrayItems?: ArrayItems;
      /** This section is one element of an array, at this index, and may be removed. */
      arrayIndex?: number;
      /** This section is a dynamically-keyed map: its children are the document's own keys. */
      mapEntries?: MapEntries;
      /**
       * This section is one ENTRY of a map, and this is its own JSON said in one line - what its
       * panel header shows while the panel is collapsed. Built by `formContainers.mapEntrySummary`
       * and set by `formContainers.mapEntryDescriptor`, the one place an entry's data and its
       * resolved schema are both in hand; left off where the entry has nothing to say.
       */
      summary?: string;
      /**
       * The document does not carry this section or map container at all, so it has NO children:
       * not one field at its schema default. See `namesAContainer` for which nodes this is set on
       * and why a nested optional object inside a present section is deliberately not one of them.
       */
      absent?: true;
    }
  | { kind: 'table'; pointer: string; label: string; columns: string[]; rows: Descriptor[][]; description?: string }
  | {
      kind: 'list';
      pointer: string;
      label: string;
      values: string[];
      description?: string;
      /**
       * The values the item schema's `enum` allows, when it has one. Carried here rather than
       * left for the control layer to read back out of the schema - the renderer stays the only
       * thing that reads schemas - so a list of enum-constrained scalars can be offered as a
       * choice instead of as free text.
       */
      options?: string[];
      required?: boolean;
    }
  | { kind: 'raw'; pointer: string; label: string; json: string; reason: string; required?: boolean }
  | { kind: 'plugin'; pointer: string; label: string; plugin: string; value: unknown; required?: boolean };

/** Minimal shape of a JSON Schema node, as far as the renderer cares. */
export interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  title?: string;
  $ref?: string;
  [key: string]: unknown;
}

/**
 * Walks `schema` (an object schema) alongside `data`, emitting a descriptor for each of the
 * schema's declared properties. `pointer` is the JSON-pointer address of `data` within the
 * eventual full configuration document (not necessarily "" - `data` may be a subtree).
 *
 * `resolvePlugin` is required, not optional or defaulted to ambient module state: a caller
 * must explicitly decide how plugin pointers resolve (typically by passing `pluginFor` from
 * `./formPlugins`). Omitting it is a programmer error and throws immediately rather than
 * silently rendering every field - including an unregistered credential slot - as plain text.
 */
export function buildDescriptors(
  schema: object,
  data: unknown,
  pointer: string,
  resolvePlugin: PluginResolver
): Descriptor[] {
  if (typeof resolvePlugin !== 'function') {
    throw new Error(
      'buildDescriptors: resolvePlugin is required (e.g. pass pluginFor from ./formPlugins) - ' +
        'it must not be omitted, so plugin-gated fields such as credential slots cannot silently ' +
        'render as plain text.'
    );
  }

  const rootSchema = schema as JsonSchemaNode;
  const resolved = composeAllOf(resolveRef(rootSchema, rootSchema), rootSchema);

  if (resolved && resolved.type === 'object') {
    // A section the document does not carry renders as one absent marker, not as its whole field
    // set sitting at schema defaults - see `namesAContainer`. This is the entry point the tab shell
    // calls once per section, so it is where a whole absent section is decided.
    const mapEntries = mapEntriesOf(resolved, rootSchema);
    if (data === undefined && namesAContainer(pointer, mapEntries)) {
      return [absentSection(resolved, pointer, labelFor(lastSegment(pointer)), mapEntries)];
    }
    return buildChildren(resolved, data, pointer, rootSchema, resolvePlugin);
  }

  return [buildNode(resolved ?? rootSchema, data, pointer, rootSchema, humanize(lastSegment(pointer)), resolvePlugin)];
}

/**
 * Sets `value` at `pointer` on a deep clone of `data` and returns the clone; never mutates its
 * input. Anchored at the root of `data`: every segment but the last is walked in order, and an
 * intermediate object segment missing from the document is created rather than causing the
 * pointer to be searched for elsewhere. An intermediate ARRAY segment is never created - only the
 * add affordance does that - so an index into a missing array throws instead of inventing one.
 */
export function applyDescriptor(data: unknown, pointer: string, value: unknown): unknown {
  const clone = deepClone(data);
  const segments = splitPointer(pointer);
  if (segments.length === 0) return value;
  let cursor: unknown = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const next = segments[i + 1];
    const container = cursor as Record<string, unknown> | unknown[];
    if (Array.isArray(container)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= container.length) {
        throw new Error(`applyDescriptor: array index "${key}" in "${pointer}" does not exist.`);
      }
      cursor = container[index];
      continue;
    }
    if (container === null || typeof container !== 'object') {
      throw new Error(`applyDescriptor: cannot resolve pointer "${pointer}" on the given data.`);
    }
    if (!Object.prototype.hasOwnProperty.call(container, key) || container[key] === undefined) {
      if (/^\d+$/.test(next)) {
        throw new Error(`applyDescriptor: "${pointer}" needs an array at "${key}" that does not exist; arrays are created by the add affordance.`);
      }
      container[key] = {};
    }
    cursor = container[key];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index > cursor.length) throw new Error(`applyDescriptor: array index "${last}" in "${pointer}" does not exist.`);
    cursor[index] = value;
  } else if (cursor !== null && typeof cursor === 'object') {
    (cursor as Record<string, unknown>)[last] = value;
  } else {
    throw new Error(`applyDescriptor: cannot resolve pointer "${pointer}" on the given data.`);
  }
  return clone;
}

/**
 * Deletes the key or array element `pointer` addresses on a deep clone of `data` and returns the
 * clone; never mutates its input. The parent container must already exist - unlike
 * `applyDescriptor`, nothing is ever created here - so a pointer whose parent is missing throws
 * rather than silently no-op'ing.
 */
export function removeAt(data: unknown, pointer: string): unknown {
  const clone = deepClone(data);
  const segments = splitPointer(pointer);
  if (segments.length === 0) throw new Error('removeAt: cannot remove the root.');
  let cursor: unknown = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const container = cursor as Record<string, unknown> | unknown[];
    if (container === null || typeof container !== 'object') throw new Error(`removeAt: cannot resolve pointer "${pointer}".`);
    cursor = Array.isArray(container) ? container[Number(segments[i])] : container[segments[i]];
    if (cursor === undefined) throw new Error(`removeAt: cannot resolve pointer "${pointer}".`);
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) throw new Error(`removeAt: cannot resolve pointer "${pointer}".`);
    cursor.splice(index, 1);
  } else if (cursor !== null && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, last)) {
    delete (cursor as Record<string, unknown>)[last];
  } else {
    throw new Error(`removeAt: cannot resolve pointer "${pointer}".`);
  }
  return clone;
}

/**
 * Every map node of a whole configuration schema, as document pointers, in the schema's own
 * declaration order - `providers`, `models.overrides`, `hooks.definitions`, `hooks.defaults` and
 * its per-endpoint subpath maps, `platform.logging.components`, both
 * `platform.rate_limit_handling.*_delays`, `observability.pseudonymization.entities`, and every
 * `param_renames`/`hooks`/`entities` map reachable inside a map's own entries.
 *
 * A star segment stands for one dynamic key or array index - the same wildcard `formPlugins`
 * already uses for the sink credential slot pointers - so the pointer ending
 * `/api_config/hooks/defaults` plus a star segment is "the subpath map of any endpoint". A map
 * reachable both through a declared key and through the wildcard is listed once per distinct
 * pointer, because the two are different addresses even where they resolve to the same subschema.
 *
 * Exported because two callers must not re-derive it: the tests that hold this schema to "at least
 * the eight maps the design names", and the key rules that decide what a [+] on one of them may
 * create. A walk rather than a list, so a map added to the schema later needs no edit here - which
 * is the whole point of deriving the affordances from the schema instead of from a registry.
 */
export function mapNodesOf(schema: object): string[] {
  const rootSchema = schema as JsonSchemaNode;
  const apiConfig = (rootSchema.properties ?? {}).api_config;
  const out: string[] = [];
  collectMapNodes(apiConfig ?? rootSchema, apiConfig ? '/api_config' : '', rootSchema, out, new Set<string>());
  return out;
}

// --- internals -------------------------------------------------------------

/**
 * The walk behind `mapNodesOf`: emits `pointer` when the node is a map, then descends through every
 * place a schema can hold another schema - declared properties, the value schemas of
 * `patternProperties`/`additionalProperties`, array `items`, and both the composing and the
 * conditional (`then`) branches of an `allOf`, since `providers.openai`'s `param_renames` is
 * reachable only through the composed `$defs/providerCommon` branch.
 *
 * `seen` guards a `$ref` repeating along one path from root to leaf, exactly as `resolveRefsDeep`
 * does and for the same reason: the same `$ref` reached from two different branches (this schema
 * reaches `$defs/pseudonymizationConfig` from three) is not a cycle and must still be walked.
 */
function collectMapNodes(
  node: JsonSchemaNode | undefined,
  pointer: string,
  rootSchema: JsonSchemaNode,
  out: string[],
  seen: Set<string>
): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) {
      return;
    }
    const resolved = resolveRef(node, rootSchema);
    if (resolved !== node) {
      collectMapNodes(resolved, pointer, rootSchema, out, new Set(seen).add(node.$ref));
    }
    return;
  }

  const patternProperties = (node.patternProperties ?? {}) as Record<string, JsonSchemaNode>;
  const additionalSchema = schemaValuedAdditional(node);
  if ((Object.keys(patternProperties).length > 0 || additionalSchema) && out.indexOf(pointer) === -1) {
    out.push(pointer);
  }

  const properties = (node.properties ?? {}) as Record<string, JsonSchemaNode>;
  for (const key of Object.keys(properties)) {
    collectMapNodes(properties[key], `${pointer}/${escapeSegment(key)}`, rootSchema, out, seen);
  }
  for (const pattern of Object.keys(patternProperties)) {
    collectMapNodes(patternProperties[pattern], `${pointer}/*`, rootSchema, out, seen);
  }
  if (additionalSchema) {
    collectMapNodes(additionalSchema, `${pointer}/*`, rootSchema, out, seen);
  }
  if (node.items) {
    collectMapNodes(node.items, `${pointer}/*`, rootSchema, out, seen);
  }
  for (const branch of Array.isArray(node.allOf) ? (node.allOf as JsonSchemaNode[]) : []) {
    if (!branch || typeof branch !== 'object') {
      continue;
    }
    // A conditional branch contributes its `then` at the same address; a composing one contributes
    // itself. The `if` is a test, not a shape, so nothing inside it is a node of the document.
    collectMapNodes(branch.if || branch.then ? (branch.then as JsonSchemaNode | undefined) : branch, pointer, rootSchema, out, seen);
  }
}

/** A schema-valued `additionalProperties`, or undefined for the booleans `true`/`false`. */
function schemaValuedAdditional(schema: JsonSchemaNode): JsonSchemaNode | undefined {
  const additional = schema.additionalProperties;
  return additional !== null && typeof additional === 'object' && !Array.isArray(additional)
    ? (additional as JsonSchemaNode)
    : undefined;
}

/**
 * The `mapEntries` marker for an object node, or undefined when the node is not a map.
 *
 * Exported for the one node a descriptor tree cannot carry the marker for: a SECTION that is itself
 * a map. `buildDescriptors` on an object section returns that section's children, not a descriptor
 * for the section itself, so the tab shell - which builds the section's own panel - asks this
 * directly with the section schema `groupSections` already resolved for it.
 *
 * `rootSchema` is REQUIRED, and deliberately has no "the schema is its own root" default. Not every
 * caller holds a `$ref`-free node: `groupSections` hands out sections expanded by `resolveRefsDeep`,
 * but `resolveGroupSchema` resolves only the GROUP's own top-level `$ref`, so
 * `providersGroup.additionalProperties` is still `{ $ref: '#/$defs/providerCommon' }`. Rooted at
 * itself that ref resolves to nothing, the value schema reads as typeless, and this would have
 * reported `providers` as a SCALAR-valued map seeded with `''` - a [+] that creates a provider as
 * the empty string. A required argument makes that a compile error instead of a silent wrong answer,
 * and the throw below catches the case where the root passed is simply the wrong one.
 *
 * A map is exactly what `buildChildren`'s second and third matching steps already read: a node
 * whose children can come from `patternProperties` or from a schema-valued `additionalProperties`.
 * The booleans declare nothing (`true` permits any value without describing it, `false` forbids the
 * key), so neither makes a map - the same rule `buildChildren` follows, which is why
 * `$defs/modelOverride` (open, `additionalProperties: true`) is an entry rather than a map itself.
 *
 * A node may declare BOTH named `properties` and a dynamic rule - `providers` names its five
 * readable providers, `hooks.defaults.<endpoint>` names `pseudonymization` - and is still a map:
 * the declared keys are entries the schema happens to be able to title.
 */
export function mapEntriesOf(schema: JsonSchemaNode, rootSchema: JsonSchemaNode): MapEntries | undefined {
  const patternProperties = (schema.patternProperties ?? {}) as Record<string, JsonSchemaNode>;
  const patterns = Object.keys(patternProperties);
  const additionalSchema = schemaValuedAdditional(schema);
  if (patterns.length === 0 && !additionalSchema) {
    return undefined;
  }

  // The value schema is the one an added key would be validated against. `patternProperties` wins
  // where a node has both, because draft-07 consults it first and no node in this schema declares
  // two patterns over one map - see `buildChildren`'s own note on the first-match rule.
  const rawValueSchema = patterns.length > 0 ? patternProperties[patterns[0]] : (additionalSchema as JsonSchemaNode);
  const valueSchema = composeAllOf(resolveRef(rawValueSchema, rootSchema), rootSchema);

  // A `$ref` still standing after resolution means `rootSchema` is not the root this node's refs
  // are written against. Everything below would then read a typeless schema and answer "a map of
  // scalars, seeded with the empty string" - a confident wrong answer that a [+] would act on. The
  // only honest reading of an unresolvable value schema is that the caller cannot be served.
  if (typeof valueSchema.$ref === 'string') {
    throw new Error(
      `mapEntriesOf: the value schema of this map is "${valueSchema.$ref}", which does not resolve ` +
        'against the rootSchema given - pass the schema those refs are written against (the whole ' +
        'api-config schema), not the subtree.'
    );
  }

  const propertyNames = schema.propertyNames as JsonSchemaNode | undefined;
  const keyPattern = patterns.length === 1
    ? patterns[0]
    : (typeof propertyNames?.pattern === 'string' ? propertyNames.pattern : undefined);

  const valueType = narrowType(valueSchema.type, undefined);
  const valueKind: MapEntries['valueKind'] =
    valueType === 'object' ? 'object' : valueType === 'array' ? 'array' : 'scalar';

  const entries: MapEntries = { valueKind };
  if (keyPattern !== undefined) {
    entries.keyPattern = keyPattern;
  }
  if (valueKind === 'scalar') {
    entries.scalarDefault = scalarSeed(valueSchema, true);
  }
  if (valueKind === 'object') {
    entries.valueSkeleton = skeletonOf(valueSchema, rootSchema);
  }

  // A non-restrictive suggestion list the node MAY declare beside its key rule - read from the map
  // CONTAINER's schema, not the value schema, because it names keys rather than describing a value.
  // Guarded to a non-empty array of strings and copied, so a malformed annotation is ignored rather
  // than trusted, and a later mutation of the entries cannot reach back into the schema. Left off
  // entirely when the node declares none, so `keyChoices`-free maps stay exactly as they were.
  const suggested = schema['x-keySuggestions'];
  if (Array.isArray(suggested) && suggested.length > 0 && suggested.every(s => typeof s === 'string')) {
    entries.keySuggestions = suggested.slice() as string[];
  }
  return entries;
}

/**
 * The value a scalar leaf starts at when nothing has been chosen for it yet: the schema's own
 * `default` when it declares one, else the first member of its `enum`, else the empty value of its
 * type.
 *
 * The `default` is consulted FIRST, and that ordering is load-bearing rather than cosmetic:
 * `platform.logging.components` is an enum (TRACE/DEBUG/INFO/WARN/ERROR) whose first member is
 * TRACE, and a component override added through the [+] must seed at INFO - the level the design
 * names, and by far the cheaper of the two to leave switched on by accident. That is expressed where
 * it belongs, as `"default": "INFO"` on that value in both schema copies, rather than as a pointer
 * keyed special case here; the backend's Ajv runs without `useDefaults`, so the annotation is read
 * by this form and changes no validation verdict anywhere.
 *
 * `booleanSeed` is the one place the two callers disagree. A map entry is added to SAY something -
 * an `observability.pseudonymization.entities` key exists to switch a category on - so a
 * boolean-valued map seeds `true`. An array element's skeleton is the opposite: it carries only
 * what the schema requires and asserts nothing, so a required boolean leaf there is `false`.
 *
 * A number with no `default` seeds its `minimum` rather than a flat 0, which is the same rule one
 * step less arbitrary: 0 is a value the schema may not even allow, and where it does allow it, it is
 * only the right seed because it happens to be the lowest one. `minimum` says that outright. The
 * seed a map's [+] is about to write is quoted in the add dialog's own hint (`ConfigFormMaps`), so
 * whichever number this returns is on screen before the entry exists rather than after.
 */
function scalarSeed(schema: JsonSchemaNode, booleanSeed: boolean): unknown {
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return (schema.enum as unknown[])[0];
  }
  switch (narrowType(schema.type, undefined)) {
    case 'boolean':
      return booleanSeed;
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    default:
      return '';
  }
}

/**
 * A new element of an array, from the item schema alone: an object carrying a value for each of its
 * REQUIRED properties and nothing else, recursively - so `$defs/hookEntryArray` yields
 * `{ request: { callback: { id: '' }, match: [] } }`, the smallest hook the schema's own `required`
 * describes. A required array leaf is `[]` and a required scalar leaf is its `scalarSeed`.
 *
 * Optional properties are left out rather than seeded empty: a key the operator never set must not
 * appear in the saved document, which is the same rule the round-trip harness holds every rendered
 * control to.
 *
 * A DISCRIMINATED item's variant-specific `then.required` is deliberately not folded in: which
 * variant a new element is has not been chosen at the moment the skeleton is built, and the sink
 * dialog (`sinkDefaults.ts`) is what creates those elements anyway.
 */
function skeletonOf(itemSchema: JsonSchemaNode, rootSchema: JsonSchemaNode): unknown {
  const schema = composeAllOf(resolveRef(itemSchema, rootSchema), rootSchema);
  const type = narrowType(schema.type, undefined);
  if (type === 'array') {
    return [];
  }
  if (type !== 'object') {
    return scalarSeed(schema, false);
  }
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
  const skeleton: Record<string, unknown> = {};
  for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      skeleton[key] = skeletonOf(properties[key], rootSchema);
    }
  }
  return skeleton;
}

/**
 * Whether a pointer names a SECTION or a MAP CONTAINER - the two things that stop rendering when
 * the document does not carry them.
 *
 * The rule, ledgered with this task: a section or map container absent from the document renders as
 * a notice and nothing else, because showing an unset section's fields at their schema defaults
 * reads as configuration that is in force and is not. A nested optional object INSIDE a present
 * section keeps the behaviour it has always had - `capabilities.file_search.hybrid.rerank` inside a
 * present `file_search` still renders its controls at their defaults, and nothing is written unless
 * the operator changes one. That is deliberate: the operator has opened a section they configured,
 * and its sub-blocks are fields of it rather than sections of their own.
 *
 * "Section" is measured by depth rather than by a list: `/api_config/<group>/<section>` is three
 * segments, and the two shallower pointers (`/api_config`, `/api_config/<group>`) are the document
 * and a whole tab. A map container is a section wherever it sits - `platform.logging.components` is
 * four segments deep and is still a container an operator adds keys to rather than a field.
 */
function namesAContainer(pointer: string, mapEntries: MapEntries | undefined): boolean {
  if (mapEntries) {
    return true;
  }
  const segments = splitPointer(pointer);
  return segments.length > 0 && segments.length <= 3 && segments[0] === 'api_config';
}

/** The rendering of a container the document does not carry: the marker, and no children at all. */
function absentSection(
  schema: JsonSchemaNode,
  pointer: string,
  label: string,
  mapEntries: MapEntries | undefined
): Descriptor {
  return withDescription({
    kind: 'section',
    pointer,
    label,
    absent: true,
    ...(mapEntries ? { mapEntries } : {}),
    children: []
  }, schema);
}

/**
 * The order the form shows an object's DECLARED keys in: the schema's declaration order, always,
 * whether or not the document carries a given key.
 *
 * The one rule for both halves of the form - a group's sections
 * (`apiConfigGroups.groupSectionKeys`) and an object's fields (`buildChildren`) - so neither half
 * reshuffles as the document is filled in. This once ordered present keys first (document order),
 * then absent ones (schema order); that made a partially-filled section rearrange itself as keys
 * were added. Under `platform.rate_limit_handling`, adding the empty maps `model_specific_delays`
 * and `subpath_specific_delays` pushed the still-unset scalar fields (`enabled`,
 * `default_delay_seconds`, `backoff_multiplier`, `max_delay_seconds`) below BOTH map panels - they
 * looked to the operator as if they had vanished into whichever panel now sat above them, though no
 * data was ever lost (the maps were empty `{}` and the scalars were simply unset). A fixed schema
 * order keeps every declared key in its place, present or absent, so a section never reshuffles.
 *
 * This function only ever orders DECLARED keys - a schema `properties` member (its two callers hand
 * in exactly those: the six tabs and a group's sections). A map's own DYNAMIC entries have no
 * schema order of their own and are ordered elsewhere by document (creation) order - see the
 * assembly at the end of `buildChildren`.
 *
 * `declared` is returned unchanged; `data` is no longer consulted, but the signature stays stable
 * for its two callers (`_data` marks it deliberately unused).
 */
export function documentOrderedKeys(declared: string[], _data: unknown): string[] {
  return declared;
}

function buildChildren(
  schema: JsonSchemaNode,
  data: unknown,
  pointer: string,
  rootSchema: JsonSchemaNode,
  resolvePlugin: PluginResolver,
  unknownReason: (key: string) => string = key => `No schema defines property "${key}".`
): Descriptor[] {
  const properties = schema.properties ?? {};
  const dataObj =
    data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};

  // The schema says which of its own properties are mandatory; a form that discards that makes
  // the user find out from the backend. For a discriminated array element the list handed in
  // here already carries the variant's `then.required` too - see buildItemSection.
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // Built keyed by the key rather than into a list, because WHICH descriptors these are and in
  // WHAT ORDER they are shown are now two separate questions - see `documentOrderedKeys` and the
  // assembly at the end of this function.
  const declaredKeys = Object.keys(properties);
  const byKey = new Map<string, Descriptor>();
  for (const key of declaredKeys) {
    const childSchema = properties[key];
    const childPointer = `${pointer}/${escapeSegment(key)}`;
    const label = (childSchema && typeof childSchema.title === 'string' && childSchema.title) || labelFor(key);
    const descriptor = buildNode(childSchema, dataObj[key], childPointer, rootSchema, label, resolvePlugin);
    byKey.set(key, required.indexOf(key) === -1 ? descriptor : markRequired(descriptor));
  }

  // A data key not named in `properties` may still be declared through a regex in
  // `patternProperties` (`platform.logging.components`, `platform.rate_limit_handling`'s two delay
  // maps, `hooks.definitions`) - the same dynamic-key shape `validateSection.ts` already reads (see
  // its own comment). Such a key gets a real descriptor from its matching subschema, exactly like a
  // declared property does, rather than falling to the generic `raw`/unknown path below: an
  // administrator editing rate_limit_handling.model_specific_delays should see a number field per
  // model, not one opaque JSON blob per model. The first matching pattern wins - this schema never
  // declares two patterns over the same map, so this only guards against a hypothetical future one
  // producing a duplicate row for the same key.
  const patternProperties = (schema.patternProperties ?? {}) as Record<string, JsonSchemaNode>;
  const patternEntries = Object.keys(patternProperties).map(pattern => ({
    regex: new RegExp(pattern),
    subschema: patternProperties[pattern]
  }));
  const patternMatched = new Set<string>();
  if (patternEntries.length > 0) {
    for (const key of Object.keys(dataObj)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        continue;
      }
      const entry = patternEntries.find(({ regex }) => regex.test(key));
      if (!entry) {
        continue;
      }
      patternMatched.add(key);
      const childPointer = `${pointer}/${escapeSegment(key)}`;
      byKey.set(key, buildNode(entry.subschema, dataObj[key], childPointer, rootSchema, labelFor(key), resolvePlugin));
    }
  }

  // A key neither `properties` nor `patternProperties` declares may still be declared by a
  // schema-valued `additionalProperties` - draft-07's third and last matching step, and the shape
  // every dynamically-keyed map in this document uses (`providers`' per-provider entries,
  // `models.overrides`' per-model entries, `hooks.defaults`' per-endpoint entries, and
  // `param_renames`' per-parameter strings). Such a key gets a real descriptor from that subschema,
  // exactly like a declared property does, rather than falling to the `raw` path below: an
  // administrator editing a per-model override should see its fields, not one opaque JSON blob per
  // model. The boolean forms declare nothing - `true` permits any value without describing it,
  // `false` forbids the key outright - so both leave the key on the `raw` path, which is where a
  // value the schema does not describe belongs.
  const additionalProperties = schema.additionalProperties;
  const additionalSchema =
    additionalProperties !== null && typeof additionalProperties === 'object' && !Array.isArray(additionalProperties)
      ? (additionalProperties as JsonSchemaNode)
      : undefined;

  const undeclared = Object.keys(dataObj).filter(
    key => !Object.prototype.hasOwnProperty.call(properties, key) && !patternMatched.has(key)
  );

  for (const key of undeclared) {
    const childPointer = `${pointer}/${escapeSegment(key)}`;
    byKey.set(
      key,
      additionalSchema
        ? buildNode(additionalSchema, dataObj[key], childPointer, rootSchema, labelFor(key), resolvePlugin)
        // A data key nothing at all declares must still surface - as `raw`, not silently dropped -
        // or an administrator editing through the form cannot see it exists at all.
        : rawDescriptor(childPointer, labelFor(key), dataObj[key], unknownReason(key))
    );
  }

  // Declared properties in SCHEMA order (present or absent alike), then the document's DYNAMIC keys
  // (pattern-matched, `additionalProperties`-matched or `raw`) in document (creation) order - the
  // same split `documentOrderedKeys` makes for a group's sections. Schema order keeps a section's
  // layout stable: an unset scalar field no longer floats below a present map and reshuffles when
  // another map is added (which read to the operator as fields "vanishing" - see
  // `documentOrderedKeys` for the rate_limit_handling report). A map's own entries have no schema
  // order of their own, so they must keep their creation order; walking the document's keys for the
  // dynamic half preserves it. Every data key has a descriptor by now (declared, pattern-matched,
  // `additionalProperties`-matched or `raw`), so nothing is dropped, and a declared key that is
  // also in the document goes only into the declared half - `dynamicShown` excludes anything in
  // `properties` - so no key is shown twice.
  const declaredShown = declaredKeys.filter(key => byKey.has(key)); // every declared key has a byKey entry
  const dynamicShown = Object.keys(dataObj).filter(
    key => byKey.has(key) && !Object.prototype.hasOwnProperty.call(properties, key)
  );
  return declaredShown.concat(dynamicShown).map(key => byKey.get(key) as Descriptor);
}

/**
 * Folds an object schema's composing `allOf` branches into the node itself, so a schema written as
 * "everything `$defs/providerCommon` says, plus these extra fields" renders as one set of fields
 * rather than as nothing at all. The five `providers` entries are the such nodes in this schema:
 * each is a bare `{ allOf: [ { $ref: providerCommon }, <its own extension> ] }` with no `type` and no
 * `properties` of its own, so without this every one of their fields - the six common ones and
 * whatever that provider adds - degrades to a single `raw` JSON blob for the whole provider.
 *
 * Only a branch that composes is folded. A branch carrying `if`/`then` is a *conditional*, not a
 * contribution: its fields apply only to one variant, and `discriminationOf` reads exactly that
 * shape to split an array's elements into per-variant sections. Those branches are left in `allOf`
 * untouched, so this changes nothing for the sink and hook-definition arrays that use them.
 *
 * A property the node declares itself wins over a branch's, and `type` is only borrowed when the
 * node states none. `additionalProperties` is deliberately NOT inherited from a branch: draft-07
 * scopes it to the schema object that declares it - which is exactly why a composed node cannot be
 * closed with an `additionalProperties: false` of its own (it would reject the branch's own fields)
 * and the five providers are closed with `propertyNames` instead - so copying a branch's up here
 * would describe keys the composed node does not actually declare.
 */
function composeAllOf(schema: JsonSchemaNode, rootSchema: JsonSchemaNode): JsonSchemaNode {
  const branches = schema && Array.isArray(schema.allOf) ? (schema.allOf as JsonSchemaNode[]) : [];
  const composing = branches.filter(branch => branch && typeof branch === 'object' && !branch.if && !branch.then);
  if (composing.length === 0) {
    return schema;
  }

  const out: JsonSchemaNode = { ...schema };
  const properties: Record<string, JsonSchemaNode> = { ...(schema.properties ?? {}) };
  const required: string[] = Array.isArray(schema.required) ? [...(schema.required as string[])] : [];

  for (const branch of composing) {
    const resolved = composeAllOf(resolveRef(branch, rootSchema), rootSchema);
    const branchProperties = (resolved.properties ?? {}) as Record<string, JsonSchemaNode>;
    for (const key of Object.keys(branchProperties)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        properties[key] = branchProperties[key];
      }
    }
    for (const key of Array.isArray(resolved.required) ? (resolved.required as string[]) : []) {
      if (required.indexOf(key) === -1) {
        required.push(key);
      }
    }
    if (out.type === undefined && resolved.type !== undefined) {
      out.type = resolved.type;
    }
  }

  if (Object.keys(properties).length > 0) {
    out.properties = properties;
  }
  if (required.length > 0) {
    out.required = required;
  }
  const conditional = branches.filter(branch => composing.indexOf(branch) === -1);
  if (conditional.length > 0) {
    out.allOf = conditional;
  } else {
    delete out.allOf;
  }
  return out;
}

/** Dispatches a single schema+data node to a Descriptor, per the renderer's rendering rules. */
function buildNode(
  rawSchema: JsonSchemaNode,
  data: unknown,
  pointer: string,
  rootSchema: JsonSchemaNode,
  label: string,
  resolvePlugin: PluginResolver
): Descriptor {
  // Rule 1: a registered plugin owns this pointer. The value is deliberately never read here,
  // so a credential slot's value can never end up in a descriptor.
  const plugin = resolvePlugin(pointer);
  if (plugin) {
    return { kind: 'plugin', pointer, label, plugin, value: undefined };
  }

  const schema = composeAllOf(resolveRef(rawSchema, rootSchema), rootSchema);

  if (!schema || typeof schema !== 'object') {
    return rawDescriptor(pointer, label, data, 'No schema is defined for this node.');
  }

  const declaredType = schema.type;

  // Rule 2: schema type does not match the data's actual type -> degrade visibly.
  //
  // Absent is not mismatched. A property the document simply does not carry - every optional
  // field of a sink that has not set it - is empty, and renders as an empty control below. Sent
  // through the mismatch path instead it would degrade to `raw`, whose JSON snippet for a missing
  // value is the literal text "null"; that is what filled the screen before.
  if (data !== undefined && declaredType !== undefined && !typeMatches(declaredType, data)) {
    const expected = Array.isArray(declaredType) ? declaredType.join(' | ') : declaredType;
    return rawDescriptor(pointer, label, data, `Expected type "${expected}", got "${actualType(data)}".`);
  }

  const schemaType = narrowType(declaredType, data);

  // Rule 3: enum -> select; array of enum-constrained strings -> list.
  if (Array.isArray(schema.enum)) {
    // Absent data falls back to the schema's own `default` when it declares one, rather than
    // unconditionally `''` - an empty string is not itself a member of `enum`, so a leaf built
    // from truly missing data (an optional key the document never set, e.g.
    // observability.pseudonymization.method) would otherwise carry a value the schema's own
    // enum rejects. `?? ''` remains the fallback for the (today, none) enum field with no
    // declared default, preserving prior behavior exactly for every other select.
    //
    // Membership, not string-ness, is the test: since an enum may now hold non-string members, a
    // `default: false` screened out by a `typeof === 'string'` check would fall through to `''`,
    // which keys no item and renders an EMPTY Select on a field the schema says has a default.
    // No node in this schema is shaped that way today; this keeps the rule true for one that is.
    const members = schema.enum as unknown[];
    // `===` is enough: every member of every enum in this schema is a scalar, and a schema parsed
    // from JSON can never hold `undefined`, so an absent `default` matches nothing.
    const fallback = members.indexOf(schema.default) === -1 ? '' : (schema.default as string | boolean);
    const descriptor: Extract<Descriptor, { kind: 'select' }> = {
      kind: 'select',
      pointer,
      label,
      // The member itself, not a rendering of it: the round trip writes a descriptor's own value
      // back into the document, so a boolean member has to survive as a boolean. `options` below
      // is the string the control shows and keys on; `optionValues` is how it gets back here.
      value: (data as string | boolean) ?? fallback,
      options: members.map(member => (typeof member === 'string' ? member : String(member)))
    };
    // Only for an enum this cannot represent as strings alone - see `optionValues` on `Descriptor`.
    // An all-string enum (every other one in this schema) keeps exactly the descriptor it had.
    if (members.some(member => typeof member !== 'string')) {
      descriptor.optionValues = members;
    }
    return withDescription(descriptor, schema);
  }
  if (schemaType === 'array' && schema.items && Array.isArray(schema.items.enum)) {
    return withDescription({
      kind: 'list',
      pointer,
      label,
      values: Array.isArray(data) ? (data as string[]) : [],
      options: schema.items.enum as string[]
    }, schema);
  }
  // A plain string array with no `enum` (org_suffixes, location_gazetteer,
  // excluded_beta_headers, ...) is free text rather than a fixed choice, so `options` is left
  // unset - `list`'s own type already allows that (see its comment) - rather than degrading to
  // `raw` for lack of a table representation, the array-of-objects path below is built for.
  if (schemaType === 'array' && schema.items && schema.items.type === 'string' && !schema.items.enum) {
    return withDescription({
      kind: 'list',
      pointer,
      label,
      values: Array.isArray(data) ? (data as string[]) : []
    }, schema);
  }

  // Rule 4: plain scalars.
  if (schemaType === 'boolean') {
    return withDescription({ kind: 'switch', pointer, label, value: data === true }, schema);
  }
  if (schemaType === 'integer' || schemaType === 'number') {
    // `integer` is the type as the schema DECLARED it, not as the datum happens to look: a float
    // field holding a round 0.5-less value is still a float, and the control must let a decimal be
    // typed into it. `schemaType` is the narrowed declared type, so this reads the schema, not data.
    const descriptor: Extract<Descriptor, { kind: 'number' }> = {
      kind: 'number',
      pointer,
      label,
      value: data as number,
      integer: schemaType === 'integer'
    };
    if (typeof schema.multipleOf === 'number') descriptor.multipleOf = schema.multipleOf;
    if (typeof schema.minimum === 'number') descriptor.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') descriptor.maximum = schema.maximum;
    return withDescription(descriptor, schema);
  }
  if (schemaType === 'string') {
    const descriptor: Extract<Descriptor, { kind: 'text' }> = { kind: 'text', pointer, label, value: data as string };
    if (typeof schema.pattern === 'string') descriptor.pattern = schema.pattern;
    if (typeof schema.minLength === 'number') descriptor.minLength = schema.minLength;
    if (typeof schema.maxLength === 'number') descriptor.maxLength = schema.maxLength;
    return withDescription(descriptor, schema);
  }

  // Rule 5: object -> section; array of objects -> table.
  if (schemaType === 'object') {
    const mapEntries = mapEntriesOf(schema, rootSchema);
    if (data === undefined && namesAContainer(pointer, mapEntries)) {
      return absentSection(schema, pointer, label, mapEntries);
    }
    return withDescription({
      kind: 'section',
      pointer,
      label,
      ...(mapEntries ? { mapEntries } : {}),
      children: buildChildren(schema, data, pointer, rootSchema, resolvePlugin)
    }, schema);
  }
  if (schemaType === 'array') {
    const itemSchema = resolveRef(schema.items ?? {}, rootSchema);
    if (itemSchema && itemSchema.type === 'object') {
      // Two reasons an array of objects cannot be a table, and either one is enough.
      //
      // It discriminates: the columns would be the union of every variant's fields, so each row is
      // mostly cells that do not apply to it.
      //
      // Or one of its fields does not fit in a table cell. A cell is a single control, and
      // `descriptorControls.ts`'s `buildField` has a case for each scalar, for `list` and for
      // `plugin` - but none for `section` or `table`, so such a cell renders the placeholder "This
      // value cannot be shown in the form. Use the JSON editor." That is what
      // `hooks.defaults.<endpoint>.<subpath>` hit: one column, `request`, whose value is an object,
      // so every hook in the shipped configuration was a row of placeholders. The array is
      // therefore probed against the same `buildField` contract below rather than by guessing which
      // schema shapes are scalar - see `itemFitsATableRow`.
      const discrimination = discriminationOf(itemSchema);
      if (discrimination || !itemFitsATableRow(itemSchema, pointer, rootSchema, resolvePlugin)) {
        const items = Array.isArray(data) ? (data as unknown[]) : [];
        return withDescription({
          kind: 'section',
          pointer,
          label,
          // Every array rendered as sections is marked, not only a discriminated one: a hook list is
          // exactly as appendable as the sink array, and what separated them was which dialog the
          // form happened to have. What the marker carries is that difference itself - whether the
          // element picks its fields by a discriminator (the sink dialog's case) and what a new
          // element of this array looks like - so the control layer can offer a generic [+] and the
          // sink dialog stays the special case rather than the only case.
          arrayItems: { discriminated: discrimination !== undefined, skeleton: skeletonOf(itemSchema, rootSchema) },
          children: items.map((item, index) =>
            buildItemSection(itemSchema, item, `${pointer}/${index}`, index, rootSchema, discrimination, resolvePlugin)
          )
        }, schema);
      }

      const columns = Object.keys(itemSchema.properties ?? {});
      const rowsData = Array.isArray(data) ? (data as unknown[]) : [];
      const rows = rowsData.map((rowData, index) =>
        columns.map(column => {
          const columnSchema = (itemSchema.properties ?? {})[column];
          const cellPointer = `${pointer}/${index}/${escapeSegment(column)}`;
          const cellValue =
            rowData !== null && typeof rowData === 'object' ? (rowData as Record<string, unknown>)[column] : undefined;
          return buildNode(columnSchema, cellValue, cellPointer, rootSchema, labelFor(column), resolvePlugin);
        })
      );
      return withDescription({ kind: 'table', pointer, label, columns, rows }, schema);
    }
    return rawDescriptor(pointer, label, data, 'Array item schema is not an object; no table representation.');
  }

  // Rule 6: anything else degrades visibly rather than being dropped.
  return rawDescriptor(pointer, label, data, `Unsupported schema shape (type: "${String(schemaType)}").`);
}

function rawDescriptor(pointer: string, label: string, data: unknown, reason: string): Descriptor {
  return { kind: 'raw', pointer, label, json: safeStringify(data), reason };
}

/** Every descriptor kind that can carry the schema's own description. See `Descriptor`. */
type DescribableDescriptor = Exclude<Descriptor, { kind: 'raw' } | { kind: 'plugin' }>;

/**
 * Attaches the schema's `description` to a descriptor.
 *
 * A schema with no description - or an empty one - adds no key at all rather than an empty
 * string, so the control layer can render no tooltip instead of a blank one, and so a
 * descriptor a caller spreads never gains a key it did not have (the same rule the required
 * marker follows).
 */
function withDescription(descriptor: DescribableDescriptor, schema: JsonSchemaNode): Descriptor {
  const description = schema.description;
  if (typeof description !== 'string' || description.length === 0) {
    return descriptor;
  }
  return { ...descriptor, description };
}

/**
 * Flags a descriptor as mandatory. A `section` or a `table` is a container rather than a field -
 * there is no single control to mark - so those are left alone; their own required children are
 * marked individually when their children are built.
 */
function markRequired(descriptor: Descriptor): Descriptor {
  if (descriptor.kind === 'section' || descriptor.kind === 'table') {
    return descriptor;
  }
  return { ...descriptor, required: true };
}

/**
 * How an item schema's `allOf` branches split its flat property list into variants: which
 * property they switch on, which fields each value of it owns, and which are left over and
 * therefore common to every variant.
 */
interface Discrimination {
  /** The property whose value selects the variant, e.g. a sink's `type`. */
  key: string;
  /** Variant value -> the fields that variant declares, required and optional alike. */
  fieldsByValue: Record<string, string[]>;
  /**
   * Variant value -> the subset of those fields the variant's `then.required` makes mandatory.
   * Read here rather than in the caller so the two halves of a variant's contract - which fields
   * it owns and which of them it insists on - come from one reading of the same branch.
   */
  requiredByValue: Record<string, string[]>;
  /** Fields no variant claims, so every item shows them. */
  common: string[];
}

/**
 * Reads `if`/`then` discrimination out of an item schema's `allOf`, or returns undefined when it
 * has none and the generic representation applies.
 *
 * Deliberately all-or-nothing: every branch must switch on the same property against a string
 * `const`, or this returns undefined. A partial reading would hide the fields of whichever branch
 * was not understood, and hiding a field an administrator has set is worse than a wide table.
 *
 * A variant's fields come from `then.properties` and `then.required` together. `required` alone
 * is not enough - a type-specific *optional* field is in no branch's `required`, so reading only
 * that would leave it claimed by no variant and shown on all of them.
 */
function discriminationOf(itemSchema: JsonSchemaNode): Discrimination | undefined {
  const branches = itemSchema.allOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const declared = itemSchema.properties ?? {};
  const fieldsByValue: Record<string, string[]> = {};
  const requiredByValue: Record<string, string[]> = {};
  let key: string | undefined;

  for (const branch of branches as JsonSchemaNode[]) {
    const condition = branch?.if as JsonSchemaNode | undefined;
    const consequent = branch?.then as JsonSchemaNode | undefined;
    const conditionProperties = condition?.properties;
    if (!conditionProperties || !consequent) {
      return undefined;
    }

    const conditionKeys = Object.keys(conditionProperties);
    if (conditionKeys.length !== 1) {
      return undefined;
    }
    if (key === undefined) {
      key = conditionKeys[0];
    } else if (key !== conditionKeys[0]) {
      return undefined;
    }

    const value = conditionProperties[conditionKeys[0]]?.const;
    if (typeof value !== 'string') {
      return undefined;
    }

    const mandatory = Array.isArray(consequent.required) ? (consequent.required as string[]) : [];
    const named = Object.keys(consequent.properties ?? {}).concat(mandatory);
    // A branch may only claim fields the item itself declares; anything else is not a field.
    const owned = (field: string, index: number, all: string[]): boolean =>
      all.indexOf(field) === index && Object.prototype.hasOwnProperty.call(declared, field);
    fieldsByValue[value] = named.filter(owned);
    requiredByValue[value] = mandatory.filter(owned);
  }

  if (key === undefined) {
    return undefined;
  }

  const claimed = Object.keys(fieldsByValue).reduce<string[]>((all, value) => all.concat(fieldsByValue[value]), []);
  const common = Object.keys(declared).filter(field => claimed.indexOf(field) === -1);

  return { key, fieldsByValue, requiredByValue, common };
}

/**
 * Whether every column an item schema would produce fits in a table cell.
 *
 * Measured, not predicted: each property is sent through `buildNode` with no data - exactly the
 * call the table's own cell building makes - and the resulting descriptor kind is checked against
 * the kinds `descriptorControls.ts`'s `buildField` actually has a case for. Deriving it from the
 * schema instead (\"an object property means no table\") would be a second copy of `buildNode`'s
 * dispatch rules, free to drift from the real one; this cannot drift, because it IS the real one.
 *
 * The allowlist is deliberately positive: a descriptor kind added later is unhostable here until
 * someone teaches `buildField` about it, which fails towards the readable per-element sections
 * rather than towards a table of placeholders. It is the same set as `descriptorControls.ts`'s own
 * `FIELD_KINDS` - the kinds that module renders as a field rather than as a Panel of its own - and
 * cannot simply import it: that module pulls in `sap/*`, which this suite cannot resolve.
 *
 * `raw` counts as hostable because `buildField` renders it (compactly, with its reason as a
 * tooltip) - and a `raw` cell is caught by the round-trip gate's own raw-free assertion anyway,
 * which is a better error than silently reshaping the array around it.
 *
 * Exported so `test/sectionRoundTrip.test.ts` can hold every registered section to the same list
 * rather than keeping a second copy of it: a `table` whose rows contain a cell kind outside this
 * list is a panel of placeholders, and the gate fails for it exactly as it fails for a `raw`.
 */
export const TABLE_CELL_KINDS = ['switch', 'number', 'select', 'text', 'list', 'plugin', 'raw'];

function itemFitsATableRow(
  itemSchema: JsonSchemaNode,
  pointer: string,
  rootSchema: JsonSchemaNode,
  resolvePlugin: PluginResolver
): boolean {
  const properties = (itemSchema.properties ?? {}) as Record<string, JsonSchemaNode>;
  return Object.keys(properties).every(column => {
    const probe = buildNode(
      properties[column],
      undefined,
      `${pointer}/0/${escapeSegment(column)}`,
      rootSchema,
      labelFor(column),
      resolvePlugin
    );
    return TABLE_CELL_KINDS.indexOf(probe.kind) !== -1;
  });
}

/**
 * One array element as its own section: the common fields plus the fields its discriminator value
 * claims, in the item schema's own declaration order so the section reads in the same order as
 * the JSON editor shows the object.
 *
 * `discrimination` is undefined for an array that has no variants but still cannot be a table (see
 * `itemFitsATableRow`) - a hook entry of `$defs/hookEntryArray`, whose one field is an object. Such
 * an element shows every field the item schema declares, since there is no variant to narrow to. It
 * carries an `arrayIndex` all the same: every element of an appendable array is removable.
 *
 * The section is labelled with the element's `name` and does not repeat it as a field - the label
 * is where it is shown. Without a usable name the label falls back to the discriminator value,
 * then to the element's index.
 *
 * Fields of the *other* variants are not rendered: they do not apply. Should the element carry a
 * value in one anyway, it is not dropped - it surfaces as `raw`, saying which variant it belongs
 * to, because a value an administrator cannot see is a value they cannot remove.
 *
 * The discriminator itself is marked read-only. It selects which fields this section shows, so
 * editing it in place would leave the previous variant's controls on screen holding values the new
 * variant does not declare. It is fixed when the element is created instead; that is what makes
 * "the fields shown always belong to the type shown" true by construction rather than by timing.
 */
function buildItemSection(
  itemSchema: JsonSchemaNode,
  item: unknown,
  pointer: string,
  index: number,
  rootSchema: JsonSchemaNode,
  discrimination: Discrimination | undefined,
  resolvePlugin: PluginResolver
): Descriptor {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return rawDescriptor(pointer, `#${index}`, item, `Expected type "object", got "${actualType(item)}".`);
  }

  const element = item as Record<string, unknown>;
  const declared = itemSchema.properties ?? {};
  const variant = discrimination ? element[discrimination.key] : undefined;
  const variantFields = discrimination && typeof variant === 'string'
    ? discrimination.fieldsByValue[variant] ?? []
    : [];

  const nameValue = element.name;
  const hasName = Object.prototype.hasOwnProperty.call(declared, 'name')
    && typeof nameValue === 'string'
    && nameValue.length > 0;
  const label = hasName
    ? (nameValue as string)
    : (typeof variant === 'string' && variant.length > 0 ? variant : `#${index}`);

  // With no variants there is nothing to narrow to, so every declared field is shown.
  const shown = discrimination ? discrimination.common.concat(variantFields) : Object.keys(declared);
  const properties: Record<string, JsonSchemaNode> = {};
  for (const field of Object.keys(declared)) {
    if (shown.indexOf(field) !== -1) {
      properties[field] = declared[field];
    }
  }

  // What this element must carry: the item schema's own `required` plus the ones this variant's
  // `then.required` adds. A webhook's `url` is mandatory only because the element is a webhook,
  // so it can only be known here, where the variant is known.
  const ownRequired = Array.isArray(itemSchema.required) ? (itemSchema.required as string[]) : [];
  const variantRequired = discrimination && typeof variant === 'string'
    ? discrimination.requiredByValue[variant] ?? []
    : [];
  const required = ownRequired
    .concat(variantRequired)
    .filter((field, index, all) => all.indexOf(field) === index);

  const children = buildChildren(
    { ...itemSchema, properties, required },
    element,
    pointer,
    rootSchema,
    resolvePlugin,
    field => discrimination && Object.prototype.hasOwnProperty.call(declared, field)
      ? `Property "${field}" does not belong to ${discrimination.key} "${String(variant)}".`
      : `No schema defines property "${field}".`
  );

  // `name` stays in the schema handed to buildChildren - dropping it there would make the
  // element's own name look like a property no schema declares - and its descriptor is removed
  // afterwards, once it has served as the label.
  const namePointer = `${pointer}/name`;
  const discriminatorPointer = discrimination ? `${pointer}/${escapeSegment(discrimination.key)}` : undefined;

  return {
    kind: 'section',
    pointer,
    label,
    // Collapsed: an array of these is a list to scan first and open second.
    collapsed: true,
    // EVERY element of an array rendered as sections is removable, not only a discriminated one.
    // `arrayItems` marks the container as appendable whatever its elements are (see the array branch
    // in `buildNode`), and an element that can be added and not taken away again is a trap: a hook
    // appended by the [+] starts incomplete by design - `callback.id` and one `match` rule are the
    // operator's to supply - so a mistaken press could otherwise only be undone in the JSON editor.
    // Which confirmation the [-] raises is the control layer's business: a sink's names its stored
    // credentials, any other element names its index.
    arrayIndex: index,
    // The discriminator is read-only (fixed at creation, above), so its own `required` marker is
    // dropped here too, not set to `false` - a descriptor a caller spreads must not gain a key
    // (see the same rule for an unmarked optional field, above in buildChildren). The schema does
    // mandate it, but a marker means "you must supply this", and there is nothing to supply on a
    // control the administrator cannot edit.
    children: (hasName ? children.filter(child => child.pointer !== namePointer) : children).map(child => {
      if (child.pointer !== discriminatorPointer || child.kind !== 'select') {
        return child;
      }
      const { required: _required, ...rest } = child;
      return { ...rest, readOnly: true };
    })
  };
}

/**
 * The single type the rules above dispatch on, for a schema whose `type` is a union.
 *
 * Draft-07 lets `type` be a list, and each of those rules asks for one type: a node declared
 * `["string", "number", "boolean"]` matched none of them and fell through to `raw`, so the whole
 * property rendered as a JSON blob however well the schema described it. `hooks.definitions`'
 * `equals` is the node that needs this - the value a rule compares against is a string for a
 * `header` rule and whatever the request body carries for a `json-path` one (`payload:maxTokens512`
 * compares against the number 512), so no single type is honest for it.
 *
 * Narrowing is by the data's own type, so 512 gets a number field and "cli" a text field. The data
 * has already been checked against the whole union by Rule 2 above, so a member always matches when
 * there is data at all; with no data to narrow by - an optional union the document never set - the
 * first member is used, which renders an empty control of that type rather than a blob.
 */
function narrowType(schemaType: string | string[] | undefined, data: unknown): string | string[] | undefined {
  if (!Array.isArray(schemaType) || schemaType.length === 0) {
    return schemaType;
  }
  if (data !== undefined) {
    const match = schemaType.filter(t => typeMatches(t, data));
    if (match.length > 0) {
      return match[0];
    }
  }
  return schemaType[0];
}

function typeMatches(schemaType: string | string[], data: unknown): boolean {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const at = actualType(data);
  return types.some(t => {
    if (t === 'integer') return at === 'number' && Number.isInteger(data as number);
    return t === at;
  });
}

function actualType(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  return typeof data;
}

/**
 * Resolves a `$ref` against `rootSchema`, following chained refs with a cycle guard. Exported so
 * the document gate (`./documentGate`) can reuse the same resolution `buildDescriptors` relies on,
 * rather than teaching `validateSection` about `$ref` - see that module's own header.
 */
export function resolveRef(schema: JsonSchemaNode, rootSchema: JsonSchemaNode, seen = new Set<string>()): JsonSchemaNode {
  if (!schema || typeof schema.$ref !== 'string') {
    return schema;
  }
  if (seen.has(schema.$ref)) {
    return schema;
  }
  seen.add(schema.$ref);

  const resolved = resolvePointerInSchema(rootSchema, schema.$ref);
  if (!resolved) {
    return schema;
  }
  return resolveRef(resolved, rootSchema, seen);
}

/**
 * Expands every `$ref` reachable through `properties`, `patternProperties`, a schema-valued
 * `additionalProperties`, `items` and `allOf` (`if`/`then` included), returning a self-contained
 * schema - one that can be used as its own root, because nothing inside it points outside itself
 * any more.
 *
 * Two callers need exactly this. `documentGate.ts` validates a group with `validateSection`, which
 * has no `$ref` support at all (see its header) and would read an unexpanded `{ "$ref": ... }` as
 * an empty schema that accepts everything - a fail-OPEN gate. `apiConfigGroups.ts` hands each
 * section's schema to `buildDescriptors`, which treats the schema it is given as the root for
 * `resolveRef`: a `$ref` living inside a section (`$defs/providerCommon`, under the `allOf` of
 * every one of the five providers) cannot be resolved from the section subtree, so without this the
 * whole provider degraded to one `raw` JSON blob.
 *
 * Structural sharing is deliberate: a node containing no `$ref` anywhere below it is returned as
 * itself, not as a copy. A `$ref`-free section (every one but the providers) is therefore still
 * the very object the schema module holds, so a caller comparing the two by identity is comparing
 * the same schema rather than a snapshot of it, and building the tab strip does not clone the whole
 * document schema. Nothing here mutates its input.
 *
 * `seen` guards a chain of `$ref`s repeating along one path from root to leaf; the same `$ref` used
 * from two different branches (`providerCommon` from each of the five providers) is not a cycle
 * and must not be treated as one, so a fresh copy of `seen` is threaded per branch rather than one
 * set mutated across the whole walk.
 */
export function resolveRefsDeep(
  node: JsonSchemaNode | undefined,
  rootSchema: JsonSchemaNode,
  seen: Set<string> = new Set<string>()
): JsonSchemaNode {
  if (!node || typeof node !== 'object') {
    // No schema at all: an empty schema, the same as `validateSection` treats a missing one.
    return {};
  }

  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) {
      // A real cycle: nothing safe to expand further. An empty schema accepts everything, same as
      // an unresolved ref would - but a cycle in this fixed, hand-authored schema would itself be a
      // defect the drift test's byte-equality assertion cannot catch, so this path guards against a
      // bug elsewhere rather than a case this schema exercises.
      return {};
    }
    const resolved = resolveRef(node, rootSchema);
    if (resolved === node) {
      // Dangling ref: the canonical schema itself would be broken. Nothing to expand.
      return node;
    }
    return resolveRefsDeep(resolved, rootSchema, new Set(seen).add(node.$ref));
  }

  const out: JsonSchemaNode = { ...node };
  let changed = false;

  if (node.properties) {
    const properties: Record<string, JsonSchemaNode> = {};
    for (const key of Object.keys(node.properties)) {
      properties[key] = resolveRefsDeep(node.properties[key], rootSchema, seen);
      changed = changed || properties[key] !== node.properties[key];
    }
    out.properties = properties;
  }

  const nodePatternProperties = node.patternProperties as Record<string, JsonSchemaNode> | undefined;
  if (nodePatternProperties) {
    const patternProperties: Record<string, JsonSchemaNode> = {};
    for (const pattern of Object.keys(nodePatternProperties)) {
      patternProperties[pattern] = resolveRefsDeep(nodePatternProperties[pattern], rootSchema, seen);
      changed = changed || patternProperties[pattern] !== nodePatternProperties[pattern];
    }
    out.patternProperties = patternProperties;
  }

  // Only the schema form is walked; the booleans `true`/`false` carry no `$ref` and must survive as
  // themselves - `validateSection` reads `false` as "reject an unmatched key".
  const nodeAdditional = node.additionalProperties;
  if (nodeAdditional !== null && typeof nodeAdditional === 'object' && !Array.isArray(nodeAdditional)) {
    out.additionalProperties = resolveRefsDeep(nodeAdditional as JsonSchemaNode, rootSchema, seen);
    changed = changed || out.additionalProperties !== nodeAdditional;
  }

  if (node.items) {
    out.items = resolveRefsDeep(node.items, rootSchema, seen);
    changed = changed || out.items !== node.items;
  }

  if (Array.isArray(node.allOf)) {
    const branches = (node.allOf as JsonSchemaNode[]).map(branch => resolveBranchRefsDeep(branch, rootSchema, seen));
    out.allOf = branches;
    changed = changed || branches.some((branch, index) => branch !== (node.allOf as JsonSchemaNode[])[index]);
  }

  return changed ? out : node;
}

/** An `allOf` branch: `{ if, then }` in this schema, or - same as `validateSection` - a plain schema fragment. */
function resolveBranchRefsDeep(branch: JsonSchemaNode, rootSchema: JsonSchemaNode, seen: Set<string>): JsonSchemaNode {
  if (!branch || typeof branch !== 'object') {
    return branch;
  }
  if (!branch.if && !branch.then) {
    return resolveRefsDeep(branch, rootSchema, seen);
  }
  const out: JsonSchemaNode = { ...branch };
  let changed = false;
  if (branch.if) {
    out.if = resolveRefsDeep(branch.if as JsonSchemaNode, rootSchema, seen);
    changed = changed || out.if !== branch.if;
  }
  if (branch.then) {
    out.then = resolveRefsDeep(branch.then as JsonSchemaNode, rootSchema, seen);
    changed = changed || out.then !== branch.then;
  }
  return changed ? out : branch;
}

function resolvePointerInSchema(root: JsonSchemaNode, ref: string): JsonSchemaNode | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cursor: unknown = root;
  for (const segment of splitPointer(ref.slice(1))) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor as JsonSchemaNode | undefined;
}

function lastSegment(pointer: string): string {
  const segments = splitPointer(pointer);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/** RFC 6901 pointer -> unescaped segments. */
function splitPointer(pointer: string): string[] {
  return pointer
    .split('/')
    .filter(s => s.length > 0)
    .map(unescapeSegment);
}

function escapeSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Words that are acronyms rather than ordinary words, so a derived label reads the way an
 * administrator writes it: "Access Key ID", not "Access Key Id". Kept deliberately short - only
 * words this schema actually uses - because every entry is a word that can no longer be
 * title-cased normally.
 */
const ACRONYMS: Record<string, string> = { api: 'API', id: 'ID', url: 'URL', json: 'JSON', dcr: 'DCR', siem: 'SIEM' };

function humanize(key: string): string {
  return key
    .split('_')
    .filter(word => word.length > 0)
    .map(word => ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The label for a property, derived from its name.
 *
 * A trailing `_env` is dropped. The environment *fallback* is gone - nothing reads `process.env`
 * for a credential and the encrypted store is the only source - so `api_key_env` no longer names
 * an environment variable; it names the credential slot that holds the API key. The row is
 * therefore labelled for what it configures ("API Key"), and the slot name itself is shown by the
 * credential control as secondary text, where it reads as an identifier rather than as an env var.
 *
 * Derived, not a table of six hand-written labels: the suffix is the convention, so every field
 * that follows it - including ones added later - is labelled correctly without another edit here.
 */
/**
 * Exported so a caller that builds its own container around a schema subtree - the tab shell's
 * per-section panel headers (`../controller/ConfigFormTabs`), which have no descriptor of their
 * own to carry a label - can title it the same way every property inside `buildDescriptors`
 * already is, rather than duplicating this rule.
 */
export function labelFor(key: string): string {
  return humanize(key.replace(/_env$/, ''));
}

function deepClone(data: unknown): unknown {
  return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
}

function safeStringify(data: unknown): string {
  return JSON.stringify(data === undefined ? null : data);
}
