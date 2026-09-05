export {}; // make this a TS module so top-level consts don't share global scope (avoids TS2451 across test files)
const r = require('../../../../cli-tools/sail-recon-profile.js');

describe('sail-recon-profile runtime (pure)', () => {
  it('isModelAvailable finds the target id', () => {
    const list = [{ id: 'anthropic--claude-4.5-sonnet--deployed' }, { id: 'other' }];
    expect(r.isModelAvailable(list, 'anthropic--claude-4.5-sonnet--deployed')).toBe(true);
    expect(r.isModelAvailable(list, 'missing')).toBe(false);
  });

  it('evalCacheHit detects a read', () => {
    expect(r.evalCacheHit([{ cache_read_input_tokens: 0 }, { cache_read_input_tokens: 100000 }]))
      .toEqual({ hit: true, reads: 100000 });
    expect(r.evalCacheHit([{ cache_read_input_tokens: 0 }])).toEqual({ hit: false, reads: 0 });
  });

  it('evalImageCapture flags the /anthropic capture gap', () => {
    expect(r.evalImageCapture(0, 5)).toEqual({ captured: false, gap: true });
    expect(r.evalImageCapture(12100, 5)).toEqual({ captured: true, gap: false });
  });

  it('planCells forces count=2 for smoke, real counts for full', () => {
    const cfg = r.resolveConfig({ baselineCount: 500, cacheReadRepeats: 3000 });
    const smoke = r.planCells(cfg, 'smoke');
    expect(smoke.every((c: any) => c.count === 2)).toBe(true);
    const full = r.planCells(cfg, 'full');
    expect(full.find((c: any) => c.name === 'cache-read').count).toBe(3000);
  });

  it('parseArgs reads tier, gateway, and falls back to RECON_API_KEY', () => {
    process.env.RECON_API_KEY = 'sk-env';
    expect(r.parseArgs(['--smoke', '--gateway', 'http://x:9'])).toMatchObject(
      { tier: 'smoke', gatewayUrl: 'http://x:9', key: 'sk-env', dryRun: false });
    expect(r.parseArgs(['--full', '--key', 'sk-arg', '--dry-run']).key).toBe('sk-arg');
  });
});
