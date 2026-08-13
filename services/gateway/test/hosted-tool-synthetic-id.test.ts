import { syntheticId } from '../src/plugins/hostedTool/syntheticId';

describe('syntheticId', () => {
  it('keeps the <prefix>_<7+ base36 chars> shape the characterization suite normalises', () => {
    expect(syntheticId('ws')).toMatch(/^ws_[0-9a-z]{7,}$/);
    expect(syntheticId('fs')).toMatch(/^fs_[0-9a-z]{7,}$/);
  });

  it('never repeats, even for ids minted in the same millisecond', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => syntheticId('ws')));
    expect(ids.size).toBe(2000);
  });

  it('carries entropy, so a second process starting from counter 0 cannot reproduce the sequence', () => {
    // Neither "compare two consecutive ids" nor "mint N ids in one process and count
    // distinct tails" discriminates here: a monotonically increasing counter alone
    // guarantees every id in a single process is unique, entropy or not — the counter's
    // own growth is enough to make 200 sequential tails 200/200 distinct even with zero
    // randomness. The actual bug is cross-process: two gateway processes each start their
    // counter at 0, and if both mint at the same Date.now() millisecond, a counter-only id
    // is fully determined by (time, counter) and the two processes produce the *same*
    // string. Simulate that directly: two independently-initialised copies of the module
    // (jest.isolateModules gives each its own module-level `counter`, starting at 0) minting
    // at an identical, mocked Date.now().
    const fixedNow = 1700000000000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    let idFromProcessA = '';
    let idFromProcessB = '';
    try {
      jest.isolateModules(() => {
        const fresh = require('../src/plugins/hostedTool/syntheticId');
        idFromProcessA = fresh.syntheticId('ws');
      });
      jest.isolateModules(() => {
        const fresh = require('../src/plugins/hostedTool/syntheticId');
        idFromProcessB = fresh.syntheticId('ws');
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(idFromProcessA).not.toBe(idFromProcessB);
  });

  it('draws the 6-char random tail uniformly from the base36 alphabet, with no clustering', () => {
    // Pins the fix for a prior bug: encoding a random uint32 to base36 and slicing to 6
    // chars silently dropped the low digit ~49% of the time, collapsing runs of 36
    // consecutive raw values onto one identical tail. Assert the structural guarantees
    // (always 6 chars, always base36) plus a loose diversity bound — not exact statistical
    // properties, which could flake.
    const tail = (id: string) => id.slice(-6);
    const tails = Array.from({ length: 3000 }, () => tail(syntheticId('ws')));
    for (const t of tails) {
      expect(t).toMatch(/^[0-9a-z]{6}$/);
    }
    const distinct = new Set(tails);
    expect(distinct.size).toBeGreaterThan(tails.length * 0.95);
  });
});
