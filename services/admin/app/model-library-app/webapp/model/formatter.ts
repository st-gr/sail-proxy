/**
 * View formatters bound from XML views (e.g. capacity-unit display, price rounding,
 * date/version labels). Filled in by Tasks 2-6.
 */
import IconPool from "sap/ui/core/IconPool";
import { providerMark } from "./providerMarks";
import { providerLabel } from "./providerLabel";
import { contextWindow } from "./contextWindow";
import { isDeployed, isDeployment, retires, deploymentOnly, notCallable } from "./deploymentBadge";

/** Card footer chips (A6) and the filter pane's radio/checkbox icons (A8/A9) share this map. */
const CAPABILITY_INPUT_ICONS: Record<string, [string, string]> = {
  "text-generation": ["sap-icon://write-new", "Text Generation"],
  "image-recognition": ["sap-icon://show", "Image Recognition"],
  "image-generation": ["sap-icon://picture", "Image Generation"],
  reasoning: ["sap-icon://org-chart", "Reasoning"],
  embedding: ["sap-icon://overview-chart", "Embedding"],
  "speech-to-text": ["sap-icon://microphone", "Speech To Text"],
  text: ["sap-icon://text", "Text"],
  image: ["sap-icon://image-viewer", "Image"],
  audio: ["sap-icon://sound", "Audio"],
  video: ["sap-icon://video", "Video"]
};

/** LibraryFilterState's capability enum -> the flag name CAPABILITY_INPUT_ICONS keys on. */
const CAPABILITY_ENUM_TO_FLAG: Record<string, string> = {
  text: "text-generation", imageRecognition: "image-recognition", imageGeneration: "image-generation",
  reasoning: "reasoning", embedding: "embedding", speechToText: "speech-to-text"
};

function glyphFor(key: string): string | undefined { return CAPABILITY_INPUT_ICONS[key]?.[0]; }

/**
 * Prefixes a capabilityGroup RadioButton's label with its capability icon (A8). RadioButton has
 * no icon property and RadioButtonGroup's "buttons" aggregation only accepts RadioButton, so an
 * Icon control cannot be nested in there — instead this relies on the browser's per-glyph font
 * fallback: .mlIconRadioGroup in style.css lists "SAP-icons" first for the label, which only
 * defines the icon font's private-use codepoints, so the label text after it renders in the next
 * (regular) font in that list untouched. A plain function, not an object method: UI5 invokes a
 * "formatter": "formatter.xxx" reference detached from the formatter object below, so it must not
 * rely on `this`.
 */
function capabilityRadioLabel(enumKey: string, label: string): string {
  const flag = CAPABILITY_ENUM_TO_FLAG[enumKey];
  const src = flag ? glyphFor(flag) : undefined;
  if (!src) return label;
  const info = IconPool.getIconInfo(src);
  return info ? `${info.content} ${label}` : label;
}

export default {
  // L: the mark and the facet label read the display name, so a literal "unknown" provider shows
  // as "Other"/"OT" rather than "unknown"/"UN". The filter value behind it is untouched.
  providerSrc(provider: string): string | undefined { return providerMark(providerLabel(provider)).src; },
  providerInitials(provider: string): string | undefined { return providerMark(providerLabel(provider)).initials; },
  providerLabel,
  version(v: string | null): string { return v ? `Version: ${v}` : ""; },
  /** Card footer icons: capability glyphs first, then modality glyphs, from the JSON arrays. */
  capabilityIcons(capabilities: string | null, inputTypes: string | null): { icon: string; tooltip: string }[] {
    const caps: string[] = safeArray(capabilities);
    const ins: string[] = safeArray(inputTypes);
    return [...caps, ...ins].filter(k => CAPABILITY_INPUT_ICONS[k])
      .map(k => ({ icon: CAPABILITY_INPUT_ICONS[k][0], tooltip: CAPABILITY_INPUT_ICONS[k][1] }));
  },
  capabilityRadioLabel,
  // One-argument wrappers per capability radio row — the view binds each to its own i18n key via
  // the ordinary single-part "formatter" attribute (the same pattern as version()/yesNo() below),
  // rather than an expression binding, to keep this in line with the rest of the view's bindings.
  capEmbeddingRadioLabel(label: string): string { return capabilityRadioLabel("embedding", label); },
  capImageGenerationRadioLabel(label: string): string { return capabilityRadioLabel("imageGeneration", label); },
  capImageRecognitionRadioLabel(label: string): string { return capabilityRadioLabel("imageRecognition", label); },
  capReasoningRadioLabel(label: string): string { return capabilityRadioLabel("reasoning", label); },
  capSpeechToTextRadioLabel(label: string): string { return capabilityRadioLabel("speechToText", label); },
  capTextRadioLabel(label: string): string { return capabilityRadioLabel("text", label); },
  yesNo(b: boolean): string { return b ? "Yes" : "No"; },
  contextWindow,
  // G: library tile badges — a foundation model with a live deployment sibling, a deployment row,
  // and the retirement date. See deploymentBadge.ts for why they are not written inline here.
  isDeployed,
  isDeployment,
  retires,
  deploymentOnly,
  notCallable
};

function safeArray(json: string | null): string[] {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
