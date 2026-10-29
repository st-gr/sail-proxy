/**
 * The guard of the Connections custom actions: a second press while an action (or its dialog) is in
 * progress does nothing, and a failure before the dialog is open never leaves the action dead.
 */
import { guarded } from '../webapp/ext/model/actionGuard';

describe('guarded', () => {
  it('ignores a second press while the first is running', async () => {
    const busy = new Set<string>();
    let release!: () => void;
    let runs = 0;
    const start = () => { runs++; return new Promise<boolean>((resolve) => { release = () => resolve(false); }); };
    const first = guarded(busy, 'test', start);
    await guarded(busy, 'test', start);
    expect(runs).toBe(1);
    release();
    await first;
    expect(busy.has('test')).toBe(false);
    await guarded(busy, 'test', async () => { runs++; return false; });
    expect(runs).toBe(2);
  });

  it('releases the action when starting it fails, and passes the error on', async () => {
    const busy = new Set<string>();
    await expect(guarded(busy, 'credential', async () => { throw new Error('bundle failed'); })).rejects.toThrow('bundle failed');
    expect(busy.has('credential')).toBe(false);
  });

  it('keeps the action taken while its dialog is open (start answers true)', async () => {
    const busy = new Set<string>();
    await guarded(busy, 'addModel', async () => true);
    expect(busy.has('addModel')).toBe(true);
    let runs = 0;
    await guarded(busy, 'addModel', async () => { runs++; return true; });
    expect(runs).toBe(0);
    busy.delete('addModel'); // the dialog's afterClose
    await guarded(busy, 'addModel', async () => { runs++; return false; });
    expect(runs).toBe(1);
  });

  it('guards each action on its own', async () => {
    const busy = new Set<string>(['credential']);
    let runs = 0;
    await guarded(busy, 'test', async () => { runs++; return false; });
    expect(runs).toBe(1);
  });
});
