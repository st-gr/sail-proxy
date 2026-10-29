'use strict';
/**
 * Prompt session for the setup scripts: Back, Jump and a review screen.
 *
 * The setup scripts ask their questions inside a side-effect-free collect function. Every
 * question goes through PromptSession.ask, which remembers the answer per question id. Going
 * back (Up arrow / "← Back") or jumping from the review screen re-runs the collect function:
 * questions before the target are answered silently from memory, the target and every later
 * question are shown again with the remembered answer as default. Read-only work that should
 * not repeat on a replay (probes, cluster reads, metadata fetches) goes through session.once.
 */

const { createPromptFn } = require('./prompts');

const BACK = Symbol.for('sail.setup.back');
const WRITE = '__write__';
const REVIEW = '__review__';

/** Thrown through the collect function to restart it; never escapes run(). */
class Replay {
  constructor(target) {
    this.target = target;
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function isSecret(question) {
  return question.secret === true || question.type === 'password';
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/**
 * What the review screen shows for an answer. Secrets show their origin, never the value:
 * `set` (kept), `new` (typed in this session) or `generated`; editor values show a line count.
 * @param {object} question  the question as asked (type, name/id, choices, secret)
 * @param {*} value          the answer
 * @param {object} [current] current values by question id (the value a question started with)
 * @param {string} [origin]  'kept' | 'new' | 'generated', when the caller knows it
 */
function displayValue(question, value, current = {}, origin) {
  const id = question.id || question.name;
  if (isSecret(question)) {
    if (origin) return origin === 'kept' ? 'set' : origin;
    if (isEmpty(value)) return '(empty)';
    return current[id] !== undefined && sameValue(current[id], value) ? 'set' : 'new';
  }
  if (question.type === 'editor') {
    return isEmpty(value) ? '(empty)' : `(${String(value).split('\n').length} lines)`;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (Array.isArray(question.choices)) {
    const choice = question.choices.find(
      (c) => c && typeof c === 'object' && 'value' in c && sameValue(c.value, value)
    );
    if (choice && choice.name) return String(choice.name);
  }
  return isEmpty(value) ? '(empty)' : String(value);
}

async function resolve(property, answers) {
  return typeof property === 'function' ? property(answers) : property;
}

class PromptSession {
  /**
   * @param {object} options
   * @param {object} options.inquirer   the loaded inquirer module
   * @param {Function} [options.promptFn] (question) => Promise<answer | BACK>; defaults to the
   *        back-aware inquirer prompt for one question
   * @param {object} [options.current]  current values by question id (first defaults)
   */
  constructor({ inquirer, promptFn, current } = {}) {
    this.promptFn = promptFn || createPromptFn(inquirer);
    this.current = current || {};
    this.memory = new Map(); // id -> last answer, kept across replays and branch switches
    this.initial = new Map(); // id -> the value the question started with
    this.onceResults = new Map();
    this.generated = new Map(); // id -> value produced by a "Generate new" choice, stable across replays
    this.history = [];
    this.resetRun(null);
  }

  resetRun(target) {
    this.target = target; // id to show first; null = show everything
    this.replaying = target !== null;
    this.idCounts = new Map();
    this.reached = []; // ids reached in this run, silent or shown
    this.answered = []; // history entries of this run
  }

  nextId(question) {
    const base = question.id || question.name;
    const count = (this.idCounts.get(base) || 0) + 1;
    this.idCounts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  }

  /**
   * Drop-in for inquirer.prompt: asks one question at a time and returns this call's answers.
   * Extra question fields: id (default name), secret, reviewLabel.
   */
  async ask(questions) {
    const list = Array.isArray(questions) ? questions : [questions];
    const answers = {};
    for (const question of list) {
      const id = this.nextId(question);
      if (question.when !== undefined && !(await resolve(question.when, answers))) continue;
      answers[question.name] = await this.askOne(question, id, answers);
    }
    return answers;
  }

  async askOne(question, id, answers) {
    if (this.replaying && id === this.target) this.replaying = false;
    const isFirst = this.reached.length === 0;
    const previous = this.reached[this.reached.length - 1];
    this.reached.push(id);

    const message = await resolve(question.message, answers);
    const choices = await resolve(question.choices, answers);
    const resolved = { ...question, id, message, choices };
    delete resolved.when;
    if (question.validate) resolved.validate = (value) => question.validate(value, answers);
    if (question.filter) resolved.filter = (value) => question.filter(value, answers);

    let value;
    if (this.replaying && this.memory.has(id)) {
      value = this.memory.get(id);
    } else {
      this.replaying = false;
      const ownDefault = await resolve(question.default, answers);
      if (!this.initial.has(id)) {
        this.initial.set(id, this.current[id] !== undefined ? this.current[id] : ownDefault);
      }
      if (this.memory.has(id)) resolved.default = this.memory.get(id);
      else if (this.current[id] !== undefined) resolved.default = this.current[id];
      else resolved.default = ownDefault;
      if (isFirst) resolved.noBack = true;

      // A secret's value never reaches the prompt (inquirer prints input defaults in clear):
      // the prompt shows a hint instead and Enter (an empty answer) keeps the value here.
      const kept = isSecret(question) && !isEmpty(resolved.default) ? resolved.default : undefined;
      if (kept !== undefined) {
        delete resolved.default;
        resolved.message = `${message || question.name} (set — Enter keeps it)`;
        if (resolved.validate) {
          const check = resolved.validate;
          resolved.validate = (v) => (isEmpty(v) ? true : check(v));
        }
        if (resolved.filter) {
          const filter = resolved.filter;
          resolved.filter = (v) => (isEmpty(v) ? v : filter(v));
        }
      }

      for (;;) {
        value = await this.promptFn(resolved);
        if (value !== BACK) break;
        if (!isFirst) throw new Replay(previous);
        // The first question has no Back: ask it again.
      }
      if (kept !== undefined && isEmpty(value)) value = kept;
      this.memory.set(id, value);
    }

    // review: false keeps a helper step (e.g. a secret's keep/new/generate choice) off the review
    // screen; the step's owner adds the one entry with record().
    if (question.review !== false) {
      this.answered.push({
        id,
        label: question.reviewLabel || String(message || question.name).replace(/\s*:\s*$/, ''),
        value,
        display: displayValue(resolved, value, this.current),
        secret: isSecret(question),
        changed: !sameValue(value, this.initial.has(id) ? this.initial.get(id) : value)
      });
    }
    return value;
  }

  /**
   * Adds a review entry for a step made of several questions. entry: { id, label, value,
   * display, secret?, changed? }; id must be the id of the step's first (jump target) question.
   * `display` is what the review shows, so it must never contain a secret's value.
   */
  record(entry) {
    this.answered.push({ secret: false, changed: false, ...entry });
  }

  /**
   * Forgets every remembered answer, starting value and generated value except those of `ids`.
   * For an answer that selects which current values apply (setup-kyma's namespace): after it
   * changes, the later questions start from the new current values, not from answers given for
   * the old ones, and the review marks changes against the new ones.
   * @param {string[]} ids  question ids to keep
   */
  resetExcept(ids) {
    for (const map of [this.memory, this.initial, this.generated]) {
      for (const id of [...map.keys()]) {
        if (!ids.includes(id)) map.delete(id);
      }
    }
  }

  /**
   * Forgets the remembered answer, starting value and generated value of `ids` only: they are
   * asked again from their current value or their own default (e.g. a registry login after the
   * registry it belongs to changed).
   * @param {string[]} ids  question ids to forget
   */
  forget(ids) {
    for (const map of [this.memory, this.initial, this.generated]) {
      for (const id of ids) map.delete(id);
    }
  }

  /** Runs fn once per session; later calls (also on replays) get the first result. */
  once(key, fn) {
    if (!this.onceResults.has(key)) {
      const pending = Promise.resolve().then(fn);
      pending.catch(() => this.onceResults.delete(key));
      this.onceResults.set(key, pending);
    }
    return this.onceResults.get(key);
  }

  /**
   * Runs collect(session) until the user chooses "Write configuration" on the review screen,
   * replaying it on Back and Jump. Errors other than Back (Ctrl-C, aborts) propagate unchanged.
   */
  async run(collect) {
    let target = null;
    for (;;) {
      this.resetRun(target);
      let result;
      try {
        result = await collect(this);
      } catch (error) {
        if (error instanceof Replay) {
          target = error.target;
          continue;
        }
        throw error;
      }
      this.history = this.answered;
      if (this.history.length === 0) return result;

      const choice = await this.promptFn(this.reviewQuestion());
      if (choice === WRITE) return result;
      target = choice === BACK ? this.history[this.history.length - 1].id : choice;
    }
  }

  /**
   * Write configuration stands apart from the answers (separators) and the list does not wrap,
   * so it stays at the top instead of reappearing between "← Back" and the first answer.
   * Separators are plain { type: 'separator', line } objects; inquirer 8 converts them.
   */
  reviewQuestion() {
    return {
      type: 'list',
      id: REVIEW,
      name: REVIEW,
      message: 'Review your answers (choose one to change it)',
      choices: [
        { name: '✔ Write configuration', value: WRITE },
        { type: 'separator', line: '──── or change an answer ────' },
        ...this.history.map((entry) => ({
          name: `${entry.label}: ${entry.display}${entry.changed ? ' (changed)' : ''}`,
          value: entry.id
        })),
        { type: 'separator', line: '────' }
      ],
      default: WRITE,
      loop: false,
      pageSize: 20
    };
  }
}

module.exports = { BACK, WRITE, REVIEW, PromptSession, displayValue };
