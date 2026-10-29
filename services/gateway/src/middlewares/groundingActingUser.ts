/**
 * The acting user of a cockpit Grounding call (spec 2026-10-01 §4.2).
 *
 * The admin service authenticates the cockpit user and then calls the gateway with its platform
 * service key. For that key alone, two headers name the user the call is made for. This middleware
 * turns them into the same owner identity an API key carries (`req.apiKeyInfo.email`), so the
 * existing file and vector-store handlers apply their ownership rules unchanged. Two optional
 * headers name the user's teams and the teams they administer (spec 2026-10-14 §8); an older admin
 * sends neither, which means no teams.
 *
 * It must run after gatewayStandaloneOrServiceKeyAuth. The decision "is this the admin service"
 * is made from the key's e-mail and the registry, not from `req.serviceAuth.permissions`: that is
 * the stored permission list and is empty for the service key.
 */
import { Request, Response, NextFunction } from 'express';
import { findServiceKeyByEmail, SERVICE_KEYS } from '@libs/service-auth';
import { ACTING_EMAIL_PATTERN } from './actingEmailPattern';

export const ACTING_EMAIL_HEADER = 'x-grounding-acting-email';
export const ACTING_ROLE_HEADER = 'x-grounding-acting-role';
export const ACTING_TEAMS_HEADER = 'x-grounding-acting-teams';
export const ACTING_ADMIN_TEAMS_HEADER = 'x-grounding-acting-admin-teams';
export const GROUNDING_USER_PERMISSION = 'grounding:user';

export interface GroundingActor {
  email: string;
  role: 'user' | 'admin';
  /** Every team the acting user belongs to (store visibility); absent from older admins = none. */
  teamIds?: string[];
  /** The teams the acting user administers (who may share with which team). A subset of teamIds. */
  adminTeamIds?: string[];
}

const MAX_EMAIL_LENGTH = 254;
const MAX_TEAMS = 200;
const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The header as one trimmed string. An array means it was sent twice, which is refused. */
function single(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

/** A comma-separated list of team ids, lower-cased and de-duplicated; absent or empty = none; null when malformed. */
function teamList(value: unknown): string[] | null {
  if (value === undefined) return [];
  const raw = single(value);
  if (raw === null) return null;
  if (raw === '') return [];
  const ids = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()))];
  return ids.length <= MAX_TEAMS && ids.every((id) => TEAM_ID_PATTERN.test(id)) ? ids : null;
}

function refuse(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

export function groundingActingUser(req: Request, res: Response, next: NextFunction): void {
  const auth = (req as any).serviceAuth;
  const keyEmail = auth?.serviceKey?.email;
  const isAdminService = auth?.authType === 'service-key'
    && typeof keyEmail === 'string'
    && findServiceKeyByEmail(keyEmail) === 'ADMIN_TO_GATEWAY'
    && (SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS as readonly string[]).includes(GROUNDING_USER_PERMISSION);
  if (!isAdminService) {
    refuse(res, 403, 'grounding_service_key_required', 'These routes accept only the admin service key.');
    return;
  }

  const email = single(req.headers[ACTING_EMAIL_HEADER]);
  if (!email || email.length > MAX_EMAIL_LENGTH || !ACTING_EMAIL_PATTERN.test(email)) {
    refuse(res, 400, 'invalid_acting_user', `${ACTING_EMAIL_HEADER} must carry one e-mail address.`);
    return;
  }

  const role = single(req.headers[ACTING_ROLE_HEADER]);
  if (role !== 'user' && role !== 'admin') {
    refuse(res, 400, 'invalid_acting_role', `${ACTING_ROLE_HEADER} must be "user" or "admin".`);
    return;
  }

  const teamIds = teamList(req.headers[ACTING_TEAMS_HEADER]);
  const adminTeamIds = teamList(req.headers[ACTING_ADMIN_TEAMS_HEADER]);
  if (!teamIds || !adminTeamIds || adminTeamIds.some((id) => !teamIds.includes(id))) {
    refuse(res, 400, 'invalid_acting_teams', `${ACTING_TEAMS_HEADER} and ${ACTING_ADMIN_TEAMS_HEADER} must list team ids; every admin team must be one of the teams.`);
    return;
  }

  const actor: GroundingActor = { email, role, teamIds, adminTeamIds };
  (req as any).groundingActor = actor;
  // What filesController and vectorStoresController read through getOwnerEmail().
  (req as any).apiKeyInfo = { active: true, email, authSource: 'grounding' };
  delete (req as any).apiKey;
  next();
}
