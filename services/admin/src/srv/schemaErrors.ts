/**
 * One Ajv error as the message the API returns, or null for an error that adds
 * nothing to one already reported.
 *
 * Exists for `propertyNames`, which is how `providers.<provider>` is closed to
 * the settings that provider's code actually reads: draft-07 scopes
 * `additionalProperties` to the schema object declaring it, so it cannot see
 * the fields the `$defs/providerCommon` branch contributes and would reject
 * them. Ajv reports such a failure as TWO errors, both against the OBJECT:
 * an inner `enum` carrying the offending key in `propertyName` and the whole
 * allowed set in `params.allowedValues`, and an outer `propertyNames` umbrella
 * carrying only the key. Formatted the generic way, the pair read as
 * "must be equal to one of the allowed values" and "property name must be
 * valid" against `/api_config/providers/openai` - naming neither the key nor
 * the allowed set, and reading like a complaint about a VALUE.
 *
 * So the inner error is rewritten to name the key and the allowed set, and
 * pointed one segment deeper, at the key itself: that is the pointer the form
 * renders a control at for an undeclared key (a `raw` one), so the message
 * lands on the control that shows the offending setting instead of on the
 * provider panel. The umbrella is dropped as a duplicate.
 *
 * `webapp/model/validateSection.ts` builds the identical string for the same
 * document - written out there rather than imported, exactly as
 * `findDuplicateSinkNames` above is, because that module belongs to the
 * config-app's own package and the server must not depend on the frontend.
 * The two are held together by `app/config-app/test/documentGate.test.ts`,
 * which compares this function's output with that module's message for message.
 */
export function formatSchemaError(error: any): string | null {
  if (error?.keyword === 'propertyNames') {
    return null;
  }

  const propertyName = error?.propertyName;
  if (typeof propertyName === 'string') {
    const allowed = error?.params?.allowedValues;
    const allowedSuffix = Array.isArray(allowed) ? ` (allowed: ${allowed.join(', ')})` : '';
    const pointer = `${error.instancePath || ''}/${propertyName.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    return `Schema validation error at '${pointer}': property "${propertyName}" ` +
      `is not one of the settings this provider reads${allowedSuffix}`;
  }

  const path = error?.instancePath || error?.schemaPath || 'root';
  return `Schema validation error at '${path}': ${error?.message || 'Unknown validation error'}`;
}
