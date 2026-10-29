/**
 * Team attribution at ingestion (spec 2026-10-14 §6): the event's teamId, else the credential's
 * team, else the owner's primary team, else none; a service key books to the acting user's
 * primary team; rows snapshot the team name; team buckets land in the same transaction. Real
 * in-memory SQLite, un-mocked, like usage-event-processor-counters.test.ts.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
const cds = require('@sap/cds');
import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';
import { TEAM_BUCKETS, BUCKETS } from '../../src/services/usageCounters';

const KEYS = 'sap.llm.gateway.admin.ApiKeys'; const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage'; const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const TEAMS = 'sap.llm.gateway.admin.Teams'; const MEMBERS = 'sap.llm.gateway.admin.TeamMembers';
const T0 = Math.floor(new Date('2026-10-14T10:00:00Z').getTime() / 1000);

describe('UsageEventProcessor: team attribution (real sqlite, un-mocked)', () => {
  let db: any;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });
  beforeEach(async () => {
    const { DELETE, INSERT } = cds.ql;
    for (const t of [TEAM_BUCKETS, BUCKETS, KEY_USAGE, AWS_USAGE, MEMBERS, TEAMS, KEYS, AWS]) await db.run(DELETE.from(t));
    await db.run(INSERT.into(TEAMS).entries([{ ID: 't-a', name: 'Alpha' }, { ID: 't-b', name: 'Beta' }]));
    await db.run(INSERT.into(MEMBERS).entries([{ ID: 'm1', team_ID: 't-a', email: 'a@test.com', role: 'member', isPrimary: true }, { ID: 'm2', team_ID: 't-b', email: 'b@test.com', role: 'member', isPrimary: true }]));
    await db.run(INSERT.into(KEYS).entries([
      { ID: 'k-a', key: 'sk-a', name: 'a', email: 'a@test.com', isActive: true, usageCount: 0 },
      { ID: 'k-bound', key: 'sk-bound', name: 'bound', email: 'a@test.com', isActive: true, usageCount: 0, team_ID: 't-b' },
      { ID: 'k-none', key: 'sk-none', name: 'none', email: 'c@test.com', isActive: true, usageCount: 0 },
      { ID: 'k-svc', key: 'sk-svc', name: 'svc', email: 'admin2gateway.service.key', isActive: true, usageCount: 0 }
    ]));
    await db.run(INSERT.into(AWS).entries({ ID: 'c-b', accessKeyId: 'AKIAB', secretHash: 'h', salt: 's', name: 'c', email: 'b@test.com', userId: 'b@test.com', isActive: true, usageCount: 0 }));
  });
  const processor = () => new UsageEventProcessor({ enableCostCalculation: false });
  const persist = (p: UsageEventProcessor, events: UsageEvent[]) => (p as any).persistUsageEvents(events);
  const event = (o: Partial<UsageEvent>): UsageEvent => ({ requestId: uuidv4(), timestamp: T0, authType: 'api_key', credentialId: 'k-a', provider: 'anthropic', model: 'm', inputTokens: 100, outputTokens: 50, responseTime: 10, statusCode: 200, ...o });
  const rows = async (t: string) => (await db.run(cds.ql.SELECT.from(t).columns('team_ID', 'teamName').orderBy('teamName')));
  const teamBuckets = async () => (await db.run(cds.ql.SELECT.from(TEAM_BUCKETS).columns('teamId', 'requests', 'tokens').orderBy('teamId'))).map((r: any) => ({ teamId: r.teamId, requests: Number(r.requests), tokens: Number(r.tokens) }));

  it('attributes by event teamId, else the credential team, else the primary, else none, and snapshots the name', async () => {
    await persist(processor(), [
      event({ credentialId: 'k-a' }),
      event({ credentialId: 'k-bound' }),
      event({ credentialId: 'k-a', teamId: 't-b' }),
      event({ credentialId: 'k-none' }),
      event({ authType: 'aws_credential', credentialId: 'c-b', inputTokens: 1, outputTokens: 0 })
    ]);
    expect(await rows(KEY_USAGE)).toEqual([{ team_ID: null, teamName: null }, { team_ID: 't-a', teamName: 'Alpha' }, { team_ID: 't-b', teamName: 'Beta' }, { team_ID: 't-b', teamName: 'Beta' }]);
    expect(await rows(AWS_USAGE)).toEqual([{ team_ID: 't-b', teamName: 'Beta' }]);
    expect(await teamBuckets()).toEqual([{ teamId: 't-a', requests: 1, tokens: 150 }, { teamId: 't-b', requests: 3, tokens: 301 }]);
  });

  it('a service key acting on behalf of a user books to that user\'s primary team; a replayed duplicate does not count twice', async () => {
    const e = event({ credentialId: 'k-svc', onBehalfOf: 'b@test.com' });
    await persist(processor(), [e]);
    await persist(processor(), [e]);
    expect(await rows(KEY_USAGE)).toEqual([{ team_ID: 't-b', teamName: 'Beta' }]);
    expect(await teamBuckets()).toEqual([{ teamId: 't-b', requests: 1, tokens: 150 }]);
  });
});
