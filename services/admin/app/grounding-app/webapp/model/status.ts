/** Status wording and the availability decision. No UI5 imports: these run under jest. */

export type ValueState = 'Success' | 'Warning' | 'Error' | 'Information' | 'None';

/**
 * Resolves an i18n key with optional {0} arguments — the controller injects the resource bundle;
 * jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;

/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  storeStatus_in_progress: 'In progress', storeStatus_completed: 'Completed', storeStatus_failed: 'Failed',
  storeStatus_cancelled: 'Cancelled', storeStatus_expired: 'Expired'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const STATE: Record<string, ValueState> = {
  in_progress: 'Information', completed: 'Success', failed: 'Error', cancelled: 'Warning', expired: 'Warning'
};

export function statusText(status: string | null | undefined): string;
export function statusText(status: string | null | undefined, t: Translator | undefined): string;
export function statusText(status: string | null | undefined, t: Translator = defaultTranslate): string {
  if (!status) return '';
  const key = `storeStatus_${status}`;
  // A caller may be Array.prototype.map, which passes the index as the second argument.
  const translate = typeof t === 'function' ? t : defaultTranslate;
  const text = translate(key);
  // An unknown status has no key: show the raw status, as before.
  return text === key ? status : text;
}

export function statusState(status: string | null | undefined): ValueState {
  return (status && STATE[status]) || 'None';
}

export function fileErrorText(lastError: { message?: string; [key: string]: unknown } | null | undefined): string {
  return lastError && typeof lastError.message === 'string' ? lastError.message : '';
}

/** The reasons the gateway's /status names (each has an `unavailable_<reason>` text); any other is shown as not_migrated. */
export const UNAVAILABLE_REASONS = [
  'disabled', 'no_database', 'not_migrated', 'embedding_dimensions', 'schema_not_provisioned', 'schema_outdated', 'migration_failed'
];

export interface Availability {
  available: boolean;
  /** '' when available; otherwise one of UNAVAILABLE_REASONS, signed_out, unsupported_identity or unreachable. */
  reason: string;
  maxFileBytes: number;
}

/**
 * What the status call means for the app. Anything but a clear "available" sends the user to the
 * "not configured" page, which names the reason; an unreadable answer is "unreachable", never a
 * blank screen.
 */
export function availabilityOf(result: { ok: boolean; status: number; body: any }): Availability {
  if (result.ok && result.body && result.body.available === true) {
    return { available: true, reason: '', maxFileBytes: Number(result.body.limits?.maxFileBytes) || 0 };
  }
  if (result.ok && result.body && result.body.available === false) {
    const reason = String(result.body.reason || '');
    return { available: false, reason: UNAVAILABLE_REASONS.includes(reason) ? reason : 'not_migrated', maxFileBytes: 0 };
  }
  if (result.status === 400 && result.body && result.body.error === 'unsupported_identity') {
    return { available: false, reason: 'unsupported_identity', maxFileBytes: 0 };
  }
  if (result.status === 401) return { available: false, reason: 'signed_out', maxFileBytes: 0 };
  return { available: false, reason: 'unreachable', maxFileBytes: 0 };
}
