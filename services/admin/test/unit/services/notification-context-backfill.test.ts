/**
 * Envelope rows written before the context columns existed hold no IP; the backfill copies it
 * from the source event once, leaves rotation notifications alone and is a no-op the second time.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import { backfillNotificationContext } from '../../../src/db/data/security-notification-context-backfill';

const NOTES = 'sap.llm.gateway.admin.SecurityNotifications';
const EVENTS = 'sap.llm.gateway.admin.ApiKeySecurityEvents';
const AWS_EVENTS = 'sap.llm.gateway.admin.AwsCredentialSecurityEvents';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE } = cds.ql;
  for (const t of [NOTES, EVENTS, AWS_EVENTS]) await db.run(DELETE.from(t));
});

const envelope = (sourceEntity: string, sourceID: string, extra: any = {}) => ({
  type: sourceEntity === 'AwsCredentialRotations' ? 'rotation_event' : 'security_event',
  sourceEntity, sourceID, ownerEmail: 'o@test.com', title: 't', message: 'm', severity: 'high',
  eventType: 'failed_auth', eventDate: new Date(), ...extra
});

describe('backfillNotificationContext', () => {
  it('copies the four context fields from both source entities and skips rotations', async () => {
    const { INSERT, SELECT } = cds.ql;
    await db.run(INSERT.into(EVENTS).entries({ ID: 'e-1', eventType: 'failed_auth', severity: 'high', description: 'd',
      clientIP: '203.0.113.7', userAgent: 'ua', endpoint: '/v1/messages', requestId: 'r-1' }));
    await db.run(INSERT.into(AWS_EVENTS).entries({ ID: 'e-2', eventType: 'failed_auth', severity: 'high', description: 'd',
      clientIP: '203.0.113.8', userAgent: null, endpoint: '/aws-bedrock', requestId: null }));
    await db.run(INSERT.into(NOTES).entries([
      { ID: 'n-1', ...envelope('ApiKeySecurityEvents', 'e-1') },
      { ID: 'n-2', ...envelope('AwsCredentialSecurityEvents', 'e-2') },
      { ID: 'n-3', ...envelope('AwsCredentialRotations', 'e-3') },
      { ID: 'n-4', ...envelope('ApiKeySecurityEvents', 'e-1', { clientIP: '198.51.100.1' }) }   // already filled
    ]));

    expect(await backfillNotificationContext(db)).toBe(2);

    const rows = await db.run(SELECT.from(NOTES).columns('ID', 'clientIP', 'userAgent', 'endpoint', 'requestId').orderBy('ID'));
    expect(rows).toEqual([
      { ID: 'n-1', clientIP: '203.0.113.7', userAgent: 'ua', endpoint: '/v1/messages', requestId: 'r-1' },
      { ID: 'n-2', clientIP: '203.0.113.8', userAgent: null, endpoint: '/aws-bedrock', requestId: null },
      { ID: 'n-3', clientIP: null, userAgent: null, endpoint: null, requestId: null },
      { ID: 'n-4', clientIP: '198.51.100.1', userAgent: null, endpoint: null, requestId: null }
    ]);
    expect(await backfillNotificationContext(db)).toBe(0);   // idempotent
  });
});
