/** The admin's copy of the shipped api_config.json carries the gateway-log block both readers expect. */
import { readFileSync } from 'fs';
import { join } from 'path';
import { gatewayLogSettings } from '../../../src/services/gatewayLogIngest';

describe('gatewayLogSettings on the shipped configuration', () => {
  it('reads the block of the admin copy of api_config.json: stored log on, 48 hours, 2,000,000 entries, INFO', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'api_config.json'), 'utf8'));
    expect(shipped.api_config.observability.gateway_log).toEqual({ enabled: true, retention_hours: 48, max_entries: 2000000, min_level: 'INFO' });
    expect(gatewayLogSettings(shipped)).toEqual({ enabled: true, retentionHours: 48, maxEntries: 2000000, minLevel: 'INFO' });
  });
});
