import * as path from 'path';
import { PassThrough, Writable } from 'stream';

/* eslint-disable @typescript-eslint/no-var-requires */
const inquirer = require(path.resolve(__dirname, '../../../npm-dist/sail-proxy/node_modules/inquirer'));
const { BACK, PromptSession, WRITE } = require('../../../docker/setup-flow/session');
const { withBackChoice, createPromptFn, registerBackPrompts } = require('../../../docker/setup-flow/prompts');
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * A prompt module on PassThrough streams. terminal: false keeps readline from decoding the
 * written bytes into keypress events, so the test decides exactly which keypress events exist.
 */
function harness() {
  const input = new PassThrough();
  let written = '';
  // inquirer ends its output when a prompt closes; like process.stdout, this one stays open
  // so several prompts in a row can be captured.
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    }
  });
  output.end = (() => output) as any;
  const promptModule = inquirer.createPromptModule({ input, output, terminal: false });
  const promptFn = createPromptFn(inquirer, promptModule);
  const key = (name: string) => input.emit('keypress', undefined, { name });
  const line = (text: string) => input.write(`${text}\n`);
  return { input, promptFn, key, line, output: () => written };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('setup-flow prompts', () => {
  test('up arrow is read from the keypress key name only', async () => {
    const h = harness();
    const before = h.input.listenerCount('keypress');
    const back = h.promptFn({ type: 'input', name: 'host', message: 'Host' });
    await tick();
    h.key('up');
    await expect(back).resolves.toBe(BACK);
    expect(h.input.listenerCount('keypress')).toBe(before);

    const h2 = harness();
    const text = h2.promptFn({ type: 'input', name: 'host', message: 'Host' });
    await tick();
    h2.input.write('\x1b[A\n');
    await expect(text).resolves.toBe('\x1b[A');
  });

  test('up arrow goes back from password and number questions too', async () => {
    for (const type of ['password', 'number']) {
      const h = harness();
      const answer = h.promptFn({ type, name: 'v', message: 'Value' });
      await tick();
      h.key('up');
      await expect(answer).resolves.toBe(BACK);
    }
  });

  test('the first question and noBack questions ignore the up arrow', async () => {
    const h = harness();
    const first = h.promptFn({ type: 'input', name: 'host', message: 'Host', noBack: true });
    await tick();
    h.key('up');
    h.line('example.org');
    await expect(first).resolves.toBe('example.org');

    const h2 = harness();
    const promptModule = inquirer.createPromptModule({ input: h2.input, output: new PassThrough(), terminal: false });
    registerBackPrompts(inquirer, promptModule);
    const optedOut = promptModule([{ type: 'back-input', name: 'v', message: 'Value', noBack: true }]);
    await tick();
    h2.key('up');
    h2.line('kept');
    await expect(optedOut).resolves.toEqual({ v: 'kept' });
  });

  test('a password default is never rendered, with or without back', async () => {
    const secret = 'S3cr3t-Value';
    for (const noBack of [true, false]) {
      const h = harness();
      const answer = h.promptFn({ type: 'password', name: 'p', message: 'Password', default: secret, noBack });
      await tick();
      h.line('');
      await expect(answer).resolves.toBe(secret);
      expect(h.output()).toContain('Password');
      expect(h.output()).not.toContain(secret);
    }
  });

  test('a secret kept through the session is never written to the terminal', async () => {
    const secret = 'S3cr3t-Value';
    const h = harness();
    const session = new PromptSession({ inquirer: {}, promptFn: h.promptFn, current: { host: 'example.org', token: secret } });
    const run = session.run((s: any) =>
      s.ask([
        { type: 'input', name: 'host', message: 'Host' },
        { type: 'input', name: 'token', message: 'Token', secret: true }
      ])
    );
    for (let i = 0; i < 3; i++) {
      await tick();
      h.line(''); // Enter on host, token and Write configuration
    }
    await expect(run).resolves.toEqual({ host: 'example.org', token: secret });
    expect(h.output()).toContain('Token (set — Enter keeps it)');
    expect(h.output()).toContain('Token: set');
    expect(h.output()).not.toContain(secret);
    expect(session.history.map((e: any) => e.display)).toEqual(['example.org', 'set']);
    expect(WRITE).toBe('__write__');
  });

  test('a numeric list default selects the choice with that value', async () => {
    const q = withBackChoice(
      { type: 'list', name: 'n', message: 'N', choices: [{ name: 'one', value: 1 }, { name: 'zero', value: 0 }], default: 0 },
      false
    );
    expect(q.default).toBe(1);
    const h = harness();
    const answer = h.promptFn({
      type: 'list',
      name: 'n',
      message: 'N',
      choices: [{ name: 'one', value: 1 }, { name: 'zero', value: 0 }],
      default: 0
    });
    await tick();
    h.line('');
    await expect(answer).resolves.toBe(0);
  });

  test('a list whose choices are a function still gets the back choice', async () => {
    const h = harness();
    const answer = h.promptFn({ type: 'list', name: 'm', message: 'M', choices: () => ['a', 'b'] });
    await tick();
    h.key('up');
    h.line('');
    await expect(answer).resolves.toBe(BACK);
  });

  test('typed text then enter resolves the text', async () => {
    const h = harness();
    const answer = h.promptFn({ type: 'input', name: 'host', message: 'Host', default: 'localhost' });
    await tick();
    h.line('example.org');
    await expect(answer).resolves.toBe('example.org');

    const h2 = harness();
    const def = h2.promptFn({ type: 'input', name: 'host', message: 'Host', default: 'localhost' });
    await tick();
    h2.line('');
    await expect(def).resolves.toBe('localhost');
  });

  test('confirm as list returns true/false/BACK', async () => {
    const q = withBackChoice({ type: 'confirm', name: 'ok', message: 'Continue?' }, false);
    expect(q.type).toBe('list');
    expect(q.choices.map((c: any) => c.name)).toEqual(['Yes', 'No', '← Back']);
    expect(withBackChoice({ type: 'confirm', name: 'ok', message: 'Continue?' }, true).choices).toHaveLength(2);

    const results = [];
    for (const downs of [0, 1, 2]) {
      const h = harness();
      const answer = h.promptFn({ type: 'confirm', name: 'ok', message: 'Continue?' });
      await tick();
      for (let i = 0; i < downs; i++) h.key('down');
      h.line('');
      results.push(await answer);
    }
    expect(results).toEqual([true, false, BACK]);

    const h = harness();
    const no = h.promptFn({ type: 'confirm', name: 'ok', message: 'Continue?', default: false });
    await tick();
    h.line('');
    await expect(no).resolves.toBe(false);
  });

  test('list back choice absent on the first question', async () => {
    const question = { type: 'list', name: 'mode', message: 'Mode', choices: ['local', 'registry'] };
    expect(withBackChoice(question, true).choices).toEqual(['local', 'registry']);
    expect(withBackChoice(question, false).choices).toEqual(['local', 'registry', { name: '← Back', value: BACK }]);

    const h = harness();
    const answer = h.promptFn(question);
    await tick();
    h.key('down');
    h.key('down');
    h.line('');
    await expect(answer).resolves.toBe(BACK);
  });

  test('a list filter and validate never see the BACK choice', async () => {
    const filter = jest.fn((v: string) => v.toUpperCase());
    const validate = jest.fn(() => true);
    const h = harness();
    const answer = h.promptFn({ type: 'list', name: 'mode', message: 'Mode', choices: ['a', 'b'], filter, validate });
    await tick();
    h.key('up'); // lists loop: up from the first choice selects ← Back
    h.line('');
    await expect(answer).resolves.toBe(BACK);
    expect(filter).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  test('editor step offers Keep current only with a value', async () => {
    const names = (q: any) => q.choices.map((c: any) => c.name);
    expect(names(withBackChoice({ type: 'editor', name: 'key', message: 'Key' }, false))).toEqual([
      'Open editor',
      '← Back'
    ]);
    const withValue = withBackChoice({ type: 'editor', name: 'key', message: 'Key', default: '{"a":1}' }, false);
    expect(names(withValue)).toEqual(['Open editor', 'Keep current', '← Back']);
    expect(withValue.type).toBe('list');
    expect(names(withBackChoice({ type: 'editor', name: 'key', message: 'Key', default: 'x' }, true))).toEqual([
      'Open editor',
      'Keep current'
    ]);

    const h = harness();
    const kept = h.promptFn({ type: 'editor', name: 'key', message: 'Key', default: '{"a":1}' });
    await tick();
    h.line(''); // default selection is Keep current
    await expect(kept).resolves.toBe('{"a":1}');
  });
});
