import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export interface AuditEventInput {
  actorId: string;
  actorType: 'admin_user' | 'system' | 'api_key';
  action: string;          // dotted verb, e.g. 'api_key.rotate', 'config.update'
  resourceType: string;    // 'ApiKey' | 'AwsCredential' | 'ApiConfiguration'
  resourceId: string;
  outcome: 'success' | 'failure';
  severity: 'low' | 'medium' | 'high' | 'critical';
  clientIP?: string;
  userAgent?: string;
  details?: string;
}

/**
 * Record an operator/system audit event: what an operator did, to what, and with what outcome.
 * Distinct from SecurityEventService, which records what happened to a caller.
 *
 * An audit-write failure must never break the operation being audited, so failures here are
 * logged and swallowed rather than thrown.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    const auditEvent = {
      ID: uuidv4(),
      actorId: event.actorId,
      actorType: event.actorType,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      severity: event.severity,
      clientIP: event.clientIP || null,
      userAgent: event.userAgent || null,
      details: event.details || null,
      createdAt: new Date(),
      createdBy: event.actorId || 'system'
    };

    const db = await cds.connect.to('db');
    await db.run(
      cds.ql.INSERT.into('sap.llm.gateway.admin.AuditEvents').entries(auditEvent)
    );

    logger.info('AuditEventService', `Audit Event Recorded: ${event.action}`, {
      actorId: event.actorId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      severity: event.severity
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('AuditEventService', `Failed to record audit event: ${errorMessage}`, error as Error, {
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome
    });
    // Don't throw - audit-write failures must never break the operation being audited
  }
}
