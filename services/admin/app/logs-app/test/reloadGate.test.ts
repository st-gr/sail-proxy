import { createReloadGate, runReload } from '../webapp/model/reloadGate';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('runReload', () => {
  it('a reload in flight when Live is switched off still shows its rows and ends not busy (Live off does not touch the gate)', async () => {
    const gate = createReloadGate();
    const busy: boolean[] = [];
    const shown: string[] = [];
    const answer = deferred<string>();
    const running = runReload(gate, () => answer.promise, (rows) => { shown.push(rows); }, (b) => busy.push(b));
    // Live is switched off here: the controller only stops the poller.
    answer.resolve('rows of the first load');
    expect(await running).toBe(true);
    expect(shown).toEqual(['rows of the first load']);
    expect(busy).toEqual([true, false]);
  });

  it('a reload superseded by a newer one does not overwrite its rows, and the table ends not busy', async () => {
    const gate = createReloadGate();
    let busy = false;
    const shown: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    const a = runReload(gate, () => first.promise, (rows) => { shown.push(rows); }, (b) => { busy = b; });
    const b = runReload(gate, () => second.promise, (rows) => { shown.push(rows); }, (v) => { busy = v; });
    second.resolve('newer');
    expect(await b).toBe(true);
    expect(busy).toBe(false);
    first.resolve('older');
    expect(await a).toBe(false);
    expect(shown).toEqual(['newer']);
    expect(busy).toBe(false);
  });

  it('while the newer reload still runs, the older one ending leaves the busy flag to it', async () => {
    const gate = createReloadGate();
    let busy = false;
    const first = deferred<string>();
    const second = deferred<string>();
    const a = runReload(gate, () => first.promise, () => undefined, (v) => { busy = v; });
    const b = runReload(gate, () => second.promise, () => undefined, (v) => { busy = v; });
    first.resolve('older');
    await a;
    expect(busy).toBe(true);
    second.resolve('newer');
    await b;
    expect(busy).toBe(false);
  });

  it('a failing fetch ends not busy and applies nothing', async () => {
    const gate = createReloadGate();
    const busy: boolean[] = [];
    await expect(runReload(gate, () => Promise.reject(new Error('offline')), () => { throw new Error('applied'); }, (b) => busy.push(b))).rejects.toThrow('offline');
    expect(busy).toEqual([true, false]);
  });

  it('after invalidate (the app was left) nothing is applied and the flag is not touched', async () => {
    const gate = createReloadGate();
    const busy: boolean[] = [];
    const answer = deferred<string>();
    const running = runReload(gate, () => answer.promise, () => { throw new Error('applied'); }, (b) => busy.push(b));
    gate.invalidate();
    answer.resolve('late');
    expect(await running).toBe(false);
    expect(busy).toEqual([true]);
  });

  it('a poll knows whether a reload came after it', () => {
    const gate = createReloadGate();
    const token = gate.current();
    expect(gate.isLatest(token)).toBe(true);
    void runReload(gate, () => new Promise<string>(() => undefined), () => undefined, () => undefined);
    expect(gate.isLatest(token)).toBe(false);
  });
});
