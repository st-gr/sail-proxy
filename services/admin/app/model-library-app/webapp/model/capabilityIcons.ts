/**
 * The capability and modality glyphs with their names: the library card footer chips (A6), the
 * filter pane's capability radio icons (A8) and the Detail page's capability/input chips. No UI5
 * imports: these run under jest (formatter.ts itself pulls in sap/ui/core/IconPool).
 */

/**
 * Resolves an i18n key — the caller injects the resource bundle; jest passes none and gets the
 * English defaults below. The keys are the filter pane's own (libraryFilters.ts), so a capability
 * reads the same on a card, in the filter pane and on the Detail page.
 */
export type Translator = (key: string) => string;
/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  capText: 'Text Generation', capImageRecognition: 'Image Recognition', capImageGeneration: 'Image Generation',
  capReasoning: 'Reasoning', capEmbedding: 'Embedding', capSpeechToText: 'Speech To Text',
  inText: 'Text', inImage: 'Image', inAudio: 'Audio', inVideo: 'Video'
};
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

/** Capability/modality flag (as the gateway publishes it) -> [glyph, i18n key of its name]. */
export const CAPABILITY_INPUT_ICONS: Record<string, [string, string]> = {
  "text-generation": ["sap-icon://write-new", "capText"],
  "image-recognition": ["sap-icon://show", "capImageRecognition"],
  "image-generation": ["sap-icon://picture", "capImageGeneration"],
  reasoning: ["sap-icon://org-chart", "capReasoning"],
  embedding: ["sap-icon://overview-chart", "capEmbedding"],
  "speech-to-text": ["sap-icon://microphone", "capSpeechToText"],
  text: ["sap-icon://text", "inText"],
  image: ["sap-icon://image-viewer", "inImage"],
  audio: ["sap-icon://sound", "inAudio"],
  video: ["sap-icon://video", "inVideo"]
};

/** A translator that has no text for a key (the bundle not loaded yet) falls back to English. */
function textOf(key: string, t: Translator): string {
  const text = typeof t === 'function' ? t(key) : undefined;
  return text && text !== key ? text : defaultTranslate(key);
}

export function glyphFor(flag: string): string | undefined { return CAPABILITY_INPUT_ICONS[flag]?.[0]; }

/**
 * The display name of a capability or modality flag. A flag this map does not know is title-cased
 * from its words ("speech-to-text" -> "Speech To Text"), as the Detail page always showed it.
 */
export function capabilityName(flag: string, t: Translator = defaultTranslate): string {
  const entry = CAPABILITY_INPUT_ICONS[flag];
  if (entry) return textOf(entry[1], t);
  return String(flag).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Card footer icons: capability glyphs first, then modality glyphs, from the JSON arrays. */
export function capabilityIcons(capabilities: string | null, inputTypes: string | null, t: Translator = defaultTranslate): { icon: string; tooltip: string }[] {
  const caps: string[] = safeArray(capabilities);
  const ins: string[] = safeArray(inputTypes);
  return [...caps, ...ins].filter(k => CAPABILITY_INPUT_ICONS[k])
    .map(k => ({ icon: CAPABILITY_INPUT_ICONS[k][0], tooltip: textOf(CAPABILITY_INPUT_ICONS[k][1], t) }));
}

function safeArray(json: string | null): string[] {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
