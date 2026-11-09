/**
 * View formatters bound from XML views (e.g. capacity-unit display, price rounding,
 * date/version labels). Filled in by Tasks 2-6.
 */
import IconPool from "sap/ui/core/IconPool";
import type { IconInfo } from "sap/ui/core/IconPool";
import { providerMark } from "./providerMarks";
import { providerLabel, providerMarkName } from "./providerLabel";
import { contextWindow } from "./contextWindow";
import { isDeployed, isDeployment, retires, deploymentOnly, notCallable } from "./deploymentBadge";
import { capabilityIcons, glyphFor } from "./capabilityIcons";
import { exclusionReason } from "./catalogPending";
import { originLabel } from "./origin";

/**
 * Resolves an i18n key — the view binds the bundle pattern as the formatter's second part; the
 * English default below is the fallback before the bundle has loaded.
 */
type Translator = (key: string) => string;
/** English defaults: each value is byte-identical to the literal it replaced. */
const EN_TEXTS: Record<string, string> = { versionValue: 'Version: {0}', yes: 'Yes', no: 'No' };
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

/** LibraryFilterState's capability enum -> the flag name CAPABILITY_INPUT_ICONS (capabilityIcons.ts) keys on. */
const CAPABILITY_ENUM_TO_FLAG: Record<string, string> = {
  text: "text-generation", imageRecognition: "image-recognition", imageGeneration: "image-generation",
  reasoning: "reasoning", embedding: "embedding", speechToText: "speech-to-text"
};

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
  // No loadingMode is "sync": the info (or undefined), never a Promise.
  const info = IconPool.getIconInfo(src) as IconInfo | undefined;
  return info ? `${info.content} ${label}` : label;
}

export default {
  // L: the mark and the facet label read the display name, so a literal "unknown" provider shows
  // as "Other"/"OT" rather than "unknown"/"UN". The filter value behind it is untouched. The mark
  // keeps the English "Other" (initials "OT") in every language; the label follows the bundle.
  providerSrc(provider: string): string | undefined { return providerMark(providerMarkName(provider)).src; },
  providerInitials(provider: string): string | undefined { return providerMark(providerMarkName(provider)).initials; },
  /** The facet label: the view binds the bundle's "Other" text as the second part (the bundle is async). */
  providerLabel(provider: string, otherText?: string | null): string {
    return providerLabel(provider, otherText ? () => otherText : undefined);
  },
  version(v: string | null, pattern?: string | null): string { return v ? (pattern || defaultTranslate("versionValue")).replace("{0}", v) : ""; },
  /** Card footer icons: capability glyphs first, then modality glyphs, from the JSON arrays (see capabilityIcons.ts). */
  capabilityIcons,
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
  /** The view binds the bundle's yes/no texts as the second and third parts (the bundle is async). */
  yesNo(b: boolean, yesText?: string | null, noText?: string | null): string {
    return b ? (yesText || defaultTranslate("yes")) : (noText || defaultTranslate("no"));
  },
  contextWindow,
  // G: library tile badges — a foundation model with a live deployment sibling, a deployment row,
  // and the retirement date. See deploymentBadge.ts for why they are not written inline here.
  isDeployed,
  isDeployment,
  retires,
  deploymentOnly,
  notCallable,
  /** Origin label: the view binds origin, connection and the three bundle texts (SAP, named Connection, unnamed Connection). */
  origin(origin: string | null, connection: string | null, sapText: string, connectionText: string, unnamedText: string): string {
    return originLabel(origin, connection, sapText, connectionText, unnamedText);
  },
  /** True for a Connection model, whose price lives in Connections. */
  isExternal(origin: string | null): boolean { return origin === "external"; },
  /** Catalogs exclusions table: the view binds the bundle text for the stored sentinel as the second part. */
  exclusionReason
};

