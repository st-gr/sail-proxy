import type express from 'express';
import { isGatewayServiceCaller } from '../utils/gatewayServiceJwt';
import type { Actor } from '../services/pluginOperations';

/** The signed-in admin, or null after answering 401 or 403. */
export function adminOf(req: express.Request, res: express.Response): Actor | null {
  const user = req.user;
  if (!user || typeof user.id !== 'string' || user.id === '' || user.id === 'anonymous') {
    res.status(401).json({ error: 'authentication_required', message: 'Sign in to use this route.' });
    return null;
  }
  // The gateway's service token is mapped to the admin role by the auth middleware; it is a machine
  // credential for ValidationService only, and must not install code.
  if (isGatewayServiceCaller(req.headers.authorization)) {
    res.status(403).json({ error: 'Forbidden', message: 'A service token cannot use this endpoint.' });
    return null;
  }
  const roles: unknown = user.roles ?? user.scope ?? [];
  const isAdmin = typeof user.is === 'function' ? !!user.is('admin') : Array.isArray(roles) && roles.includes('admin');
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden', message: 'The admin role is required.' });
    return null;
  }
  return { id: user.id, req };
}
