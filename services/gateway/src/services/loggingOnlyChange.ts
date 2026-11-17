/**
 * Whether two configurations differ only in the logging settings.
 *
 * The admin service lays its logging settings (the Logs page's levels and the switch for storing
 * the gateway's log) over the active configuration when it hands it to the gateway, and publishes
 * the WHOLE configuration again when one of them changes or a timed level runs out. The overlay
 * writes exactly four places, creating the objects on the way where they are missing:
 *
 *   api_config.platform.logging.defaultLevel
 *   api_config.platform.logging.components
 *   api_config.observability.gateway_log.enabled
 *   api_config.observability.payload_capture.enabled
 *
 * A gateway that finds nothing else changed takes the levels and reloads nothing. The comparison
 * is of the content, not of the event's type or a checksum: a gateway that missed an activation
 * receives the new configuration with such an event, and must then reload as for any other.
 *
 * Fails safe: anything that is not two plain objects, cannot be copied, or differs anywhere else
 * (also in the order of its keys) gives false, which means the full reload.
 *
 * Pure: no I/O, no config access. configService decides what to do with the answer.
 */

const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isEmpty = (value: unknown): boolean => isObject(value) && Object.keys(value).length === 0;

/** A copy of `config` without the four places, and without an object that is empty on the way to them. */
function withoutLoggingSettings(config: Record<string, any>): Record<string, any> {
  const copy = structuredClone(config);
  const api = copy.api_config;
  if (!isObject(api)) return copy;

  if (isObject(api.platform)) {
    if (isObject(api.platform.logging)) {
      delete api.platform.logging.defaultLevel;
      delete api.platform.logging.components;
      if (isEmpty(api.platform.logging)) delete api.platform.logging;
    }
    if (isEmpty(api.platform)) delete api.platform;
  }

  if (isObject(api.observability)) {
    if (isObject(api.observability.gateway_log)) {
      delete api.observability.gateway_log.enabled;
      if (isEmpty(api.observability.gateway_log)) delete api.observability.gateway_log;
    }
    if (isObject(api.observability.payload_capture)) {
      delete api.observability.payload_capture.enabled;
      if (isEmpty(api.observability.payload_capture)) delete api.observability.payload_capture;
    }
    if (isEmpty(api.observability)) delete api.observability;
  }

  return copy;
}

/**
 * True when `held` and `arrived` are equal apart from the logging settings (two equal
 * configurations included). Never throws and never changes its arguments.
 */
export function differsOnlyInLoggingSettings(held: unknown, arrived: unknown): boolean {
  if (!isObject(held) || !isObject(arrived)) return false;
  try {
    return JSON.stringify(withoutLoggingSettings(held)) === JSON.stringify(withoutLoggingSettings(arrived));
  } catch {
    return false;
  }
}
