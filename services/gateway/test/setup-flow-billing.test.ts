import { scripted, Step } from './helpers/scriptedPrompter';

/* eslint-disable @typescript-eslint/no-var-requires */
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');
const { askBilling, applyBillingToEnvText, billingFromEnv, billingToWrite, NOT_PRICED_HINT } = require('../../../docker/setup-flow/billing');
/* eslint-enable @typescript-eslint/no-var-requires */

async function run(steps: Step[], current: Record<string, string> = {}) {
  const script = scripted(steps);
  const session = new PromptSession({ inquirer: {}, promptFn: script.promptFn, current });
  const result = await session.run((s: any) => askBilling(s, current));
  script.assertDone();
  return { result, script };
}

describe('askBilling', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  test('USD asks no prices', async () => {
    const { result, script } = await run([['SAP_BILLING_CURRENCY', 'usd'], [REVIEW, 'WRITE']]);
    expect(result).toEqual({ SAP_BILLING_CURRENCY: 'USD' });
    expect(script.shown.map((q) => q.id)).toEqual(['SAP_BILLING_CURRENCY', REVIEW]);
    expect(script.shown[0].default).toBe('USD');
  });

  test('EUR with prices returns both', async () => {
    const { result } = await run([
      ['SAP_BILLING_CURRENCY', 'eur'],
      ['billingEnterPrices', true],
      ['SAP_CU_PRICE_PRODUCTIVE', '0.35'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.2'],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({
      SAP_BILLING_CURRENCY: 'EUR',
      SAP_CU_PRICE_PRODUCTIVE: '0.35',
      SAP_CU_PRICE_NON_PRODUCTIVE: '0.2'
    });
  });

  test('a price of 10000 or more is rejected with a message (the admin keeps prices below 10000)', async () => {
    const { result, script } = await run([
      ['SAP_BILLING_CURRENCY', 'eur'],
      ['billingEnterPrices', true],
      ['SAP_CU_PRICE_PRODUCTIVE', '10000'],
      ['SAP_CU_PRICE_PRODUCTIVE', '9999.999999'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '25000.5'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.2'],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({
      SAP_BILLING_CURRENCY: 'EUR',
      SAP_CU_PRICE_PRODUCTIVE: '9999.999999',
      SAP_CU_PRICE_NON_PRODUCTIVE: '0.2'
    });
    const productive = script.shown.find((q) => q.id === 'SAP_CU_PRICE_PRODUCTIVE')!;
    expect(productive.rejected).toEqual(['10000']);
    expect(productive.question.validate('10000')).toMatch(/less than 10000/);
    expect(script.shown.find((q) => q.id === 'SAP_CU_PRICE_NON_PRODUCTIVE')!.rejected).toEqual(['25000.5']);
  });

  test('a stored price of 10000 or more is not offered as the current value', () => {
    expect(billingFromEnv({ SAP_BILLING_CURRENCY: 'EUR', SAP_CU_PRICE_PRODUCTIVE: '10000', SAP_CU_PRICE_NON_PRODUCTIVE: '0.2' })).toEqual({
      SAP_BILLING_CURRENCY: 'EUR',
      SAP_CU_PRICE_NON_PRODUCTIVE: '0.2'
    });
  });

  test('EUR without prices prints the hint', async () => {
    const { result, script } = await run([
      ['SAP_BILLING_CURRENCY', 'EUR'],
      ['billingEnterPrices', false],
      [REVIEW, 'WRITE']
    ]);
    expect(result).toEqual({ SAP_BILLING_CURRENCY: 'EUR' });
    expect(log).toHaveBeenCalledWith(NOT_PRICED_HINT);
    expect(script.shown[1].default).toBe(false);
  });

  test('the not-priced hint prints once per run, also when the question is replayed', async () => {
    await run([
      ['SAP_BILLING_CURRENCY', 'EUR'],
      ['billingEnterPrices', false],
      [REVIEW, { jump: 'SAP_BILLING_CURRENCY' }],
      ['SAP_BILLING_CURRENCY', 'EUR'],
      ['billingEnterPrices', false],
      [REVIEW, 'WRITE']
    ]);
    expect(log.mock.calls.filter((c) => c[0] === NOT_PRICED_HINT)).toHaveLength(1);
  });

  test('rejects eur1 and 0 and -1', async () => {
    const { result, script } = await run([
      ['SAP_BILLING_CURRENCY', 'eur1'],
      ['SAP_BILLING_CURRENCY', 'EUR'],
      ['billingEnterPrices', true],
      ['SAP_CU_PRICE_PRODUCTIVE', '0'],
      ['SAP_CU_PRICE_PRODUCTIVE', '-1'],
      ['SAP_CU_PRICE_PRODUCTIVE', '1.1234567'],
      ['SAP_CU_PRICE_PRODUCTIVE', '1'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.5'],
      [REVIEW, 'WRITE']
    ]);
    expect(result.SAP_CU_PRICE_PRODUCTIVE).toBe('1');
    expect(script.shown[0].rejected).toEqual(['EUR1']);
    expect(script.shown[2].rejected).toEqual(['0', '-1', '1.1234567']);
  });

  test('current values are the defaults, and existing prices default the question to Yes', async () => {
    const current = { SAP_BILLING_CURRENCY: 'CHF', SAP_CU_PRICE_PRODUCTIVE: '0.4', SAP_CU_PRICE_NON_PRODUCTIVE: '0.3' };
    const { result, script } = await run(
      [
        ['SAP_BILLING_CURRENCY', 'CHF'],
        ['billingEnterPrices', true],
        ['SAP_CU_PRICE_PRODUCTIVE', '0.4'],
        ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.3'],
        [REVIEW, 'WRITE']
      ],
      current
    );
    expect(result).toEqual(current);
    expect(script.shown.map((q) => q.default).slice(0, 4)).toEqual(['CHF', true, '0.4', '0.3']);
  });
});

describe('applyBillingToEnvText', () => {
  const sample = '# comment\n# SAP_BILLING_CURRENCY=USD\n# SAP_CU_PRICE_PRODUCTIVE=\n# SAP_CU_PRICE_NON_PRODUCTIVE=\nOTHER=1\n';

  test('sets the currency and prices on the commented sample lines', () => {
    const text = applyBillingToEnvText(sample, {
      SAP_BILLING_CURRENCY: 'EUR',
      SAP_CU_PRICE_PRODUCTIVE: '0.35',
      SAP_CU_PRICE_NON_PRODUCTIVE: '0.2'
    });
    expect(text).toBe('# comment\nSAP_BILLING_CURRENCY=EUR\nSAP_CU_PRICE_PRODUCTIVE=0.35\nSAP_CU_PRICE_NON_PRODUCTIVE=0.2\nOTHER=1\n');
  });

  test('USD keeps the currency line and removes active price lines', () => {
    const text = applyBillingToEnvText('SAP_BILLING_CURRENCY=EUR\nSAP_CU_PRICE_PRODUCTIVE=1\nSAP_CU_PRICE_NON_PRODUCTIVE=2\nOTHER=1\n', {
      SAP_BILLING_CURRENCY: 'USD'
    });
    expect(text).toBe('SAP_BILLING_CURRENCY=USD\nOTHER=1\n');
  });

  test('appends keys that the file does not mention', () => {
    expect(applyBillingToEnvText('OTHER=1\n', { SAP_BILLING_CURRENCY: 'EUR' })).toBe('OTHER=1\nSAP_BILLING_CURRENCY=EUR\n');
  });
});

describe('billingFromEnv', () => {
  test('keeps valid values only', () => {
    expect(billingFromEnv({ SAP_BILLING_CURRENCY: 'eur', SAP_CU_PRICE_PRODUCTIVE: '0.5', SAP_CU_PRICE_NON_PRODUCTIVE: 'x' })).toEqual({
      SAP_CU_PRICE_PRODUCTIVE: '0.5'
    });
  });
});

describe('billingToWrite', () => {
  test('USD with nothing stored writes nothing', () => {
    expect(billingToWrite({ SAP_BILLING_CURRENCY: 'USD' }, {})).toBeNull();
  });
  test('USD with a stored currency is written (prices dropped)', () => {
    expect(billingToWrite({ SAP_BILLING_CURRENCY: 'USD' }, { SAP_BILLING_CURRENCY: 'EUR' })).toEqual({ SAP_BILLING_CURRENCY: 'USD' });
  });
  test('a non-USD answer is written', () => {
    expect(billingToWrite({ SAP_BILLING_CURRENCY: 'EUR' }, {})).toEqual({ SAP_BILLING_CURRENCY: 'EUR' });
  });
});
