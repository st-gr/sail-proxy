import { adminServiceClient } from '../clients/adminServiceClient';
import type { AdminServiceClient } from '../clients/adminServiceClient';
import type { PackageSource } from './sync';

/** The client is null in standalone mode, where this source is never selected; never read that as an empty list. */
function client(): AdminServiceClient {
  if (!adminServiceClient) throw new Error('no admin service client in standalone mode');
  return adminServiceClient;
}

/**
 * Packages from the admin service, the store of record on Docker and Kyma. Every
 * failed answer rejects, so that the sync keeps what is installed; only a
 * successful answer can remove anything. `enabled: false` is such an answer:
 * INSTALLED_PLUGINS_ENABLED is off, so installed plugins go.
 */
export const adminPackageSource: PackageSource = {
  async list() {
    const answer = await client().getPlugins();
    return answer.enabled ? answer.plugins : [];
  },

  async fetch(wanted) {
    const answer = await client().getPluginPackage(wanted.id, wanted.version);
    if (answer.sha256 !== wanted.sha256) {
      throw new Error(`admin answered sha256 ${answer.sha256} for ${wanted.id} ${wanted.version}, wanted ${wanted.sha256}`);
    }
    return Buffer.from(answer.contentBase64, 'base64');
  },
};
