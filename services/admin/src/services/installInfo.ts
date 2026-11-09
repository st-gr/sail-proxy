export type InstallType = 'kyma' | 'docker' | 'local';

/** Kubernetes sets KUBERNETES_SERVICE_HOST; Kyma and Docker both set DEPLOY_TARGET=docker, so Kubernetes is checked first. */
export function installType(env: NodeJS.ProcessEnv = process.env): InstallType {
  if (env.KUBERNETES_SERVICE_HOST) return 'kyma';
  if (env.DEPLOY_TARGET === 'docker') return 'docker';
  return 'local';
}

/** UPDATE_CHECK_ENABLED: anything but false, 0, no or off (any case) means on. */
export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['false', '0', 'no', 'off'].includes((env.UPDATE_CHECK_ENABLED ?? '').trim().toLowerCase());
}
