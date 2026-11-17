/**
 * The cockpit compares the active configuration with the shipped api_config.json ("Compare with
 * defaults"). The file is only on the server - a bind mount on Docker, a ConfigMap on Kyma, both
 * refreshed by an upgrade - so the service hands it out, read on every call.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const configurationServiceFactory = require('../../../src/srv/config-service');

describe('getShippedConfiguration', () => {
  let dir: string;
  let cwd: jest.SpyInstance;
  let service: { on: jest.Mock; before: jest.Mock; after: jest.Mock };
  let configService: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-config-'));
    cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    service = { on: jest.fn(), before: jest.fn(), after: jest.fn() };
    configService = configurationServiceFactory(service);
  });

  afterEach(() => {
    cwd.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is registered on the service', () => {
    expect(service.on.mock.calls.map((call) => call[0])).toContain('getShippedConfiguration');
  });

  it('returns the file the installation ships, as it is on disk now', async () => {
    const shipped = { api_config: { providers: { anthropic: { supported_beta_headers: ['a-1'] } } } };
    fs.writeFileSync(path.join(dir, 'api_config.json'), JSON.stringify(shipped));

    const first = await configService.getShippedConfiguration();
    expect(first.available).toBe(true);
    expect(JSON.parse(first.configData)).toEqual(shipped);

    // An upgrade replaces the file while the service runs.
    shipped.api_config.providers.anthropic.supported_beta_headers.push('b-2');
    fs.writeFileSync(path.join(dir, 'api_config.json'), JSON.stringify(shipped));
    expect(JSON.parse((await configService.getShippedConfiguration()).configData)).toEqual(shipped);
  });

  it('a file that does not parse is not available, and its content is not passed on', async () => {
    fs.writeFileSync(path.join(dir, 'api_config.json'), '{ not json');

    expect(await configService.getShippedConfiguration()).toEqual({ available: false, configData: null });
  });
});
