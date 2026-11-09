/**
 * The Connections change marker (spec 2026-10-23 §4.2): after every change to a connection, its
 * models, credential or prices, the admin publishes a version number - nothing else - and the
 * gateway refetches its snapshot through getConnections(). A lost marker costs at most the
 * gateway's 60 s snapshot TTL, so a failed publish is logged by the store and not retried.
 * Env-overridable so an integration test never broadcasts on the production channel.
 */
import { quotaStateStore } from './quotaStateStore';

export const CONNECTIONS_CHANGE_CHANNEL = process.env.CONNECTIONS_CHANGE_CHANNEL || 'sap-llm-gateway:connections-changed';

export async function publishConnectionsChanged(): Promise<boolean> {
  return quotaStateStore.publish(CONNECTIONS_CHANGE_CHANNEL, JSON.stringify({ version: Date.now() }));
}
