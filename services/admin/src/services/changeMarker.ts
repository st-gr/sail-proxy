import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/**
 * Send a change marker once after the admin is up, so gateways that booted without it converge.
 * Valkey may still be connecting at boot, so an unsent marker is retried once. A boot hook never
 * throws: a failure is logged and not retried (only an unsent marker is).
 * Shared by the Connections and Plugins markers.
 */
export function announceAtBoot(label: string, publish: () => Promise<boolean>, retryMs = 5000): void {
  const send = async (): Promise<boolean> => {
    try { return await publish(); } catch (error) {
      logger.warn(label, `The boot change marker was not sent: ${(error as Error)?.message ?? error}`);
      return true;
    }
  };
  void send().then((sent) => {
    if (!sent) setTimeout(() => { void send(); }, retryMs).unref?.();
  });
}
