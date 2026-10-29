/**
 * SAP returns an absolute deploymentUrl per deployment. When SAP_DEPLOYMENT_URL_BASE is set (CI routes SAP traffic
 * through a relay), the URL is moved under that base: same /v2/... path and query, the base's host and path prefix,
 * and the original scheme family (wss stays wss for realtime). Unset, nothing changes.
 */
export function rebaseDeploymentUrl(deploymentUrl: string | undefined, base: string | undefined): string | undefined {
  if (!deploymentUrl || !base) return deploymentUrl;
  let original: URL; let target: URL;
  try { original = new URL(deploymentUrl); target = new URL(base); } catch { return deploymentUrl; }
  if (!original.pathname.startsWith('/v2/')) return deploymentUrl;
  const scheme = original.protocol === 'wss:' || original.protocol === 'ws:'
    ? (target.protocol === 'http:' ? 'ws:' : 'wss:')
    : target.protocol;
  const prefix = target.pathname.replace(/\/+$/, '');
  return `${scheme}//${target.host}${prefix}${original.pathname}${original.search}`;
}
