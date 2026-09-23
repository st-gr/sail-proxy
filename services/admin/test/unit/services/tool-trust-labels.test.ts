/**
 * Trust labels on the admin side (spec 2026-09-22 §6): validation of the two new pattern lists, and
 * the recording of trust-chain reasons and result sources.
 */
import { validatePolicyWrite } from '../../../src/services/toolPolicyService';
import { recordToolUsage, TOOL_USAGE, TOOL_USAGE_DAILY } from '../../../src/services/toolUsageService';

describe('validatePolicyWrite with labels', () => {
  it('accepts valid sensitive and untrusted patterns and rejects malformed ones', () => {
    expect(validatePolicyWrite({ sensitive: [{ pattern: 'function:shell' }], untrusted: [{ pattern: 'mcp:browser/*' }] }, null)).toEqual([]);
    const errors = validatePolicyWrite({ sensitive: [{ pattern: 'shell' }], untrusted: [{ pattern: 'mcp:browser/**' }] }, null);
    expect(errors.some((e) => e.startsWith('sensitive pattern "shell"'))).toBe(true);
    expect(errors.some((e) => e.startsWith('untrusted source pattern "mcp:browser/**"'))).toBe(true);
  });
});

describe('recordToolUsage with reasons and sources', () => {
  it('writes the reason on the raw row and counts trust-chain hits in the daily row', async () => {
    const runs: any[] = [];
    const tx = { run: async (q: any) => { runs.push(q); return q?.SELECT ? [] : 1; } };
    await recordToolUsage(tx, [{
      requestId: 'r1', timestamp: 1_790_000_000, credentialId: 'c1', userAgent: 'claude-cli/2.0.1',
      tools: [
        { identity: 'function:Bash', facet: 'declared', count: 1, decision: 'stripped', reason: 'trust_chain' },
        { identity: 'function:rm', facet: 'declared', count: 1, decision: 'stripped', reason: 'policy' },
        { identity: 'mcp:browser/fetch', facet: 'source', count: 2, decision: 'allowed' }
      ]
    }], () => 'alex@example.invalid');
    const raw = runs.find((q) => q?.INSERT?.into?.ref?.[0] === TOOL_USAGE || q?.INSERT?.into === TOOL_USAGE);
    const rows = raw.INSERT.entries;
    expect(rows.find((r: any) => r.identity === 'function:Bash').reason).toBe('trust_chain');
    expect(rows.find((r: any) => r.identity === 'function:rm').reason).toBe('policy');
    expect(rows.find((r: any) => r.identity === 'mcp:browser/fetch').facet).toBe('source');
    const dailyInserts = runs.filter((q) => (q?.INSERT?.into?.ref?.[0] ?? q?.INSERT?.into) === TOOL_USAGE_DAILY).flatMap((q) => q.INSERT.entries);
    expect(dailyInserts.find((r: any) => r.identity === 'function:Bash').trustChained).toBe(1);
    expect(dailyInserts.find((r: any) => r.identity === 'function:rm').trustChained).toBe(0);
    expect(dailyInserts.find((r: any) => r.identity === 'mcp:browser/fetch')).toMatchObject({ facet: 'source', allowed: 2 });
  });
});
