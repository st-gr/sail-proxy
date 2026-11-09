import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { withPluginLock } from '../src/pluginInstall/lock';
import { getGatewayVersion } from '../src/pluginInstall/gatewayVersion';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('withPluginLock', () => {
  it('does not interleave concurrent holders', async () => {
    const events: string[] = [];
    const job = (name: string, ms: number) => withPluginLock(async () => {
      events.push(`${name}:start`);
      await tick(ms);
      events.push(`${name}:end`);
      return name;
    });
    const results = await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('releases the lock when a holder rejects', async () => {
    await expect(withPluginLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withPluginLock(async () => 'next')).resolves.toBe('next');
  });

  it('releases the lock when a holder throws synchronously', async () => {
    await expect(withPluginLock((() => { throw new Error('sync'); }) as any)).rejects.toThrow('sync');
    await expect(withPluginLock(async () => 'next')).resolves.toBe('next');
  });
});

describe('getGatewayVersion', () => {
  let root: string;
  beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-version-'))); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the gateway manifest from a nested folder, skipping a nearer one with another name', () => {
    const nested = path.join(root, 'dist', 'services');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gateway', version: '3.4.5' }));
    fs.writeFileSync(path.join(root, 'dist', 'package.json'), JSON.stringify({ name: 'other', version: '9.9.9' }));
    expect(getGatewayVersion(nested)).toBe('3.4.5');
  });

  it('returns 0.0.0 when no gateway manifest exists', () => {
    // the temp dir has no gateway manifest above it
    const lonely = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-none-')));
    try {
      expect(getGatewayVersion(lonely)).toBe('0.0.0');
    } finally {
      fs.rmSync(lonely, { recursive: true, force: true });
    }
  });

  it('reads the real gateway version by default', () => {
    const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version;
    expect(getGatewayVersion()).toBe(real);
  });
});
