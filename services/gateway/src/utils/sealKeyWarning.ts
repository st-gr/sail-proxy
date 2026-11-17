/**
 * One console warning per process when content is sealed with a weak METADATA_ENCRYPTION_KEY: the
 * light trace's sealed prompt and the raw capture's stages share the key, and the warning.
 */
import { sealKeyStatus } from '@libs/trace-seal';
import { getDefaultLogger } from '@libs/logger';

let reported = false;

/** Says once, before the first seal of the process, that the key is weak. */
export function warnOnceIfSealKeyWeak(env: NodeJS.ProcessEnv): void {
  if (reported) return;
  reported = true;
  const status = sealKeyStatus(env);
  if (status !== 'strong') {
    getDefaultLogger().warn('PayloadCapture',
      `METADATA_ENCRYPTION_KEY is ${status}: payload traces and raw traces are sealed with it, and anyone who knows the value can decrypt them`);
  }
}

/** Tests only: the warning not yet given. */
export function resetSealKeyWarning(): void {
  reported = false;
}
