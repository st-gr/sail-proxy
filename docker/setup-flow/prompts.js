'use strict';
/**
 * Back-aware inquirer prompts for the setup scripts.
 *
 * Text questions (input / password / number) go back on the Up arrow. The key is read only from
 * readline's `keypress` event (`key.name === 'up'`), never from raw escape sequences, so it works
 * the same in Windows Terminal, PowerShell, cmd and Unix terminals. List questions get a trailing
 * "← Back" choice, confirm questions become a Yes / No / ← Back list and editor questions become
 * an Open editor / Keep current / ← Back list (Up arrow cannot reach into an external editor).
 *
 * Works with the inquirer instance the script loaded (8.2.x); prompts are subclassed from
 * inquirer.prompt.prompts, never required by path.
 */

// Same symbol as session.js exports (Symbol.for is global), kept here to avoid a require cycle.
const BACK = Symbol.for('sail.setup.back');
const BACK_CHOICE_NAME = '← Back';
const OPEN_EDITOR = '__open_editor__';
const KEEP_CURRENT = '__keep_current__';
const TEXT_TYPES = ['input', 'password', 'number'];
const BACK_TYPE_PREFIX = 'back-';

function backChoice() {
  return { name: BACK_CHOICE_NAME, value: BACK };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function backAwarePrompt(Base, type) {
  return class BackAwarePrompt extends Base {
    constructor(...args) {
      super(...args);
      // Registered as `back-<type>`; inquirer's getQuestion hides a default only when
      // opt.type === 'password', so keep the built-in type name.
      this.opt.type = type;
    }

    _run(cb, ...rest) {
      const input = this.rl.input;
      const onKeypress = (_value, key) => {
        if (this.opt.noBack || !key || key.name !== 'up') return;
        finish(BACK);
      };
      const finish = (value) => {
        input.removeListener('keypress', onKeypress);
        if (value === BACK) {
          this.status = 'answered';
          this.screen.done();
        }
        cb(value);
      };
      input.on('keypress', onKeypress);
      return super._run(finish, ...rest);
    }
  };
}

/**
 * Registers the back-aware text prompts as `back-input`, `back-password` and `back-number` on
 * promptModule (default inquirer.prompt). The built-in types stay untouched, so plain
 * inquirer.prompt calls never see BACK.
 */
function registerBackPrompts(inquirer, promptModule = inquirer.prompt) {
  for (const type of TEXT_TYPES) {
    const name = BACK_TYPE_PREFIX + type;
    if (!promptModule.prompts[name]) {
      promptModule.registerPrompt(name, backAwarePrompt(inquirer.prompt.prompts[type], type));
    }
  }
}

/**
 * inquirer's list treats a numeric default as an index. PromptSession passes remembered answers
 * (values) as defaults, so a number that is one of the choice values becomes that choice's index.
 * Other defaults are left as they are (a numeric default no value matches stays an index).
 */
function listDefault(choices, def) {
  if (typeof def !== 'number') return def;
  // The index counts selectable choices only (inquirer's realChoices skip separators).
  const index = choices
    .filter((c) => !(c && c.type === 'separator'))
    .findIndex((c) => c !== null && typeof c === 'object' && 'value' in c && c.value === def);
  return index >= 0 ? index : def;
}

/** Wraps filter/validate so the BACK choice passes through untouched. */
function passBack(question) {
  const out = { ...question };
  if (question.filter) out.filter = (value, ...rest) => (value === BACK ? value : question.filter(value, ...rest));
  if (question.validate) {
    out.validate = (value, ...rest) => (value === BACK ? true : question.validate(value, ...rest));
  }
  return out;
}

/**
 * Turns a question into its back-aware form. isFirst: the first question offers no Back.
 * - input / password / number (or no type): `back-<type>` prompt, Up arrow → BACK
 * - list: trailing "← Back" choice
 * - confirm: list Yes / No / ← Back returning a boolean
 * - editor: list Open editor / Keep current (only with a value) / ← Back; the returned list
 *   question carries the editor question as `editor` for the follow-up step
 * Other types are returned unchanged.
 */
function withBackChoice(question, isFirst) {
  const type = question.type || 'input';
  if (TEXT_TYPES.includes(type)) {
    return isFirst ? { ...question, type } : { ...question, type: BACK_TYPE_PREFIX + type };
  }
  if (type === 'list') {
    if (typeof question.choices === 'function') {
      const choices = async (answers) => {
        const list = [...((await question.choices(answers)) || [])];
        if (!isFirst) list.push(backChoice());
        return list;
      };
      return passBack({ ...question, choices });
    }
    const choices = [...(question.choices || [])];
    if (!isFirst) choices.push(backChoice());
    return passBack({ ...question, choices, default: listDefault(choices, question.default) });
  }
  if (type === 'confirm') {
    const choices = [
      { name: 'Yes', value: true },
      { name: 'No', value: false }
    ];
    if (!isFirst) choices.push(backChoice());
    return passBack({ ...question, type: 'list', choices, default: question.default !== false });
  }
  if (type === 'editor') {
    const keep = hasValue(question.default);
    const choices = [{ name: 'Open editor', value: OPEN_EDITOR }];
    if (keep) choices.push({ name: 'Keep current', value: KEEP_CURRENT });
    if (!isFirst) choices.push(backChoice());
    const { validate, filter, ...rest } = question;
    return { ...rest, type: 'list', choices, default: keep ? KEEP_CURRENT : OPEN_EDITOR, editor: question };
  }
  return question;
}

/**
 * The default promptFn of PromptSession: asks one question with the back-aware prompts and
 * resolves its answer, or BACK. `question.noBack` marks the first question.
 */
function createPromptFn(inquirer, promptModule = inquirer.prompt) {
  registerBackPrompts(inquirer, promptModule);
  const askRaw = async (question) => {
    const message = question.message || `${question.name}:`;
    const answers = await promptModule([{ ...question, name: 'value', message }]);
    return answers.value;
  };
  return async (question) => {
    const step = withBackChoice(question, question.noBack === true);
    const answer = await askRaw(step);
    if (!step.editor) return answer;
    if (answer === OPEN_EDITOR) return askRaw(step.editor);
    if (answer === KEEP_CURRENT) return step.editor.default;
    return answer;
  };
}

module.exports = { BACK, OPEN_EDITOR, KEEP_CURRENT, registerBackPrompts, withBackChoice, createPromptFn };
