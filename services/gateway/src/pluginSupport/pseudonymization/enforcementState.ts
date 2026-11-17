export interface EnforcementState {
  globalOn: boolean;
  endpoints: string[];
  models: string[];
}

type Dict = Record<string, any>;

function isObject(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null;
}

function flaggedKeys(group: unknown): string[] {
  if (!isObject(group)) return [];
  return Object.keys(group).filter((key) => {
    const entry = group[key];
    return isObject(entry) && isObject(entry.pseudonymization) && !!entry.pseudonymization.enabled;
  });
}

export function isGlobalSwitchOn(apiConfig: unknown): boolean {
  const cfg = apiConfig as Dict | null | undefined;
  return cfg?.observability?.pseudonymization?.enabled === true;
}

export function enforcementState(apiConfig: unknown): EnforcementState {
  const cfg = isObject(apiConfig) ? apiConfig : {};
  return {
    globalOn: isGlobalSwitchOn(apiConfig),
    endpoints: flaggedKeys(cfg.hooks?.defaults),
    models: flaggedKeys(cfg.models?.overrides),
  };
}

export function enforcementLine(state: EnforcementState): string {
  const parts: string[] = [];
  if (state.endpoints.length > 0) parts.push(`endpoints ${state.endpoints.join(', ')}`);
  if (state.models.length > 0) parts.push(`models ${state.models.join(', ')}`);
  const list = parts.join('; ');
  if (state.globalOn) {
    return list
      ? `Pseudonymization is enforced for ${list}.`
      : 'Pseudonymization is switched on, but no endpoint or model enforces it.';
  }
  return list
    ? `Pseudonymization is switched off (observability.pseudonymization.enabled is not true). Overruled: ${list}.`
    : 'Pseudonymization is switched off.';
}
