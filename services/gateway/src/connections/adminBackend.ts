/** The Connections snapshot from the admin's ValidationService.getConnections(), over the gateway service JWT. */
import { adminServiceClient } from '../clients/adminServiceClient';
import type { ConnectionBackend } from './types';

export const adminConnectionBackend: ConnectionBackend = {
  fetch: async () => {
    if (!adminServiceClient) throw new Error('no admin service client');
    return adminServiceClient.getConnections();
  },
};
