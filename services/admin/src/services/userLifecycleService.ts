/**
 * Account status (spec §3): deactivation locks every active credential of the e-mail (flagging the
 * rows it touched), reactivation restores exactly those. Both invalidate the gateway's cached
 * validations, rewrite the quota document, record an AuditEvents row and a Security Notifications
 * envelope with the administrator's client IP (ruling 8 of the plan). Deactivation is enforced by
 * credential inactivity, so it never fails open.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
import { getUser, touch, USERS, DbLike } from './usersService';
import { invalidateForEmails } from './credentialInvalidation';
import { publish } from './userQuotaService';
import { recordAuditEvent } from './auditEventService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const NOTES = 'sap.llm.gateway.admin.SecurityNotifications';

export interface LifecycleContext { actor: string; reason?: string; clientIP?: string; userAgent?: string; }

export class UserDeactivatedError extends Error {
  status = 403; code = 'user_deactivated';
  constructor(email: string) { super(`User ${email} is deactivated`); }
}

export async function isDeactivated(db: DbLike, email: string): Promise<boolean> {
  if (!email) return false;
  const user = await getUser(db, email);
  return user?.status === 'deactivated';
}
export async function assertNotDeactivated(db: DbLike, email: string): Promise<void> {
  if (await isDeactivated(db, email)) throw new UserDeactivatedError(email);
}

async function notify(db: DbLike, email: string, eventType: 'user_deactivated' | 'user_reactivated', auditId: string | null, title: string, message: string, severity: 'high' | 'medium', ctx: LifecycleContext): Promise<void> {
  const { INSERT } = cds.ql;
  try {
    await db.run(INSERT.into(NOTES).entries({
      ID: uuidv4(), type: 'security_event', sourceEntity: 'AuditEvents', sourceID: auditId, ownerEmail: email,
      title, message, severity, eventType, eventDate: new Date(),
      icon: eventType === 'user_deactivated' ? 'sap-icon://locked' : 'sap-icon://unlocked', actionable: false,
      clientIP: ctx.clientIP ?? null, userAgent: ctx.userAgent ?? null, endpoint: null, requestId: null,
      createdAt: new Date(), createdBy: ctx.actor
    }));
  } catch (e) {
    // A notification is a courtesy, not the outcome: never undo an already-completed
    // deactivation/reactivation because the SecurityNotifications insert failed.
    logger.warn('UserLifecycle', `notification insert failed for ${email}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const CACHE_INVALIDATION_FAILED_NOTE = '; cache invalidation FAILED — cached validations may stay valid up to 1 h';

export async function deactivate(db: DbLike, email: string, ctx: LifecycleContext): Promise<{ email: string; status: 'deactivated'; lockedApiKeys: number; lockedAwsCredentials: number; cacheInvalidated: boolean }> {
  const { UPDATE } = cds.ql;
  const user = await touch(db, email);
  if (!user) throw new Error(`${email} is not a user`);
  if (user.status === 'deactivated') return { email, status: 'deactivated', lockedApiKeys: 0, lockedAwsCredentials: 0, cacheInvalidated: true };
  const now = new Date();
  await db.run(UPDATE(USERS).set({ status: 'deactivated', statusChangedAt: now, statusChangedBy: ctx.actor, statusReason: ctx.reason ?? null }).where({ email }));
  const lockedApiKeys = Number(await db.run(UPDATE(KEYS).set({ isActive: false, lockedByUserDeactivation: true }).where({ email, isActive: true }))) || 0;
  const lockedAwsCredentials = Number(await db.run(UPDATE(AWS).set({ isActive: false, lockedByUserDeactivation: true }).where({ email, isActive: true }))) || 0;
  const cacheInvalidated = await invalidateForEmails(db, [email], 'user_deactivated', { includeInactive: true });
  await publish(db, email);
  const failureNote = cacheInvalidated ? '' : CACHE_INVALIDATION_FAILED_NOTE;
  const auditId = await recordAuditEvent({ actorId: ctx.actor, actorType: 'admin_user', action: 'user.deactivate', resourceType: 'User', resourceId: email,
    outcome: 'success', severity: 'high', clientIP: ctx.clientIP, userAgent: ctx.userAgent, details: `${ctx.reason ?? 'no reason given'}; locked ${lockedApiKeys} API key(s), ${lockedAwsCredentials} AWS credential(s)${failureNote}` });
  await notify(db, email, 'user_deactivated', auditId, `User ${email} deactivated`,
    `Deactivated by ${ctx.actor}: ${ctx.reason ?? 'no reason given'}. ${lockedApiKeys} API key(s) and ${lockedAwsCredentials} AWS credential(s) locked.${failureNote}`, 'high', ctx);
  logger.warn('UserLifecycle', `Deactivated ${email} (${lockedApiKeys} keys, ${lockedAwsCredentials} credentials) by ${ctx.actor}`);
  return { email, status: 'deactivated', lockedApiKeys, lockedAwsCredentials, cacheInvalidated };
}

export async function reactivate(db: DbLike, email: string, ctx: LifecycleContext): Promise<{ email: string; status: 'active'; restoredApiKeys: number; restoredAwsCredentials: number; cacheInvalidated: boolean }> {
  const { UPDATE } = cds.ql;
  const user = await getUser(db, email);
  if (!user) throw new Error(`${email} is not a user`);
  if (user.status !== 'deactivated') return { email, status: 'active', restoredApiKeys: 0, restoredAwsCredentials: 0, cacheInvalidated: true };
  const now = new Date();
  await db.run(UPDATE(USERS).set({ status: 'active', statusChangedAt: now, statusChangedBy: ctx.actor, statusReason: ctx.reason ?? null }).where({ email }));
  const restoredApiKeys = Number(await db.run(UPDATE(KEYS).set({ isActive: true, lockedByUserDeactivation: false }).where({ email, lockedByUserDeactivation: true }))) || 0;
  const restoredAwsCredentials = Number(await db.run(UPDATE(AWS).set({ isActive: true, lockedByUserDeactivation: false }).where({ email, lockedByUserDeactivation: true }))) || 0;
  const cacheInvalidated = await invalidateForEmails(db, [email], 'user_reactivated');
  await publish(db, email);
  const failureNote = cacheInvalidated ? '' : CACHE_INVALIDATION_FAILED_NOTE;
  const auditId = await recordAuditEvent({ actorId: ctx.actor, actorType: 'admin_user', action: 'user.reactivate', resourceType: 'User', resourceId: email,
    outcome: 'success', severity: 'medium', clientIP: ctx.clientIP, userAgent: ctx.userAgent, details: `restored ${restoredApiKeys} API key(s), ${restoredAwsCredentials} AWS credential(s)${failureNote}` });
  await notify(db, email, 'user_reactivated', auditId, `User ${email} reactivated`,
    `Reactivated by ${ctx.actor}. ${restoredApiKeys} API key(s) and ${restoredAwsCredentials} AWS credential(s) restored.${failureNote}`, 'medium', ctx);
  return { email, status: 'active', restoredApiKeys, restoredAwsCredentials, cacheInvalidated };
}
