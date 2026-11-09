/**
 * The standalone gateway's Connections source: connections.json (spec 2026-10-27 E). The validation
 * cases live in fixtures/connections-file-cases.json, which the CLI's validator test reads too, so both
 * validators agree. A refusal names a path, never a value.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const logged: string[] = [];
const record = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: record, info: record, warn: record, error: record, trace: record }) }));

import { parseConnectionsFile, fileConnectionBackend, connectionsFilePath, ConnectionsFileError } from '../src/connections/fileBackend';

const cases: Array<{ name: string; file: unknown; ok: boolean; path?: string; hidden?: string }> =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/connections-file-cases.json'), 'utf8'));

const SENTINEL = 'sk-sentinel-DO-NOT-LEAK';

describe('parseConnectionsFile: fixture cases', () => {
  for (const c of cases) {
    it(c.name, () => {
      const text = JSON.stringify(c.file);
      if (c.ok) {
        expect(() => parseConnectionsFile(text, {})).not.toThrow();
        return;
      }
      let thrown: unknown;
      try { parseConnectionsFile(text, {}); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ConnectionsFileError);
      expect((thrown as ConnectionsFileError).path).toBe(c.path);
      // A refused env-ref name may be a pasted secret: it is never part of the message.
      if (c.hidden) expect((thrown as Error).message).not.toContain(c.hidden);
    });
  }
});

describe('parseConnectionsFile: mapping', () => {
  const full = cases.find((c) => c.name === 'all four types')!;

  it('maps the four provider types', () => {
    const result = parseConnectionsFile(JSON.stringify(full.file), { AZURE_OPENAI_KEY: 'az-key' });
    expect(result.map((c) => [c.id, c.name, c.providerType, c.isActive])).toEqual([
      ['oa', 'oa', 'openai', true],
      ['azure-prod', 'azure-prod', 'azure-openai', true],
      ['claude-direct', 'claude-direct', 'anthropic', false],
      ['aws-east', 'aws-east', 'bedrock', true],
    ]);
    expect(result[1].settings).toEqual({ endpoint: 'https://x.openai.azure.com', apiMode: 'v1', authMode: 'api-key' });
    expect(result[1].credentials).toEqual({ secret: 'az-key' });
    expect(result[0].credentials).toEqual({ secret: 'sk-x' });
    expect(result[1].models).toEqual([{
      modelId: 'gpt-mini-deployment--azure-prod', upstreamModel: 'gpt-mini-deployment', displayName: 'GPT mini', family: 'openai',
      capabilities: ['chat', 'streaming'], priced: true,
    }]);
    expect(result[0].models[0]).toMatchObject({ modelId: 'gpt-4o--oa', displayName: null, capabilities: [], family: 'openai' });
  });

  it('defaults family to claude for anthropic and bedrock', () => {
    const result = parseConnectionsFile(JSON.stringify(full.file), {});
    expect(result[2].models[0].family).toBe('claude');
    expect(result[3].models[0].family).toBe('claude');
  });

  it('resolves an env ref, and an unset one gives credentials: null', () => {
    const file = { version: 1, connections: [{ name: 'aws', type: 'bedrock', settings: { region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE' }, secret: { env: 'OA_KEY' }, sessionToken: { env: 'OA_TOKEN' }, models: [] }] };
    expect(parseConnectionsFile(JSON.stringify(file), { OA_KEY: 'k1', OA_TOKEN: 't1' })[0].credentials).toEqual({ secret: 'k1', sessionToken: 't1' });
    expect(parseConnectionsFile(JSON.stringify(file), { OA_KEY: 'k1' })[0].credentials).toEqual({ secret: 'k1' });
    expect(parseConnectionsFile(JSON.stringify(file), {})[0].credentials).toBeNull();
    expect(parseConnectionsFile(JSON.stringify(file), { OA_KEY: '' })[0].credentials).toBeNull();
  });

  it('refuses text that is not JSON without echoing it', () => {
    let thrown: ConnectionsFileError | undefined;
    try { parseConnectionsFile(`{"secret": "${SENTINEL}" oops`, {}); } catch (e) { thrown = e as ConnectionsFileError; }
    expect(thrown).toBeInstanceOf(ConnectionsFileError);
    expect(thrown!.path).toBe('');
    expect(thrown!.message).not.toContain(SENTINEL);
  });

  it('never puts a secret value in a refusal', () => {
    const file = { version: 1, connections: [{ name: 'aws', type: 'bedrock', settings: { region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE' }, secret: SENTINEL, sessionToken: 5, models: [] }] };
    let thrown: ConnectionsFileError | undefined;
    try { parseConnectionsFile(JSON.stringify(file), {}); } catch (e) { thrown = e as ConnectionsFileError; }
    expect(thrown!.path).toBe('connections[0].sessionToken');
    expect(thrown!.message).not.toContain(SENTINEL);
  });
});

describe('connectionsFilePath', () => {
  it('prefers CONNECTIONS_FILE_PATH, then the CONFIG_FILE_PATH directory, else null', () => {
    expect(connectionsFilePath({ CONNECTIONS_FILE_PATH: '/a/c.json', CONFIG_FILE_PATH: '/b/config.json' })).toBe('/a/c.json');
    expect(connectionsFilePath({ CONFIG_FILE_PATH: '/b/config.json' })).toBe(path.join('/b', 'connections.json'));
    expect(connectionsFilePath({})).toBeNull();
  });
});

describe('fileConnectionBackend', () => {
  let dir: string;
  beforeEach(() => { logged.length = 0; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-file-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (mode: number, file: unknown = { version: 1, connections: [{ name: 'oa', type: 'openai', secret: SENTINEL, models: [{ upstreamModel: 'gpt-4o' }] }] }) => {
    const p = path.join(dir, 'connections.json');
    fs.writeFileSync(p, JSON.stringify(file), { mode });
    fs.chmodSync(p, mode);
    return p;
  };

  it('reads the file at each fetch', async () => {
    const p = write(0o600);
    const backend = fileConnectionBackend(p, {});
    expect((await backend.fetch()).map((c) => c.name)).toEqual(['oa']);
    write(0o600, { version: 1, connections: [] });
    expect(await backend.fetch()).toEqual([]);
  });

  it('a missing file is no connections, not a failure', async () => {
    expect(await fileConnectionBackend(path.join(dir, 'connections.json'), {}).fetch()).toEqual([]);
  });

  it('rejects a malformed file with the path logged, never a value', async () => {
    const p = write(0o600, { version: 1, connections: [{ name: 'A', type: 'openai', secret: SENTINEL }] });
    await expect(fileConnectionBackend(p, {}).fetch()).rejects.toBeInstanceOf(ConnectionsFileError);
    expect(logged.join('\n')).toContain('connections[0].name');
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('logs the error code and file path of a read failure other than a missing file, then rethrows', async () => {
    const p = path.join(dir, 'connections.json');
    fs.mkdirSync(p); // reading a directory fails with EISDIR
    await expect(fileConnectionBackend(p, {}).fetch()).rejects.toMatchObject({ code: 'EISDIR' });
    expect(logged.some((l) => l.includes('EISDIR') && l.includes(p))).toBe(true);
  });

  (process.platform === 'win32' ? it.skip : it)('warns once about a file looser than 0600 and still reads it', async () => {
    const p = write(0o644);
    const backend = fileConnectionBackend(p, {});
    expect(await backend.fetch()).toHaveLength(1);
    expect(await backend.fetch()).toHaveLength(1);
    const warnings = logged.filter((l) => l.includes('permissions'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(SENTINEL);
  });

  it('a file removed between reading and the permission check is read, not an error', async () => {
    const p = write(0o600);
    const stat = jest.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    try {
      expect((await fileConnectionBackend(p, {}).fetch()).map((c) => c.name)).toEqual(['oa']);
    } finally { stat.mockRestore(); }
  });

  it('logs a refusal once while the file stays the same, and again when it changes', async () => {
    const p = write(0o600, { version: 1, connections: [{ name: 'A', type: 'openai', secret: SENTINEL }] });
    const backend = fileConnectionBackend(p, {});
    const refusals = () => logged.filter((l) => l.includes('refused at')).length;
    await expect(backend.fetch()).rejects.toBeInstanceOf(ConnectionsFileError);
    await expect(backend.fetch()).rejects.toBeInstanceOf(ConnectionsFileError);
    expect(refusals()).toBe(1);
    write(0o600, { version: 1, connections: [{ name: 'oa', type: 'nope', secret: SENTINEL }] });
    await expect(backend.fetch()).rejects.toBeInstanceOf(ConnectionsFileError);
    expect(refusals()).toBe(2);
    write(0o600);
    await backend.fetch();
    write(0o600, { version: 1, connections: [{ name: 'oa', type: 'nope', secret: SENTINEL }] });
    await expect(backend.fetch()).rejects.toBeInstanceOf(ConnectionsFileError);
    expect(refusals()).toBe(3);
  });

  (process.platform === 'win32' ? it.skip : it)('does not warn for 0600', async () => {
    await fileConnectionBackend(write(0o600), {}).fetch();
    expect(logged.filter((l) => l.includes('permissions'))).toHaveLength(0);
  });
});

describe('parseConnectionsFile: env references', () => {
  it('an env name of an inherited property (toString) resolves to no credential, not a function', () => {
    const file = { version: 1, connections: [{ name: 'oa', type: 'openai', secret: { env: 'toString' } }] };
    expect(parseConnectionsFile(JSON.stringify(file), process.env)[0].credentials).toBeNull();
    expect(parseConnectionsFile(JSON.stringify(file), {})[0].credentials).toBeNull();
  });
});
