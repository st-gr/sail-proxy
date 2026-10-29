'use strict';
/**
 * Billing currency questions for the setup scripts, and the admin env lines they produce.
 *
 * The admin prices SAP cost in the capacity-unit (CU) rates of its SAP Rates data. With a
 * non-USD billing currency there is no built-in price list, so the user may enter the two CU
 * prices here; without them SAP cost shows as not priced until they are entered in the app.
 */

const CURRENCY_KEY = 'SAP_BILLING_CURRENCY';
const PRODUCTIVE_KEY = 'SAP_CU_PRICE_PRODUCTIVE';
const NON_PRODUCTIVE_KEY = 'SAP_CU_PRICE_NON_PRODUCTIVE';
const BILLING_KEYS = [CURRENCY_KEY, PRODUCTIVE_KEY, NON_PRODUCTIVE_KEY];
const ENTER_PRICES_ID = 'billingEnterPrices';
const NOT_PRICED_HINT = 'SAP cost shows as not priced until you enter rates in the SAP Rates app.';

function validateCurrency(value) {
  return /^[A-Z]{3}$/.test(String(value || '')) ? true : 'Enter a three-letter currency code, for example EUR';
}

// The admin stores CU prices as Decimal(10,6) and ignores a value of 10000 or more.
const MAX_PRICE = 10000;

function validatePrice(value) {
  const text = String(value || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text) || !(Number(text) > 0)) {
    return 'Enter a positive number with up to six decimals, for example 0.35';
  }
  return Number(text) < MAX_PRICE ? true : `Enter a price less than ${MAX_PRICE}`;
}

/** Whether a billing value read back from an env file would pass its question. */
function isValidBillingValue(key, value) {
  if (typeof value !== 'string') return false;
  if (key === CURRENCY_KEY) return validateCurrency(value) === true;
  if (key === PRODUCTIVE_KEY || key === NON_PRODUCTIVE_KEY) return validatePrice(value) === true;
  return false;
}

/** The valid billing values of an env (parsed .env / Secret data), keyed by question id. */
function billingFromEnv(env) {
  const current = {};
  for (const key of BILLING_KEYS) {
    const value = env && typeof env[key] === 'string' ? env[key].trim() : undefined;
    if (value !== undefined && isValidBillingValue(key, value)) current[key] = value;
  }
  return current;
}

/**
 * Asks the billing currency and, for a currency other than USD, optionally the two CU prices.
 * @param {object} session  the PromptSession
 * @param {object} [current]  current values by key (SAP_BILLING_CURRENCY, SAP_CU_PRICE_*)
 * @returns {Promise<{SAP_BILLING_CURRENCY: string, SAP_CU_PRICE_PRODUCTIVE?: string,
 *   SAP_CU_PRICE_NON_PRODUCTIVE?: string}>} prices are omitted for USD and when not entered
 */
async function askBilling(session, current = {}) {
  const { [CURRENCY_KEY]: currency } = await session.ask({
    type: 'input',
    name: CURRENCY_KEY,
    message: 'SAP billing currency (three letters, for example USD or EUR):',
    reviewLabel: 'SAP billing currency',
    default: current[CURRENCY_KEY] || 'USD',
    filter: (value) => String(value || '').trim().toUpperCase(),
    validate: validateCurrency
  });
  const billing = { [CURRENCY_KEY]: currency };
  if (currency === 'USD') return billing;

  const havePrices = Boolean(current[PRODUCTIVE_KEY] || current[NON_PRODUCTIVE_KEY]);
  const { [ENTER_PRICES_ID]: enterPrices } = await session.ask({
    type: 'confirm',
    name: ENTER_PRICES_ID,
    message: 'Enter your CU prices now?',
    reviewLabel: 'Enter CU prices',
    default: havePrices
  });
  if (!enterPrices) {
    // Once per run: the question is asked again on every replay (Back, jump from the review).
    if (!session.billingHintShown) console.log(NOT_PRICED_HINT);
    session.billingHintShown = true;
    return billing;
  }
  const productive = await session.ask({
    type: 'input',
    name: PRODUCTIVE_KEY,
    message: `Price per capacity unit, productive (${currency}):`,
    reviewLabel: 'CU price, productive',
    default: current[PRODUCTIVE_KEY],
    filter: (value) => String(value || '').trim(),
    validate: validatePrice
  });
  const nonProductive = await session.ask({
    type: 'input',
    name: NON_PRODUCTIVE_KEY,
    message: `Price per capacity unit, non-productive (${currency}):`,
    reviewLabel: 'CU price, non-productive',
    default: current[NON_PRODUCTIVE_KEY],
    filter: (value) => String(value || '').trim(),
    validate: validatePrice
  });
  billing[PRODUCTIVE_KEY] = productive[PRODUCTIVE_KEY];
  billing[NON_PRODUCTIVE_KEY] = nonProductive[NON_PRODUCTIVE_KEY];
  return billing;
}

/**
 * What an interactive run writes: the answer, except that USD with no stored currency changes
 * nothing (null). Writing an explicit currency would make the admin price only rows in that
 * currency, which could drop rows added by hand.
 */
function billingToWrite(billing, current = {}) {
  if (!billing) return null;
  if (billing[CURRENCY_KEY] === 'USD' && !current[CURRENCY_KEY]) return null;
  return billing;
}

/**
 * Sets the billing keys in the text of an env file. A key with a value replaces its active line
 * (or the commented sample line, or is appended); a key without a value loses its active line.
 * Every other line stays as it is. The currency is always set; prices are removed when absent.
 */
function applyBillingToEnvText(text, billing) {
  const lines = text.split('\n');
  for (const key of BILLING_KEYS) {
    const value = billing[key];
    const active = new RegExp(`^\\s*${key}\\s*=`);
    const sample = new RegExp(`^\\s*#\\s*${key}\\s*=`);
    if (value === undefined) {
      for (let i = lines.length - 1; i >= 0; i--) if (active.test(lines[i])) lines.splice(i, 1);
      continue;
    }
    let index = lines.findIndex((line) => active.test(line));
    if (index < 0) index = lines.findIndex((line) => sample.test(line));
    if (index >= 0) {
      lines[index] = `${key}=${value}`;
    } else {
      if (lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${value}`, '');
    }
  }
  return lines.join('\n');
}

module.exports = {
  BILLING_KEYS,
  ENTER_PRICES_ID,
  NOT_PRICED_HINT,
  validateCurrency,
  validatePrice,
  billingFromEnv,
  isValidBillingValue,
  askBilling,
  billingToWrite,
  applyBillingToEnvText
};
