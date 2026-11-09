import apiConfigSchema from '../../webapp/model/apiConfigSchema';
import { API_CONFIG_GROUPS, groupSections, resolveGroupSchema } from '../../webapp/model/apiConfigGroups';
import { mapEntryDescriptor, mapSectionEntries, mapSpecOf } from '../../webapp/model/formContainers';
import { pluginFor } from '../../webapp/model/formPlugins';
import {
  ArrayItems,
  Descriptor,
  JsonSchemaNode,
  MapEntries,
  buildDescriptors,
  mapEntriesOf,
  resolveRefsDeep
} from '../../webapp/model/schemaForm';

/**
 * Every container the form renders for one document, found the way the form finds them.
 *
 * `ConfigFormTabs.buildTab` cannot be imported by this suite - it pulls in `sap/m/IconTabBar` and
 * nothing here bootstraps the UI5 runtime jest would need for that - so its TRAVERSAL is mirrored
 * here: group by group, section by section, taking the map route where `mapEntriesOf` says a node is
 * a map and the descriptor route otherwise. Everything it decides on the way comes from the same
 * exported functions the controller calls (`resolveGroupSchema`, `groupSections`, `mapEntriesOf`,
 * `mapSectionEntries`, `buildDescriptors`), never re-derived here: the mirror is the loop, not the
 * rules. `configFormTabs.test.ts`'s own header explains why this suite is written this way.
 */
export interface FormContainer {
  /** JSON pointer of the container itself. */
  pointer: string;
  /** Which affordance set it takes: entries with keys, elements with indices, or neither. */
  kind: 'map' | 'array' | 'section';
  mapEntries?: MapEntries;
  arrayItems?: ArrayItems;
  /** The document does not carry this container - it renders as a notice plus **Add section**. */
  absent?: boolean;
}

export function containersOf(document: Record<string, unknown>): FormContainer[] {
  const root = apiConfigSchema as unknown as JsonSchemaNode;
  const groups = (document.api_config as Record<string, unknown>) ?? {};
  const found: FormContainer[] = [];

  /**
   * One container's content, the way `ConfigFormTabs.buildSectionContent` builds it: a map renders as
   * the descriptors of its entries, anything else as its own descriptors. Both branches end in the
   * same `walk` over descriptors, because that is what the controller ends in too - one entry
   * descriptor per key, from `mapEntryDescriptor`, which is the very function the controller calls.
   */
  const collect = (
    schema: JsonSchemaNode,
    data: unknown,
    pointer: string,
    declared?: Array<{ key: string; pointer: string; schema: JsonSchemaNode }>
  ): void => {
    const marker = mapEntriesOf(schema, root);
    if (!marker) {
      walk(buildDescriptors(schema as object, data, pointer, pluginFor), found);
      return;
    }
    found.push({ pointer, kind: 'map', mapEntries: marker, absent: !isObject(data) });
    if (!isObject(data)) {
      // The controller draws the notice and Add section here and builds no entries at all.
      return;
    }
    const entries = mapSectionEntries({
      spec: mapSpecOf(pointer, marker),
      containerSchema: schema,
      containerData: data,
      declared
    });
    walk(entries.map(entry => mapEntryDescriptor(entry, root, pluginFor)), found);
  };

  for (const group of API_CONFIG_GROUPS) {
    const groupSchema = resolveRefsDeep(resolveGroupSchema(apiConfigSchema, group), root);
    const groupData = isObject(groups[group]) ? (groups[group] as Record<string, unknown>) : undefined;
    // The document, as `buildTab` hands it in: it decides the section ORDER (`groupSectionKeys`).
    const sections = groupSections(apiConfigSchema, group, groupData);

    if (mapEntriesOf(groupSchema, root)) {
      collect(groupSchema, groupData, `/api_config/${group}`, sections);
      continue;
    }
    for (const section of sections) {
      collect(section.schema, groupData ? groupData[section.key] : undefined, section.pointer);
    }
  }

  return found;
}

/** The container at `pointer`, or undefined - what the affordance for it would be built from. */
export function containerAt(document: Record<string, unknown>, pointer: string): FormContainer | undefined {
  return containersOf(document).filter(container => container.pointer === pointer)[0];
}

function walk(descriptors: Descriptor[], found: FormContainer[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'section') {
      continue;
    }
    if (descriptor.mapEntries) {
      found.push({
        pointer: descriptor.pointer,
        kind: 'map',
        mapEntries: descriptor.mapEntries,
        absent: descriptor.absent === true
      });
    } else if (descriptor.arrayItems) {
      found.push({ pointer: descriptor.pointer, kind: 'array', arrayItems: descriptor.arrayItems });
    } else if (descriptor.absent === true) {
      found.push({ pointer: descriptor.pointer, kind: 'section', absent: true });
    }
    walk(descriptor.children, found);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
