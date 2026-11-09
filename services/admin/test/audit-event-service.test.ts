import { join } from 'path';

const cds = require('@sap/cds');

import { recordAuditEvent } from '../src/services/auditEventService';

describe('recordAuditEvent', () => {
  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  });

  it('persists actor, action, resource and outcome', async () => {
    await recordAuditEvent({
      actorId: 'operator-1',
      actorType: 'admin_user',
      action: 'api_key.rotate',
      resourceType: 'ApiKey',
      resourceId: 'key-123',
      outcome: 'success',
      severity: 'medium',
      clientIP: '203.0.113.9',
      details: 'rotated via admin UI',
    });

    // Assert via the same read path the admin service uses elsewhere.
    const rows = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'key-123', outcome: 'success' })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: 'operator-1',
      actorType: 'admin_user',
      action: 'api_key.rotate',
      resourceType: 'ApiKey',
      resourceId: 'key-123',
      outcome: 'success',
      severity: 'medium',
      clientIP: '203.0.113.9',
      details: 'rotated via admin UI',
    });
  });

  it('records a failed action rather than dropping it', async () => {
    await recordAuditEvent({
      actorId: 'operator-1',
      actorType: 'admin_user',
      action: 'api_key.rotate',
      resourceType: 'ApiKey',
      resourceId: 'key-123',
      outcome: 'failure',
      severity: 'high',
      clientIP: '203.0.113.9',
      details: 'rotation rejected: key not found',
    });

    const rows = await cds.run(
      cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'key-123', outcome: 'failure' })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'failure',
      severity: 'high',
      details: 'rotation rejected: key not found',
    });
  });
});
