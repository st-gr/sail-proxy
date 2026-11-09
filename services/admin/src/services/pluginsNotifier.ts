/**
 * The plugins change marker (spec 2026-11-04 §5): after every enable and disable (an upload or a
 * removal changes nothing the gateway is told, so it publishes nothing) the admin publishes a version number - nothing else - and the gateway fetches the wanted list
 * again through getPlugins(). A lost marker costs at most the gateway's 60 s re-check, so a failed
 * publish is logged by the store and not retried. Env-overridable (the gateway reads the same
 * variable) so an integration test never broadcasts on the production channel.
 */
import { announceAtBoot } from './changeMarker';
import { quotaStateStore } from './quotaStateStore';

export const PLUGINS_CHANGE_CHANNEL = process.env.PLUGINS_CHANGE_CHANNEL || 'sap-llm-gateway:plugins-changed';

export async function publishPluginsChanged(): Promise<boolean> {
  return quotaStateStore.publish(PLUGINS_CHANGE_CHANNEL, JSON.stringify({ version: Date.now() }));
}

/** Once after the admin is up: gateways that booted without admin, or while the setting was different, converge. */
export function announcePluginsAtBoot(retryMs = 5000): void {
  announceAtBoot('Plugins', publishPluginsChanged, retryMs);
}
