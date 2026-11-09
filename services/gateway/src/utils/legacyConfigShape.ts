/**
 * Diagnostic for api_config written against the pre-restructure shape, on both
 * the routes that accept one and the file the gateway loads at startup.
 *
 * api_config used to carry twenty flat sections at its top level; they now live
 * under six groups. PUT /config and PATCH /config only ever checked that
 * `api_config` was present, so an old-shape body deep-merged into the current
 * config as a set of unread top-level keys: the request answered 200, the
 * config file grew sections nothing reads, and the settings the caller meant to
 * change never took effect. The load path was quieter still - it read, parsed,
 * cached and announced an old-shape file with a plain `logger.info`. Both
 * surfaces are reachable by every npm-dist standalone user, who has no admin UI
 * to notice through.
 *
 * This is a name check, not a validator. It looks only at the twenty known old
 * section names and reports where each one moved; it does not judge anything
 * else, which stays the schema's job on the admin side.
 */
import * as fs from 'fs';

/** Old top-level section name -> its path in the restructured api_config. */
export const LEGACY_SECTION_MOVES: Readonly<Record<string, string>> = Object.freeze({
  // providers
  'anthropic': 'providers.anthropic',
  'aws-bedrock': 'providers.aws-bedrock',
  'openai': 'providers.openai',
  'openrouter': 'providers.openrouter',
  'perplexity': 'providers.perplexity',
  // models
  'model_list_changes': 'models.overrides',
  // capabilities
  'web_search': 'capabilities.web_search',
  'file_search': 'capabilities.file_search',
  'hosted_tools': 'capabilities.hosted_tools',
  'namespace_tools': 'capabilities.namespace_tools',
  'custom_tools': 'capabilities.custom_tools',
  'tool_search': 'capabilities.tool_search',
  // hooks
  'hookDefinitions': 'hooks.definitions',
  'defaultHooks': 'hooks.defaults',
  // platform
  'timeouts': 'platform.timeouts',
  'logging': 'platform.logging',
  'rate_limit_handling': 'platform.rate_limit_handling',
  'security': 'platform.security',
  // observability
  'pseudonymization': 'observability.pseudonymization',
  'siem': 'observability.siem',
});

/**
 * The old section names present at the top level of `apiConfig`, in the order
 * they were declared in the request body.
 */
export function findLegacySections(apiConfig: unknown): string[] {
  if (!apiConfig || typeof apiConfig !== 'object' || Array.isArray(apiConfig)) {
    return [];
  }
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so a body with a
  // top-level `toString` or `constructor` would be reported as an old section
  // and answered 400 with a nonsense move ("constructor -> function Object()").
  return Object.keys(apiConfig as Record<string, unknown>).filter((key) =>
    Object.prototype.hasOwnProperty.call(LEGACY_SECTION_MOVES, key)
  );
}

/** `old -> new.home` for each section, in declaration order. */
function describeMoves(sections: string[]): string {
  return sections.map((section) => `${section} -> ${LEGACY_SECTION_MOVES[section]}`).join(', ');
}

/** `{ old: 'new.home' }` for each section, for programmatic callers. */
function movedSections(sections: string[]): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const section of sections) {
    moved[section] = LEGACY_SECTION_MOVES[section];
  }
  return moved;
}

/**
 * A 400 body naming each offending section and its new home, or null when the
 * request carries none of them.
 */
export function legacyShapeError(
  apiConfig: unknown
): { error: string; moved_sections: Record<string, string> } | null {
  const sections = findLegacySections(apiConfig);
  if (sections.length === 0) {
    return null;
  }

  return {
    error:
      'Invalid configuration format: api_config uses the old flat section layout. ' +
      `These sections moved under the six api_config groups: ${describeMoves(sections)}. ` +
      'Nest them under their new group and resend.',
    moved_sections: movedSections(sections),
  };
}

/**
 * The same verdict for a config FILE rather than a request body.
 *
 * An old-shape file on disk is the quieter and more dangerous half of this
 * problem: it parses, it caches, and every reader of a moved section finds
 * nothing — so `observability.siem`, `observability.pseudonymization` and
 * `platform.security` all disengage while the operator believes they are on.
 * Nothing in the load path noticed. This is what the callers report on.
 *
 * Returns null when the file is absent, unreadable or not JSON: none of that is
 * this check's business, and the load path already has its own handling for it.
 */
export function legacyShapeErrorForFile(
  configFilePath: string
): { message: string; sections: string[]; moved_sections: Record<string, string> } | null {
  let parsed: any;
  try {
    if (!fs.existsSync(configFilePath)) {
      return null;
    }
    parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  } catch {
    return null;
  }

  const sections = findLegacySections(parsed?.api_config);
  if (sections.length === 0) {
    return null;
  }

  return {
    message:
      `The configuration file at ${configFilePath} uses the old flat api_config layout. ` +
      'Its sections are no longer read, so any settings they carry are NOT in effect - ' +
      'including the security-relevant ones. ' +
      `These sections moved under the six api_config groups: ${describeMoves(sections)}. ` +
      'Nest them under their new group to restore them.',
    sections,
    moved_sections: movedSections(sections),
  };
}
