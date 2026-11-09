import type { PluginHelp, PluginManifest } from './manifest';

type SchemaNode = Record<string, any>;

const normalise = (lang: string): string => lang.trim().replace(/_/g, '-').toLowerCase();

// Exact match on the UI language, then its base language, then the first language listed.
export const resolveHelp = (
  manifest: Pick<PluginManifest, 'help'>,
  lang: string,
): { lang: string; fallback: boolean; help: PluginHelp } => {
  const keys = Object.keys(manifest.help);
  const find = (wanted: string): string | undefined => keys.find(key => normalise(key) === wanted);
  const wanted = normalise(lang);
  const match = find(wanted) ?? find(wanted.split('-')[0]);
  if (match !== undefined) return { lang: match, fallback: false, help: manifest.help[match] };
  return { lang: keys[0], fallback: true, help: manifest.help[keys[0]] };
};

// Returns a copy; a dotted key addresses a nested property. Unknown keys are ignored.
export const applyHelpToSchema = (schema: object, settingsHelp: Record<string, string> | undefined): object => {
  const copy: SchemaNode = JSON.parse(JSON.stringify(schema));
  for (const [key, text] of Object.entries(settingsHelp ?? {})) {
    const segments = key.split('.');
    let node: SchemaNode | undefined = copy;
    for (const segment of segments) {
      const properties: SchemaNode | undefined = node?.properties;
      node = properties && Object.prototype.hasOwnProperty.call(properties, segment) ? properties[segment] : undefined;
      if (node === undefined || typeof node !== 'object' || node === null) break;
    }
    if (node === undefined || typeof node !== 'object' || node === null) continue;
    if (node.title === undefined) node.title = segments[segments.length - 1];
    node.description = text;
  }
  return copy;
};
