/**
 * The connection credential store (spec 2026-10-23 §4.1): AES-256-GCM under CONNECTION_CREDENTIAL_KEY
 * with a per-record salt and IV, one row per connection, read back only as a masked hint on the
 * connection. No key means nothing is stored and nothing resolves; a wrong key or a tampered row
 * resolves to null rather than an error.
 */
import { join } from 'path';

const cds = require('@sap/cds');

import {
  setConnectionCredential, getConnectionCredential, deleteConnectionCredential, MissingConnectionKeyError, maskHint,
} from '../../../src/services/connectionCredentialStore';

const CREDS = 'sap.llm.gateway.admin.ConnectionCredentials';
const CONNS = 'sap.llm.gateway.admin.ProviderConnections';
const KEY = 'k'.repeat(64);
const SECRET = { secret: 'AKIAEXAMPLESECRETVALUE1234', sessionToken: 'tok' };

describe('connection credential store', () => {
  let connectionId: string;

  beforeAll(async () => {
    await cds.deploy(join(__dirname, '../../../src/db/schema')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    process.env.CONNECTION_CREDENTIAL_KEY = KEY;
    const { DELETE, INSERT } = cds.ql;
    await DELETE.from(CREDS);
    await DELETE.from(CONNS);
    connectionId = cds.utils.uuid();
    await INSERT.into(CONNS).entries({ ID: connectionId, name: 'bedrock-prod', providerType: 'bedrock' });
  });

  afterAll(() => { delete process.env.CONNECTION_CREDENTIAL_KEY; });

  const connection = () => cds.ql.SELECT.one.from(CONNS).where({ ID: connectionId });
  const rows = () => cds.ql.SELECT.from(CREDS);

  it('round-trips a secret and session token', async () => {
    await setConnectionCredential(connectionId, SECRET, 'admin@example.invalid');
    expect(await getConnectionCredential(connectionId)).toEqual(SECRET);
  });

  it('keeps one row per connection and uses a fresh salt and iv per write', async () => {
    await setConnectionCredential(connectionId, SECRET, 'a');
    const first = (await rows())[0];
    await setConnectionCredential(connectionId, SECRET, 'a');
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].salt).not.toBe(first.salt);
    expect(all[0].iv).not.toBe(first.iv);
  });

  it('stores no plaintext', async () => {
    await setConnectionCredential(connectionId, SECRET, 'a');
    expect(JSON.stringify(await rows())).not.toContain('AKIAEXAMPLESECRETVALUE1234');
  });

  it('sets the masked hint and timestamp on the connection', async () => {
    const { hint } = await setConnectionCredential(connectionId, SECRET, 'a');
    const row = await connection();
    expect(hint).toBe('AKIA…1234');
    expect(row.credentialHint).toBe('AKIA…1234');
    expect(row.credentialUpdatedAt).toBeTruthy();
  });

  it('gives a short secret an uninformative hint', () => {
    expect(maskHint('short-secret')).toBe('…');
  });

  it('refuses to store without the key', async () => {
    delete process.env.CONNECTION_CREDENTIAL_KEY;
    await expect(setConnectionCredential(connectionId, SECRET, 'a')).rejects.toBeInstanceOf(MissingConnectionKeyError);
    expect(await rows()).toHaveLength(0);
  });

  it('reads null under a different key', async () => {
    await setConnectionCredential(connectionId, SECRET, 'a');
    process.env.CONNECTION_CREDENTIAL_KEY = 'z'.repeat(64);
    expect(await getConnectionCredential(connectionId)).toBeNull();
  });

  it('reads null when the auth tag is altered', async () => {
    await setConnectionCredential(connectionId, SECRET, 'a');
    const row = (await rows())[0];
    const flipped = (row.authTag[0] === '0' ? '1' : '0') + row.authTag.slice(1);
    await cds.ql.UPDATE(CREDS).set({ authTag: flipped }).where({ ID: row.ID });
    expect(await getConnectionCredential(connectionId)).toBeNull();
  });

  it('reads null when no credential is stored', async () => {
    expect(await getConnectionCredential(connectionId)).toBeNull();
  });

  it('delete removes the row and the hint', async () => {
    await setConnectionCredential(connectionId, SECRET, 'a');
    await deleteConnectionCredential(connectionId);
    expect(await rows()).toHaveLength(0);
    const row = await connection();
    expect(row.credentialHint).toBeNull();
    expect(row.credentialUpdatedAt).toBeNull();
  });

  it('ConnectionCredentials is exposed on no service', async () => {
    const csn = await cds.load(join(__dirname, '../../../src/srv'));
    const exposing = Object.entries(csn.definitions).filter(([name, def]: [string, any]) =>
      !name.startsWith('sap.llm.gateway.admin.') && def.kind === 'entity'
      && (def.projection?.from?.ref?.[0] === CREDS || def.query?.SELECT?.from?.ref?.[0] === CREDS));
    expect(exposing).toEqual([]);
  });
});
