/**
 * Scripted stand-in for the interactive prompt of docker/setup-flow/session.js.
 * Each step names the question it expects (by id, e.g. `x#2`, or by name) and the answer to give:
 * a value, 'BACK' (the ← Back choice / Up arrow), 'WRITE' (review screen: Write configuration)
 * or { jump: id } (review screen: jump to that question). Like inquirer, a value the question's
 * filter/validate rejects is not returned: the next step answers the same question again.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BACK, WRITE, REVIEW } = require('../../../../docker/setup-flow/session');

export type Step = [idOrName: string, answer: any];

export interface ShownQuestion {
  id: string;
  name: string;
  default: any;
  question: any;
  answer?: any;
  rejected?: any[];
}

export interface Scripted {
  promptFn: (question: any) => Promise<any>;
  /** Every question shown, in order, with the default it was shown with. */
  shown: ShownQuestion[];
  /** Throws unless every step was consumed. */
  assertDone: () => void;
}

export function scripted(steps: Step[]): Scripted {
  const queue = [...steps];
  const shown: ShownQuestion[] = [];

  const promptFn = async (question: any): Promise<any> => {
    const entry: ShownQuestion = {
      id: question.id,
      name: question.name,
      default: question.default,
      question
    };
    shown.push(entry);
    for (;;) {
      const step = queue.shift();
      if (!step) throw new Error(`scripted: no step left for question "${question.id}"`);
      const [key, answer] = step;
      if (key !== question.id && key !== question.name) {
        throw new Error(`scripted: expected a step for "${key}" but "${question.id}" was asked`);
      }
      if (answer === 'BACK') return (entry.answer = BACK);
      if (question.id === REVIEW) {
        if (answer === 'WRITE') return (entry.answer = WRITE);
        if (answer && typeof answer === 'object' && 'jump' in answer) {
          const values = question.choices.map((c: any) => c.value);
          if (!values.includes(answer.jump)) {
            throw new Error(`scripted: "${answer.jump}" is not on the review screen (${values.join(', ')})`);
          }
          return (entry.answer = answer.jump);
        }
        throw new Error(`scripted: review screen needs 'WRITE', 'BACK' or { jump }, got ${String(answer)}`);
      }
      const value = question.filter ? await question.filter(answer) : answer;
      const valid = question.validate ? await question.validate(value) : true;
      if (valid === true) return (entry.answer = value);
      (entry.rejected ??= []).push(value);
    }
  };

  const assertDone = (): void => {
    if (queue.length) {
      throw new Error(`scripted: ${queue.length} step(s) not consumed: ${JSON.stringify(queue)}`);
    }
  };

  return { promptFn, shown, assertDone };
}
