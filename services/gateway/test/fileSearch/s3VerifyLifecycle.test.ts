/**
 * The S3 verification's exit paths, with fakes only (no docker, no network): the pg container is
 * removed by a start that fails after `docker run`, never when it belongs to someone else; the end
 * of a run executes every step once, each on its own, also on SIGINT/SIGTERM; and errors print the
 * script's own message, an S3 error as op/status/code only.
 */
import { CONTAINER, ContainerOps, startContainer } from '../../scripts/fileSearchS3Verify/database';
import { ScriptError } from '../../scripts/fileSearchS3Verify/errors';
import { onceFinalizer, onSignals } from '../../scripts/fileSearchS3Verify/finalize';
import { describeError, Mismatch } from '../../scripts/fileSearchS3Verify/execute';
import { GuardViolation } from '../../scripts/fileSearchS3Verify/guard';
import { S3RequestError } from '../../src/fileSearch/blob/s3Backend';

function fakeOps(opts: { existing?: string; runFails?: boolean; readyAfter?: number } = {}) {
  const calls: string[][] = [];
  let clock = 0;
  let attempts = 0;
  const ops: ContainerOps = {
    docker: (args) => {
      calls.push(args);
      if (args[0] === 'ps') return opts.existing ?? '';
      if (args[0] === 'run' && opts.runFails) {
        throw Object.assign(new Error('Command failed: docker run …'), { stderr: 'port is already allocated\n' });
      }
      return '';
    },
    ready: async () => ++attempts > (opts.readyAfter ?? 0),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  const removed = () => calls.filter((c) => c[0] === 'rm').map((c) => c.join(' '));
  return { ops, calls, removed };
}

describe('the verification pg container', () => {
  it('refuses a container of that name that already exists, and leaves it alone', async () => {
    const f = fakeOps({ existing: 'exited' });
    const error = await startContainer(() => {}, f.ops).catch((e) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect(error.message).toContain(`docker rm -f -v ${CONTAINER}`);
    expect(f.removed()).toEqual([]);
    expect(f.calls.some((c) => c[0] === 'run')).toBe(false);
  });

  it('removes what a failed docker run may have created (created but not started)', async () => {
    const f = fakeOps({ runFails: true });
    const error = await startContainer(() => {}, f.ops).catch((e) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect(error.message).toContain('could not be started (port is already allocated)');
    expect(f.removed()).toEqual([`rm -f -v ${CONTAINER}`]);
  });

  it('removes a container that never accepts connections', async () => {
    const f = fakeOps({ readyAfter: Infinity });
    const error = await startContainer(() => {}, f.ops, 3000).catch((e) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect(error.message).toContain('did not accept connections within 3 s');
    expect(f.removed()).toEqual([`rm -f -v ${CONTAINER}`]);
  });

  it('marks the container created as soon as docker run returns, so a signal during the readiness wait removes it', async () => {
    const f = fakeOps({ readyAfter: Infinity });
    const state = { created: false };
    const seenDuringWait: boolean[] = [];
    let finalized: string[] | null = null;
    // The end of the run as the script builds it: remove the container only if one was created.
    const finalize = onceFinalizer([{ name: 'container removal', run: () => {
      if (state.created) { f.ops.docker(['rm', '-f', '-v', CONTAINER]); state.created = false; }
    } }], () => {});
    const ops: ContainerOps = {
      ...f.ops,
      ready: async () => {
        seenDuringWait.push(state.created);
        if (!finalized) finalized = await finalize(); // a SIGINT arriving mid-wait
        return false;
      },
    };
    const error = await startContainer(() => {}, ops, 2000, state).catch((e) => e);
    expect(seenDuringWait[0]).toBe(true);
    expect(f.removed()).toHaveLength(2); // the signal's removal, then the timed-out start's own
    expect(error).toBeInstanceOf(ScriptError);
    expect(state.created).toBe(false);
  });

  it('a start that removed its container leaves nothing for the end of the run', async () => {
    const state = { created: false };
    await startContainer(() => {}, fakeOps({ runFails: true }).ops, 1000, state).catch(() => undefined);
    expect(state.created).toBe(false);
    await startContainer(() => {}, fakeOps({ readyAfter: 1 }).ops, 1000, state);
    expect(state.created).toBe(true);
  });

  it('returns the DSN once ready and removes nothing', async () => {
    const f = fakeOps({ readyAfter: 2 });
    await expect(startContainer(() => {}, f.ops)).resolves.toContain('127.0.0.1:55470');
    expect(f.removed()).toEqual([]);
  });
});

describe('the end of a run', () => {
  it('runs every step once, each on its own: a failing step does not skip the next', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const finalize = onceFinalizer([
      { name: 'S3 cleanup', run: async () => { ran.push('s3'); throw new Error('network down'); } },
      { name: 'container removal', run: () => { ran.push('container'); throw new Error('docker gone'); } },
      { name: 'temporary configuration removal', run: () => { ran.push('tmp'); } },
    ], (m) => log.push(m));
    expect(await finalize()).toEqual(['S3 cleanup', 'container removal']);
    expect(await finalize()).toEqual(['S3 cleanup', 'container removal']);
    expect(ran).toEqual(['s3', 'container', 'tmp']);
    expect(log).toEqual(['S3 cleanup failed: Error: network down', 'container removal failed: Error: docker gone']);
  });

  it('SIGINT and SIGTERM run the same finalizer once, then exit non-zero', async () => {
    const handlers = new Map<string, () => void>();
    const target = { once: (signal: 'SIGINT' | 'SIGTERM', h: () => void) => handlers.set(signal, h) };
    let runs = 0;
    const finalize = onceFinalizer([{ name: 'cleanup', run: () => { runs += 1; } }], () => {});
    const exits: number[] = [];
    onSignals(finalize, (code) => exits.push(code), () => {}, target);
    handlers.get('SIGINT')!();
    handlers.get('SIGTERM')!();
    await finalize();
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(1);
    expect(exits).toEqual([130, 143]);
  });
});

describe('describeError', () => {
  it('prints the script\'s own errors by their message', () => {
    expect(describeError(new ScriptError(`${CONTAINER} did not accept connections within 60 s; the container was removed`)))
      .toBe(`${CONTAINER} did not accept connections within 60 s; the container was removed`);
    expect(describeError(new Mismatch('upload: file 1 read back different bytes'))).toBe('upload: file 1 read back different bytes');
    expect(describeError(new GuardViolation('a key that is not in the plan: k'))).toContain('a key that is not in the plan');
    expect(describeError(new ScriptError('the axios instance already has request interceptors; refusing to run')))
      .toContain('already has request interceptors');
  });

  it('prints an S3 error as op, status and code only', () => {
    expect(JSON.parse(describeError(new S3RequestError('PutObject', 403, 'AccessDenied'))))
      .toEqual({ op: 'PutObject', status: 403, code: 'AccessDenied' });
  });

  it('reduces any other error to its summary, never its message', () => {
    const out = describeError(new TypeError('connect to https://secret-bucket.s3.amazonaws.com failed'));
    expect(out).not.toContain('secret-bucket');
    expect(JSON.parse(out)).toEqual({ reason: 'error', name: 'TypeError' });
  });
});
