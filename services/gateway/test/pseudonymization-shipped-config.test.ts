import * as fs from 'fs';
import * as path from 'path';
import { enforcementState } from '../src/pluginSupport/pseudonymization/enforcementState';

const read = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', p), 'utf-8')).api_config;
const shipped = read('services/gateway/api_config.json');

describe('shipped configuration', () => {
  it('ships with the global switch explicitly off', () => {
    expect(shipped.observability.pseudonymization.enabled).toBe(false);
    expect(Object.keys(shipped.observability.pseudonymization)[0]).toBe('enabled');
  });
  it('keeps the flags below, so one switch turns masking on everywhere', () => {
    for (const e of ['openai', 'anthropic', 'aws-bedrock', 'google']) expect(shipped.hooks.defaults[e].pseudonymization.enabled).toBe(true);
    expect(shipped.models.overrides['anthropic--claude-4-sonnet--deployed'].pseudonymization.enabled).toBe(true);
  });
  it('the admin copy and the standalone template are the same configuration', () => {
    expect(read('services/admin/api_config.json')).toEqual(shipped);
    expect(read('npm-dist/sail-proxy/src/templates/api_config.template.json')).toEqual(shipped);
  });
  it('reports as switched off with five overruled flags', () => {
    const s = enforcementState(shipped);
    expect(s).toEqual({ globalOn: false, endpoints: ['anthropic', 'openai', 'aws-bedrock', 'google'], models: ['anthropic--claude-4-sonnet--deployed'] });
  });
});
