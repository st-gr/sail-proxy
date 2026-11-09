'use strict';
/**
 * "Ask only what is new" for `sail-proxy upgrade`: a promptFn for PromptSession that answers every
 * question the installation already holds a valid value for, and forwards only the others (the
 * questions a release adds, or values no source holds) to the real prompt.
 *
 * - the review screen answers "Write configuration";
 * - key regeneration answers "keep" (an upgrade never rotates a key), deploy-now answers no;
 * - confirm* questions answer no, the non-destructive choice (e.g. generating keys in an existing
 *   namespace: setup then stops instead);
 * - a secret with a current value is kept (the keep choice, or Enter on its password prompt);
 * - any other question takes its current value when that value passes the question's choices and
 *   validation; else it is asked.
 */

const { REVIEW, WRITE } = require('./session');
const { KEY_REGENERATION_ID, KEEP, DONE } = require('./secrets');

// askKeyRegeneration's follow-up questions (secrets.js); only reached after "Regenerate a key…"
const REGENERATE_KEY_ID = 'regenerate-key';
const REGENERATE_CONFIRM_ID = 'regenerate-confirm';

const isEmpty = (value) => value === undefined || value === null || value === '';

function choiceValues(choices) {
  return (choices || [])
    .filter((c) => !(c && typeof c === 'object' && c.type === 'separator'))
    .map((c) => (c && typeof c === 'object' && 'value' in c ? c.value : c));
}

/**
 * @param {(question: object) => Promise<*>} realPromptFn  the interactive prompt (one question)
 * @param {object} current  current values by question id; read at question time
 * @returns {(question: object) => Promise<*>}
 */
function onlyNewPromptFn(realPromptFn, current) {
  return async (question) => {
    const base = String(question.id || question.name).replace(/#\d+$/, '');
    if (base === REVIEW) return WRITE;
    if (base === KEY_REGENERATION_ID) return KEEP;
    if (base === REGENERATE_KEY_ID) return DONE;
    if (base === REGENERATE_CONFIRM_ID || base === 'autoDeploy') return false;
    if (question.type === 'confirm' && /^confirm/.test(base)) return false;

    const value = current[base];
    if (value === undefined || value === null) return realPromptFn(question);
    const values = choiceValues(question.choices);

    if (question.type === 'password') return '';
    if (question.type === 'list' && values.includes(KEEP) && !isEmpty(value)) return KEEP;
    if (question.type === 'list' && !values.includes(value)) return realPromptFn(question);
    if (question.type === 'confirm' && typeof value !== 'boolean') return realPromptFn(question);
    if (question.validate && (await question.validate(value)) !== true) return realPromptFn(question);
    return value;
  };
}

module.exports = { onlyNewPromptFn };
