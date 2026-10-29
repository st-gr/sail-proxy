import { scripted, Step } from './helpers/scriptedPrompter';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PromptSession, BACK, WRITE, REVIEW, displayValue } = require('../../../docker/setup-flow/session');

const SECRET = 'S3cr3t-Value';

// a: input; b: list, asked only when a !== 'skip'; c: password.
async function collect(session: any): Promise<Record<string, any>> {
  const first = await session.ask([
    { type: 'input', name: 'a', message: 'Value a', default: 'a0' },
    {
      type: 'list',
      name: 'b',
      message: 'Pick b',
      choices: ['x', 'y', 'z'],
      when: (answers: any) => answers.a !== 'skip'
    }
  ]);
  const second = await session.ask({ type: 'password', name: 'c', message: 'Secret c', secret: true });
  return { ...first, ...second };
}

function shownDefaults(shown: Array<{ id: string; default: any }>, id: string): any[] {
  return shown.filter((q) => q.id === id).map((q) => q.default);
}

async function runScript(steps: Step[], options: Record<string, any> = {}, fn: (session: any) => Promise<any> = collect) {
  const script = scripted(steps);
  const session = new PromptSession({ inquirer: {}, promptFn: script.promptFn, ...options });
  const result = await session.run(fn);
  script.assertDone();
  return { result, session, shown: script.shown };
}

describe('PromptSession', () => {
  test('exports the BACK symbol and the WRITE choice value', () => {
    expect(BACK).toBe(Symbol.for('sail.setup.back'));
    expect(WRITE).toBe('__write__');
  });

  test('back re-asks the previous question with its answer as default', async () => {
    const { result, shown } = await runScript([
      ['a', '1'],
      ['b', 'x'],
      ['c', 'BACK'],
      ['b', 'y'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: '1', b: 'y', c: SECRET });
    expect(shownDefaults(shown, 'b')).toEqual([undefined, 'x']);
    // a is answered silently on the replay.
    expect(shown.filter((q) => q.id === 'a')).toHaveLength(1);
  });

  test('back twice reaches the first question; the first question offers no back', async () => {
    const { result, shown } = await runScript([
      ['a', '1'],
      ['b', 'x'],
      ['c', 'BACK'],
      ['b', 'BACK'],
      ['a', '1'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: '1', b: 'x', c: SECRET });
    expect(shownDefaults(shown, 'a')).toEqual(['a0', '1']);
    expect(shownDefaults(shown, 'b')).toEqual([undefined, 'x', 'x']);
    for (const q of shown) expect(q.question.noBack).toBe(q.id === 'a' ? true : undefined);
  });

  test('back on the first question asks it again', async () => {
    const { result, shown } = await runScript([
      ['a', 'BACK'],
      ['a', '1'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: '1', b: 'x', c: SECRET });
    expect(shownDefaults(shown, 'a')).toEqual(['a0', 'a0']);
  });

  test('jump from the review screen re-asks from that question forward with defaults', async () => {
    const { result, shown, session } = await runScript([
      ['a', '1'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, { jump: 'a' }],
      ['a', '2'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: '2', b: 'x', c: SECRET });
    expect(shownDefaults(shown, 'a')).toEqual(['a0', '1']);
    expect(shownDefaults(shown, 'b')).toEqual([undefined, 'x']);
    // A secret's remembered value is never handed to the prompt; a hint says Enter keeps it.
    expect(shownDefaults(shown, 'c')).toEqual([undefined, undefined]);
    expect(shown.filter((q) => q.id === 'c').map((q) => q.question.message)).toEqual([
      'Secret c',
      'Secret c (set — Enter keeps it)'
    ]);
    expect(session.history.map((h: any) => h.id)).toEqual(['a', 'b', 'c']);
  });

  test('jump to a later question answers the earlier ones silently', async () => {
    const { result, shown } = await runScript([
      ['a', '1'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, { jump: 'b' }],
      ['b', 'z'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: '1', b: 'z', c: SECRET });
    expect(shown.filter((q) => q.id === 'a')).toHaveLength(1);
  });

  test('the review screen lists Write configuration first and as default, then the answers', async () => {
    const { shown } = await runScript(
      [
        ['a', '1'],
        ['b', 'y'],
        ['c', SECRET],
        [REVIEW, 'WRITE']
      ],
      { current: { b: 'x' } }
    );
    const review = shown.find((q) => q.id === REVIEW)!.question;
    expect(review.type).toBe('list');
    expect(review.choices[0]).toEqual({ name: '✔ Write configuration', value: WRITE });
    expect(review.default).toBe(WRITE);
    const answers = review.choices.filter((c: any) => c.type !== 'separator').slice(1);
    expect(answers.map((c: any) => c.value)).toEqual(['a', 'b', 'c']);
    expect(answers[1].name).toBe('Pick b: y (changed)');
  });

  // The answers used to look like more of the same list as Write configuration, and the list
  // wrapped around, so after scrolling Write configuration sat between "← Back" and the first answer.
  test('the review screen sets Write configuration apart and does not wrap', async () => {
    const { shown } = await runScript([
      ['a', '1'],
      ['b', 'y'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    const review = shown.find((q) => q.id === REVIEW)!.question;
    expect(review.loop).toBe(false);
    expect(review.choices.map((c: any) => (c.type === 'separator' ? '---' : c.value))).toEqual([WRITE, '---', 'a', 'b', 'c', '---']);
    expect(review.choices[1].line).toMatch(/change an answer/);
  });

  test('current values are the first defaults and changes are marked against them', async () => {
    const { session, shown } = await runScript(
      [
        ['a', '1'],
        ['b', 'y'],
        ['c', SECRET],
        [REVIEW, 'WRITE']
      ],
      { current: { a: '1', b: 'x', c: SECRET } }
    );
    expect(shownDefaults(shown, 'a')).toEqual(['1']);
    expect(shownDefaults(shown, 'b')).toEqual(['x']);
    expect(session.history).toEqual([
      { id: 'a', label: 'Value a', value: '1', display: '1', secret: false, changed: false },
      { id: 'b', label: 'Pick b', value: 'y', display: 'y', secret: false, changed: true },
      { id: 'c', label: 'Secret c', value: SECRET, display: 'set', secret: true, changed: false }
    ]);
  });

  test('answers of skipped questions are not returned but are remembered', async () => {
    const { result, shown, session } = await runScript([
      ['a', '1'],
      ['b', 'y'],
      ['c', SECRET],
      [REVIEW, { jump: 'a' }],
      ['a', 'skip'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ a: 'skip', c: SECRET });
    expect(session.history.map((h: any) => h.id)).toEqual(['a', 'c']);
    const lastReview = shown.filter((q) => q.id === REVIEW).pop()!.question;
    expect(lastReview.choices.filter((c: any) => c.type !== 'separator').map((c: any) => c.value)).toEqual([WRITE, 'a', 'c']);

    // ... and back again: b comes back with its old answer as default.
    const again = await runScript([
      ['a', '1'],
      ['b', 'y'],
      ['c', SECRET],
      [REVIEW, { jump: 'a' }],
      ['a', 'skip'],
      ['c', 'BACK'],
      ['a', '1'],
      ['b', 'y'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    expect(shownDefaults(again.shown, 'b')).toEqual([undefined, 'y']);
    expect(again.result).toEqual({ a: '1', b: 'y', c: SECRET });
  });

  test('once runs its function once across replays', async () => {
    let calls = 0;
    const probe = jest.fn(async () => ++calls);
    const withProbe = async (session: any) => {
      const answers = await collect(session);
      const probed = await session.once('probe', probe);
      return { ...answers, probed };
    };
    const { result } = await runScript(
      [
        ['a', '1'],
        ['b', 'x'],
        ['c', 'BACK'],
        ['b', 'y'],
        ['c', SECRET],
        [REVIEW, { jump: 'a' }],
        ['a', '1'],
        ['b', 'y'],
        ['c', SECRET],
        [REVIEW, 'WRITE']
      ],
      {},
      withProbe
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.probed).toBe(1);
  });

  test('review display never contains a secret value', async () => {
    const { session, shown } = await runScript([
      ['a', '1'],
      ['b', 'x'],
      ['c', SECRET],
      [REVIEW, 'WRITE']
    ]);
    const c = session.history.find((h: any) => h.id === 'c');
    expect(c.display).toBe('new');
    const review = shown.find((q) => q.id === REVIEW)!.question;
    expect(JSON.stringify(review.choices)).not.toContain(SECRET);
    expect(JSON.stringify(review.message)).not.toContain(SECRET);
  });

  test('enter on a secret keeps its value without showing it to the prompt', async () => {
    const required = async (session: any) =>
      session.ask({
        type: 'input',
        name: 'token',
        message: 'Token',
        secret: true,
        validate: (v: string) => (v ? true : 'Required'),
        filter: (v: string) => v.trim()
      });
    const { result, session, shown } = await runScript(
      [
        ['token', ''],
        [REVIEW, 'WRITE']
      ],
      { current: { token: SECRET } }
    , required);
    expect(result).toEqual({ token: SECRET });
    expect(shown[0].default).toBeUndefined();
    expect(JSON.stringify(shown[0].question)).not.toContain(SECRET);
    expect(session.history[0]).toMatchObject({ display: 'set', changed: false });
  });

  test('a value failing validate never enters history', async () => {
    const validated = async (session: any) =>
      session.ask({
        type: 'input',
        name: 'port',
        message: 'Port',
        validate: (v: string) => (/^\d+$/.test(v) ? true : 'Enter a number')
      });
    const { result, session, shown } = await runScript(
      [
        ['port', 'abc'],
        ['port', '8080'],
        [REVIEW, 'WRITE']
      ],
      {},
      validated
    );
    expect(shown[0].rejected).toEqual(['abc']);
    expect(result).toEqual({ port: '8080' });
    expect(session.history.map((h: any) => h.value)).toEqual(['8080']);
  });

  test('repeated names in one run get distinct ids', async () => {
    const twice = async (session: any) => {
      const one = await session.ask({ type: 'input', name: 'x', message: 'First x' });
      const two = await session.ask({ type: 'input', name: 'x', message: 'Second x' });
      return [one.x, two.x];
    };
    const { result, session, shown } = await runScript(
      [
        ['x', '1'],
        ['x#2', 'BACK'],
        ['x', '1'],
        ['x#2', '2'],
        [REVIEW, { jump: 'x#2' }],
        ['x#2', '3'],
        [REVIEW, 'WRITE']
      ],
      {},
      twice
    );
    expect(result).toEqual(['1', '3']);
    expect(session.history.map((h: any) => h.id)).toEqual(['x', 'x#2']);
    expect(shownDefaults(shown, 'x#2')).toEqual([undefined, undefined, '2']);
  });

  test('errors other than back propagate unchanged', async () => {
    const abort = new Error('User force closed the prompt');
    const script = scripted([
      ['a', '1'],
      ['b', 'x'],
      ['c', 'BACK']
    ]);
    const promptFn = async (q: any) => {
      if (q.id === 'b' && script.shown.some((s) => s.id === 'c')) throw abort;
      return script.promptFn(q);
    };
    const session = new PromptSession({ inquirer: {}, promptFn });
    await expect(session.run(collect)).rejects.toBe(abort);
  });

  test('forget drops only the named answers: they are asked again from their own default', async () => {
    const forgetful = async (session: any) => {
      const { scope } = await session.ask({ type: 'input', name: 'scope', message: 'Scope' });
      if (scope === 'other') session.forget(['a']);
      const { a } = await session.ask({ type: 'input', name: 'a', message: 'Value a', default: 'a-default' });
      const { b } = await session.ask({ type: 'input', name: 'b', message: 'Value b', default: 'b-default' });
      return { scope, a, b };
    };
    const { result, shown } = await runScript(
      [
        ['scope', 'first'],
        ['a', 'a-typed'],
        ['b', 'b-typed'],
        [REVIEW, { jump: 'scope' }],
        ['scope', 'other'],
        ['a', 'a-again'],
        ['b', 'b-typed'],
        [REVIEW, 'WRITE']
      ],
      {},
      forgetful
    );
    expect(result).toEqual({ scope: 'other', a: 'a-again', b: 'b-typed' });
    expect(shownDefaults(shown, 'a')).toEqual(['a-default', 'a-default']);
    expect(shownDefaults(shown, 'b')).toEqual(['b-default', 'b-typed']);
  });

  test('resetExcept forgets the other answers: their current values are offered and marked against', async () => {
    // Like setup-kyma's namespace: the first answer selects which current values apply.
    const currents: Record<string, Record<string, any>> = { A: { a: 'a-of-A' }, B: { a: 'a-of-B' } };
    let builtFor: string | undefined;
    const scoped = async (session: any) => {
      const { ns } = await session.ask({ type: 'input', name: 'ns', message: 'Scope' });
      if (builtFor !== undefined && builtFor !== ns) session.resetExcept(['ns']);
      builtFor = ns;
      session.current = currents[ns];
      if (!session.generated.has('g')) session.generated.set('g', `generated-for-${ns}`);
      const { a } = await session.ask({ type: 'input', name: 'a', message: 'Value a' });
      return { ns, a, g: session.generated.get('g') };
    };
    const { result, session, shown } = await runScript(
      [
        ['ns', 'A'],
        ['a', 'a-of-A'],
        [REVIEW, { jump: 'ns' }],
        ['ns', 'B'],
        ['a', 'a-of-B'],
        [REVIEW, 'WRITE']
      ],
      {},
      scoped
    );
    expect(result).toEqual({ ns: 'B', a: 'a-of-B', g: 'generated-for-B' });
    // B's current value is the default after the switch, not the answer remembered for A.
    expect(shownDefaults(shown, 'a')).toEqual(['a-of-A', 'a-of-B']);
    // The namespace switch is a change, the unchanged value of B is not.
    expect(session.history.map((h: any) => [h.id, h.changed])).toEqual([
      ['ns', true],
      ['a', false]
    ]);
  });

  test('a run that asks nothing shows no review screen', async () => {
    const { result, shown } = await runScript([], {}, async () => 'nothing asked');
    expect(result).toBe('nothing asked');
    expect(shown).toHaveLength(0);
  });

  test('displayValue shows editor values as a line count and secrets by origin', () => {
    expect(displayValue({ type: 'editor', name: 'k' }, 'l1\nl2\nl3', {})).toBe('(3 lines)');
    expect(displayValue({ type: 'password', name: 'p' }, 'v', { p: 'v' })).toBe('set');
    expect(displayValue({ type: 'input', name: 'p', secret: true }, 'w', { p: 'v' })).toBe('new');
    expect(displayValue({ type: 'input', name: 'p', secret: true }, 'w', {}, 'generated')).toBe('generated');
    expect(displayValue({ type: 'confirm', name: 'q' }, true, {})).toBe('Yes');
  });
});
