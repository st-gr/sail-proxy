// Guards two process-safety properties of the extractor subprocess pipeline
// that aren't otherwise exercised by extractors.test.ts / runners.test.ts:
//
//   1. runExtractor's spawn() call pins an explicit cwd (never the gateway's
//      own working directory) — see runners.ts's comment at the spawn call.
//   2. UnsupportedFileTypeError never retains the raw, caller-controlled
//      extension as a readable property — only the sanitized form reaches
//      `.message` — see registry.ts's class comment.
//
// child_process is mocked here (unlike runners.test.ts, which spawns real
// processes to exercise timeout/kill/output-cap behavior) because this file
// only needs to inspect the options object handed to spawn(), not run a
// real tool to completion.

import { EventEmitter } from 'events';

const spawnMock = jest.fn();

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { runExtractor } from '../../src/fileSearch/extractors/runners';
import { UnsupportedFileTypeError } from '../../src/fileSearch/extractors/registry';

/** A minimal fake ChildProcess: just enough surface for runExtractor's
 *  listener wiring (stdout/stderr/stdin event emitters plus stream methods
 *  it calls directly) without spawning anything real. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.kill = jest.fn();
  child.stdout = new EventEmitter();
  child.stdout.destroy = jest.fn();
  child.stderr = new EventEmitter();
  child.stderr.destroy = jest.fn();
  child.stdin = new EventEmitter();
  child.stdin.end = jest.fn();
  child.stdin.destroy = jest.fn();
  return child;
}

describe('extractor subprocess hardening', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the extractor with an explicit cwd, never inheriting the gateway process cwd', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const runPromise = runExtractor('node', [], Buffer.from('x'), { timeoutMs: 5000 });

    // spawn() is invoked synchronously inside runExtractor's Promise
    // executor, before this line runs, so the call is already recorded.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2];

    expect(opts.cwd).toBeDefined();
    expect(opts.cwd).not.toBe(process.cwd());

    // Let the in-flight promise settle so the test doesn't leak a timer.
    child.emit('close', 0);
    await runPromise;
  });

  it('does not expose the raw extension as a readable property', () => {
    const err = new UnsupportedFileTypeError('.\u001b[31mevil\u0007');
    // The sanitized form is what may be read; the raw form must not be reachable.
    expect((err as any).ext).toBeUndefined();
    expect(err.message).not.toMatch(/[\u001b\u0007]/);
  });

  it('still names the extension in the message, sanitized', () => {
    expect(new UnsupportedFileTypeError('.pptx').message).toContain('.pptx');
  });
});
