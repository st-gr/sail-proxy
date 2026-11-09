import { scripted, Step } from './helpers/scriptedPrompter';

/* eslint-disable @typescript-eslint/no-var-requires */
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');
const { KEY_WARNINGS, askSecret, askKeyRegeneration, mask, keysForProviderChange } = require('../../../docker/setup-flow/secrets');
/* eslint-enable @typescript-eslint/no-var-requires */

const CURRENT = 'current-S3cret-value';
const TYPED = 'typed-S3cret-value';

async function run(steps: Step[], collect: (session: any) => Promise<any>) {
  const script = scripted(steps);
  const session = new PromptSession({ inquirer: {}, promptFn: script.promptFn });
  const result = await session.run(collect);
  script.assertDone();
  return { result, session, script };
}

const secretStep = (options: Record<string, any> = {}) => (session: any) =>
  askSecret(session, { name: 'DB_PASSWORD', message: 'Database password:', current: CURRENT, generate: () => 'generated-value', ...options });

function reviewText(script: any): string {
  const review = script.shown.find((q: any) => q.id === REVIEW);
  return JSON.stringify(review.question.choices.map((c: any) => c.name));
}

describe('askSecret', () => {
  test('enter keeps the current secret', async () => {
    const { result, script } = await run([['DB_PASSWORD', 'keep'], [REVIEW, 'WRITE']], secretStep());
    expect(result).toEqual({ value: CURRENT, origin: 'kept' });
    expect(reviewText(script)).toContain('Database password: set');
    expect(JSON.stringify(script.shown.map((q: any) => q.question.message))).not.toContain(CURRENT);
    expect(script.shown[0].default).toBe('keep');
  });

  test('enter new replaces it', async () => {
    const { result, script } = await run(
      [['DB_PASSWORD', 'new'], ['DB_PASSWORD:new', TYPED], [REVIEW, 'WRITE']],
      secretStep()
    );
    expect(result).toEqual({ value: TYPED, origin: 'new' });
    expect(reviewText(script)).toContain('Database password: new (changed)');
    expect(reviewText(script)).not.toContain(TYPED);
  });

  test('generate new calls generate', async () => {
    const generate = jest.fn(() => 'generated-value');
    const { result, script } = await run([['DB_PASSWORD', 'generate'], [REVIEW, 'WRITE']], secretStep({ generate }));
    expect(result).toEqual({ value: 'generated-value', origin: 'generated' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(reviewText(script)).toContain('Database password: generated (changed)');
  });

  test('generate is offered only when a generator exists', async () => {
    const { script } = await run([['DB_PASSWORD', 'keep'], [REVIEW, 'WRITE']], secretStep({ generate: undefined }));
    expect(script.shown[0].question.choices.map((c: any) => c.value)).toEqual(['keep', 'new']);
  });

  test('a generated value stays the same when the step is replayed', async () => {
    const generate = jest.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
    const { result } = await run(
      [['DB_PASSWORD', 'generate'], [REVIEW, { jump: 'DB_PASSWORD' }], ['DB_PASSWORD', 'generate'], [REVIEW, 'WRITE']],
      secretStep({ generate })
    );
    expect(result.value).toBe('first');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('Enter new then Back re-asks the keep/new/generate list and remembers the choice and the typed value', async () => {
    const { result, script } = await run(
      [
        ['DB_PASSWORD', 'new'],
        ['DB_PASSWORD:new', TYPED],
        [REVIEW, { jump: 'DB_PASSWORD' }],
        ['DB_PASSWORD', 'new'],
        ['DB_PASSWORD:new', ''],
        [REVIEW, 'WRITE']
      ],
      secretStep()
    );
    expect(result).toEqual({ value: TYPED, origin: 'new' });
    const lists = script.shown.filter((q: any) => q.id === 'DB_PASSWORD');
    expect(lists.map((q: any) => q.default)).toEqual(['keep', 'new']);
    const typed = script.shown.filter((q: any) => q.id === 'DB_PASSWORD:new');
    expect(typed[1].default).toBeUndefined();
    expect(typed[1].question.message).toContain('Enter keeps it');
    expect(JSON.stringify(script.shown.map((q: any) => [q.question.message, q.default]))).not.toContain(TYPED);
  });

  test('Back from the new-value question returns to the keep/new/generate list', async () => {
    const { result, script } = await run(
      [
        ['DB_PASSWORD', 'new'],
        ['DB_PASSWORD:new', 'BACK'],
        ['DB_PASSWORD', 'keep'],
        [REVIEW, 'WRITE']
      ],
      secretStep()
    );
    expect(result).toEqual({ value: CURRENT, origin: 'kept' });
    expect(script.shown.filter((q: any) => q.id === 'DB_PASSWORD').map((q: any) => q.default)).toEqual(['keep', 'new']);
  });

  test('askSecret passes validate to the new-value question', async () => {
    const validate = (v: string) => v.length >= 8 || 'Too short';
    const { result, script } = await run(
      [['DB_PASSWORD', 'new'], ['DB_PASSWORD:new', 'short'], ['DB_PASSWORD:new', TYPED], [REVIEW, 'WRITE']],
      secretStep({ validate })
    );
    expect(result.value).toBe(TYPED);
    expect(script.shown.filter((q: any) => q.id === 'DB_PASSWORD:new')[0].rejected).toEqual(['short']);
  });

  test('Enter new rejects an empty value by default', async () => {
    const { result, script } = await run(
      [['DB_PASSWORD', 'new'], ['DB_PASSWORD:new', ''], ['DB_PASSWORD:new', TYPED], [REVIEW, 'WRITE']],
      secretStep()
    );
    expect(result.value).toBe(TYPED);
    expect(script.shown.filter((q: any) => q.id === 'DB_PASSWORD:new')[0].rejected).toEqual(['']);
  });

  test('no current value asks the password as today', async () => {
    const { result, script } = await run(
      [['DB_PASSWORD', TYPED], [REVIEW, 'WRITE']],
      secretStep({ current: undefined })
    );
    expect(result).toEqual({ value: TYPED, origin: 'new' });
    expect(script.shown[0].question.type).toBe('password');
    expect(reviewText(script)).toContain('Database password: new');
  });
});

describe('askKeyRegeneration', () => {
  const keys = ['SIEM_CREDENTIAL_KEY', 'VALIDATION_TOKEN_SECRET'];
  const step = (session: any) => askKeyRegeneration(session, keys);

  test('keeping all generated keys returns none', async () => {
    const { result, script } = await run([['key-regeneration', 'keep'], [REVIEW, 'WRITE']], step);
    expect(result).toEqual([]);
    expect(reviewText(script)).toContain('Regenerated keys: none');
  });

  test('regenerating a key needs the warning confirmed', async () => {
    const declined = await run(
      [
        ['key-regeneration', 'regenerate'],
        ['regenerate-key', 'SIEM_CREDENTIAL_KEY'],
        ['regenerate-confirm', false],
        ['regenerate-key', '__done__'],
        [REVIEW, 'WRITE']
      ],
      step
    );
    expect(declined.result).toEqual([]);
    const confirmQuestion = declined.script.shown.find((q: any) => q.id === 'regenerate-confirm')!;
    expect(confirmQuestion.default).toBe(false);
    expect(confirmQuestion.question.message).toContain(KEY_WARNINGS.SIEM_CREDENTIAL_KEY);

    const accepted = await run(
      [
        ['key-regeneration', 'regenerate'],
        ['regenerate-key', 'SIEM_CREDENTIAL_KEY'],
        ['regenerate-confirm', true],
        ['regenerate-key', 'VALIDATION_TOKEN_SECRET'],
        ['regenerate-confirm', true],
        ['regenerate-key', '__done__'],
        [REVIEW, 'WRITE']
      ],
      step
    );
    expect(accepted.result).toEqual(['SIEM_CREDENTIAL_KEY', 'VALIDATION_TOKEN_SECRET']);
    expect(reviewText(accepted.script)).toContain('Regenerated keys: SIEM_CREDENTIAL_KEY, VALIDATION_TOKEN_SECRET (changed)');
  });
});

describe('KEY_WARNINGS and mask', () => {
  const expected = [
    'AWS_SECRET_ENCRYPTION_KEY',
    'SIEM_CREDENTIAL_KEY',
    'CONNECTION_CREDENTIAL_KEY',
    'VALIDATION_TOKEN_SECRET',
    'METADATA_ENCRYPTION_KEY',
    'POSTGRES_PASSWORD',
    'FILE_SEARCH_RUNTIME_PASSWORD',
    'OAUTH2_PROXY_COOKIE_SECRET',
    'OAUTH2_PROXY_CLIENT_SECRET'
  ];

  test('every warned key has a non-empty warning naming what breaks', () => {
    expect(Object.keys(KEY_WARNINGS).sort()).toEqual([...expected].sort());
    for (const key of expected) {
      expect(typeof KEY_WARNINGS[key]).toBe('string');
      expect(KEY_WARNINGS[key].length).toBeGreaterThan(30);
    }
  });

  test('mask never returns the value', () => {
    expect(mask(CURRENT)).toBe('********');
    expect(mask('')).toBe('(not set)');
    expect(mask(undefined)).toBe('(not set)');
    expect(mask(CURRENT)).not.toContain(CURRENT);
  });
});

describe('keysForProviderChange', () => {
  const COOKIE = 'OAUTH2_PROXY_COOKIE_SECRET';

  test('a provider change regenerates the carried cookie key, so sessions of the old provider end', () => {
    expect(keysForProviderChange([], { previous: 'github', provider: 'okta', carried: [COOKIE] })).toEqual([COOKIE]);
    expect(keysForProviderChange(['AWS_SECRET_ENCRYPTION_KEY'], { previous: 'okta', provider: 'ldap', carried: [COOKIE] }))
      .toEqual(['AWS_SECRET_ENCRYPTION_KEY', COOKIE]);
  });

  test('the same provider keeps the cookie key', () => {
    expect(keysForProviderChange([], { previous: 'okta', provider: 'okta', carried: [COOKIE] })).toEqual([]);
  });

  test('no previous provider or no carried cookie key changes nothing', () => {
    expect(keysForProviderChange([], { previous: undefined, provider: 'okta', carried: [COOKIE] })).toEqual([]);
    expect(keysForProviderChange([], { previous: 'github', provider: 'okta', carried: [] })).toEqual([]);
  });

  test('a cookie key already picked for regeneration is listed once', () => {
    expect(keysForProviderChange([COOKIE], { previous: 'github', provider: 'okta', carried: [COOKIE] })).toEqual([COOKIE]);
  });
});
