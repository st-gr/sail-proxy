import * as path from 'path';
import {
  runExtractor,
  resolveBinary,
  ExtractionTimeoutError,
  ExtractionOutputTooLargeError,
} from '../../src/fileSearch/extractors/runners';

const FIXTURES = path.join(__dirname, 'fixtures');
const HANGING = path.join(FIXTURES, 'hangingProcess.js');
const FLOODING = path.join(FIXTURES, 'floodingProcess.js');
const ENV_DUMP = path.join(FIXTURES, 'envDumpProcess.js');
const DETACHED_GRANDCHILD = path.join(FIXTURES, 'detachedGrandchildProcess.js');
const GRANDCHILD_HOLDER = path.join(FIXTURES, 'grandchildHolder.js');

// process.execPath is a robust source for "node", but running it *through*
// runExtractor's own PATH-search codepath (binaryName: 'node') exercises
// resolveBinary the same way pandoc/pdftotext are resolved in production.
const NODE_BIN = 'node';

/** True if a pid is still alive (used to confirm a killed process is really gone, not zombied). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps` output (minus the header) for processes whose command line contains `needle`. */
function findProcessesByCommand(needle: string): string {
  const { execSync } = require('child_process');
  return execSync(`ps -eo pid,command | grep ${JSON.stringify(needle)} | grep -v grep || true`)
    .toString()
    .trim();
}

/**
 * Poll until `check()` returns true or `timeoutMs` elapses. Settlement and
 * process reaping are deliberately decoupled in runExtractor (see the
 * timeout test below), so "the promise rejected" no longer implies "the
 * process is already dead" the way it used to — tests that want to assert
 * eventual reaping need to poll for it instead of checking immediately.
 */
async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

describe('runExtractor', () => {
  it('feeds stdin through untouched and resolves stdout as text (no shell interpretation)', async () => {
    const input = Buffer.from('hello; rm -rf /tmp/should-not-run', 'utf8');
    const out = await runExtractor('cat', [], input, { timeoutMs: 5000 });
    expect(out).toBe('hello; rm -rf /tmp/should-not-run');
  });

  it('rejects with the tool name when the binary cannot be found on PATH', async () => {
    await expect(
      runExtractor('definitely-not-a-real-binary-xyz', [], Buffer.from(''), { timeoutMs: 1000 })
    ).rejects.toThrow(/not found on PATH/);
  });

  it('surfaces captured stderr when the tool exits non-zero', async () => {
    // `cat` on a nonexistent path argument exits non-zero and writes to stderr.
    await expect(
      runExtractor('cat', ['/nonexistent/path/for/test/xyz'], Buffer.from(''), { timeoutMs: 5000 })
    ).rejects.toThrow(/exited with code/);
  });

  it('kills a SIGTERM-ignoring process on timeout, escalating to SIGKILL, and the promise rejects', async () => {
    const runPromise = runExtractor(NODE_BIN, [HANGING], Buffer.from('x'), { timeoutMs: 150 });
    await expect(runPromise).rejects.toThrow(ExtractionTimeoutError);
    await expect(runPromise).rejects.toThrow(/timed out/i);

    // Prove runExtractor's OWN kill actually reaped the process it spawned —
    // not just that the promise rejected. A leaked zombie holding the pipe
    // open would be worse than no timeout at all. Settlement and reaping
    // are decoupled (the promise rejects from the timeout callback itself,
    // not from 'close' — see the grandchild-escape test below for why), so
    // the SIGKILL escalation may still be in flight when the promise
    // settles; poll rather than checking immediately.
    const reaped = await waitUntil(() => findProcessesByCommand(HANGING) === '', 5000);
    expect(reaped).toBe(true);
  }, 15000);

  it('rejects on timeout even when a descendant escapes the process group and holds stdout open', async () => {
    // Regression test for a settlement bug: the promise used to resolve only
    // from the immediate child's 'close' event. A "parser" that spawns a
    // detached grandchild inheriting fd 1 and then exits itself leaves
    // 'close' unfired — the pipe's write end stays open for as long as the
    // grandchild (now in its own process group, immune to our group-kill)
    // holds it — so the promise hung forever despite a short timeout. The
    // fix settles from the timeout callback itself instead of waiting on
    // 'close'. This is deliberately NOT reachable via pandoc/pdftotext
    // (neither daemonizes); it exercises the brief's stated worst case.
    const timeoutMs = 300;
    const start = Date.now();
    try {
      await expect(
        runExtractor(NODE_BIN, [DETACHED_GRANDCHILD], Buffer.from('x'), { timeoutMs })
      ).rejects.toThrow(ExtractionTimeoutError);
      const elapsed = Date.now() - start;
      // Rejection must land close to timeoutMs, not timeoutMs +
      // KILL_ESCALATION_MS (3000ms) — proving settlement no longer depends
      // on 'close', which this scenario can withhold indefinitely.
      expect(elapsed).toBeLessThan(timeoutMs + 1500);
    } finally {
      // The escaped grandchild is, by construction, outside runExtractor's
      // reach (that's the whole point of the scenario) — clean it up here
      // so it doesn't linger as an orphan on the test machine.
      const survivors = findProcessesByCommand(GRANDCHILD_HOLDER).split('\n').filter(Boolean);
      for (const line of survivors) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (Number.isFinite(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }
  }, 15000);

  it('the hanging fixture really does ignore SIGTERM (sanity check for the test above)', async () => {
    // Confirms the fixture is a faithful stand-in for a misbehaving tool:
    // SIGTERM alone must NOT kill it, only SIGKILL does. If this test ever
    // fails, the timeout test above would be exercising a process that dies
    // on SIGTERM anyway and would no longer prove the SIGKILL escalation path.
    const { spawn } = require('child_process');
    const nodeBin = resolveBinary('node');
    const child = spawn(nodeBin, [HANGING], { env: {}, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(child.pid!)).toBe(true);
    process.kill(-child.pid!, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(child.pid!)).toBe(true); // still alive: SIGTERM was ignored, as expected
    process.kill(-child.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(child.pid!)).toBe(false);
  });

  it('caps captured stdout and rejects well before the timeout fires', async () => {
    const start = Date.now();
    await expect(
      runExtractor(NODE_BIN, [FLOODING], Buffer.from('x'), { timeoutMs: 10000, maxOutputBytes: 200000 })
    ).rejects.toThrow(ExtractionOutputTooLargeError);
    const elapsed = Date.now() - start;
    // The flooding fixture writes 64KB every ms, so a 200KB cap should trip
    // in well under a second — proving the cap itself fired, not the 10s
    // timeout backstop.
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it('never lets the spawned process see this process\'s environment', async () => {
    process.env.FILE_SEARCH_TEST_SECRET = 'do-not-leak-me';
    try {
      const out = await runExtractor(NODE_BIN, [ENV_DUMP], Buffer.from('x'), { timeoutMs: 5000 });
      const childEnv = JSON.parse(out);
      // We can't assert childEnv is exactly {}: on macOS the OS itself injects
      // a fixed __CF_USER_TEXT_ENCODING value into every spawned process
      // regardless of what env is passed to spawn(). What matters is that
      // nothing from THIS process's environment — the secret we just set,
      // and PATH itself — made it across.
      expect(childEnv.FILE_SEARCH_TEST_SECRET).toBeUndefined();
      expect(childEnv.PATH).toBeUndefined();
      expect(Object.keys(childEnv).length).toBeLessThanOrEqual(1);
    } finally {
      delete process.env.FILE_SEARCH_TEST_SECRET;
    }
  });
});

describe('resolveBinary', () => {
  it('resolves a known binary to an absolute path', () => {
    const resolved = resolveBinary('node');
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('throws for an unknown binary name', () => {
    expect(() => resolveBinary('definitely-not-a-real-binary-xyz')).toThrow(/not found on PATH/);
  });
});
