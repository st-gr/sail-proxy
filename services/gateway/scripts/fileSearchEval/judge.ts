/**
 * Opt-in answer quality (--judge N): for a deterministic sample of N questions, a SAP chat model
 * answers from the top results only, then a second call scores the answer 1-5 for faithfulness (is
 * every claim supported by the context?) and correctness (does it agree with the reference quotes?).
 * Both calls go through the same meter as retrieval.
 */
import * as crypto from 'crypto';
import { BudgetExceededError, Meter } from './costMeter';
import { EvalQuestion, safeError, SearchHitText } from './evaluate';

/** Results the answer is written from. */
export const JUDGE_CONTEXT_RESULTS = 5;
/** Characters of each result the answer sees: a chunk of up to 800 tokens fits; a parent-section run
 *  passes a larger limit so its sections are not cut back to chunk size. */
export const MAX_CONTEXT_CHARS = 4000;
/** sap-client.js caps every completion at this many output tokens; the estimate assumes all of them. */
export const CHAT_MAX_OUTPUT_TOKENS = 6000;

export interface ChatPrompt { system: string; user: string }
export interface ChatReply { text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }
export type ChatFn = (prompt: ChatPrompt) => Promise<ChatReply>;

export interface JudgeScores { faithfulness: number; correctness: number }
export interface JudgeItem { id: string; kind: string; scores: JudgeScores | null; error?: string }
export interface JudgeRun {
  requested: number;
  model: string;
  complete: boolean;
  stopReason: string | null;
  items: JudgeItem[];
  mean: JudgeScores | null;
}

/** The same N questions on every run: ordered by sha256 of the id. */
export function pickJudgeSample<T extends { id: string }>(questions: T[], n: number): T[] {
  const key = (id: string) => crypto.createHash('sha256').update(`judge:${id}`).digest('hex');
  return [...questions].sort((a, b) => key(a.id).localeCompare(key(b.id))).slice(0, n);
}

function contextBlock(hits: SearchHitText[], maxChars = MAX_CONTEXT_CHARS): string {
  return hits.slice(0, JUDGE_CONTEXT_RESULTS)
    .map((h, i) => `[${i + 1}] (${h.filename})\n${h.text.slice(0, maxChars)}`)
    .join('\n\n') || '(no results)';
}

export function answerPrompt(q: EvalQuestion, hits: SearchHitText[], maxChars = MAX_CONTEXT_CHARS): ChatPrompt {
  return {
    system: 'Answer the question using only the numbered context passages. Be brief. If the context does not '
      + 'contain the answer, say "The context does not say."',
    user: `Context:\n${contextBlock(hits, maxChars)}\n\nQuestion: ${q.question}`,
  };
}

export function judgePrompt(q: EvalQuestion, hits: SearchHitText[], answer: string, maxChars = MAX_CONTEXT_CHARS): ChatPrompt {
  return {
    system: 'You grade answers produced by a retrieval system. Score two things from 1 (worst) to 5 (best).\n'
      + 'faithfulness: every claim in the answer is supported by the context passages (5 = fully supported, '
      + '1 = mostly unsupported or invented; an honest "the context does not say" is faithful).\n'
      + 'correctness: the answer agrees with the reference excerpts and answers the question (5 = complete '
      + 'and correct, 1 = wrong or missing).\n'
      + 'Reply with JSON only: {"faithfulness": <1-5>, "correctness": <1-5>}',
    user: `Question: ${q.question}\n\nReference excerpts:\n${q.quotes.map((s) => `- ${s}`).join('\n')}\n\n`
      + `Context passages:\n${contextBlock(hits, maxChars)}\n\nAnswer to grade:\n${answer}`,
  };
}

/** The two scores from the judge's reply, or null when it holds no valid JSON object with both. */
export function parseJudgeScores(text: string): JudgeScores | null {
  const match = /\{[^{}]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
    if (!ok(parsed.faithfulness) || !ok(parsed.correctness)) return null;
    return { faithfulness: parsed.faithfulness, correctness: parsed.correctness };
  } catch {
    return null;
  }
}

/** Conservative cost of one chat call before it is made: four characters a token in, the cap out. */
export function chatEstimateUsd(meter: { chatUsd(input: number, output: number): number }, prompt: ChatPrompt): number {
  return meter.chatUsd(Math.ceil((prompt.system.length + prompt.user.length) / 4), CHAT_MAX_OUTPUT_TOKENS);
}

async function call(chat: ChatFn, meter: Meter, estimate: number, prompt: ChatPrompt): Promise<string> {
  meter.ensure(estimate);
  const reply = await chat(prompt);
  const input = reply.usage?.prompt_tokens ?? Math.ceil((prompt.system.length + prompt.user.length) / 4);
  const output = reply.usage?.completion_tokens ?? Math.ceil(reply.text.length / 4);
  meter.addChat(input, output);
  return reply.text;
}

export async function runJudge(sample: EvalQuestion[], deps: {
  chat: ChatFn; meter: Meter; model: string; hits: Map<string, SearchHitText[]>;
  estimateUsd: (prompt: ChatPrompt) => number; log?: (m: string) => void;
  /** Characters of each result the prompts carry; default MAX_CONTEXT_CHARS. */
  maxContextChars?: number;
}): Promise<JudgeRun> {
  const maxChars = deps.maxContextChars ?? MAX_CONTEXT_CHARS;
  const run: JudgeRun = { requested: sample.length, model: deps.model, complete: true, stopReason: null, items: [], mean: null };
  for (const q of sample) {
    const hits = deps.hits.get(q.id);
    if (!hits) continue; // the search for it failed or never ran
    try {
      const ask = answerPrompt(q, hits, maxChars);
      // eslint-disable-next-line no-await-in-loop
      const answer = await call(deps.chat, deps.meter, deps.estimateUsd(ask), ask);
      const grade = judgePrompt(q, hits, answer, maxChars);
      // eslint-disable-next-line no-await-in-loop
      const scores = parseJudgeScores(await call(deps.chat, deps.meter, deps.estimateUsd(grade), grade));
      run.items.push({ id: q.id, kind: q.kind, scores, ...(scores ? {} : { error: 'unparseable judge reply' }) });
    } catch (error: any) {
      if (error instanceof BudgetExceededError || error?.budget || error?.fatal) {
        run.complete = false;
        run.stopReason = safeError(error);
        break;
      }
      run.items.push({ id: q.id, kind: q.kind, scores: null, error: safeError(error) });
    }
  }
  const scored = run.items.map((i) => i.scores).filter((s): s is JudgeScores => s !== null);
  if (scored.length) {
    const avg = (f: (s: JudgeScores) => number) => scored.reduce((a, s) => a + f(s), 0) / scored.length;
    run.mean = { faithfulness: avg((s) => s.faithfulness), correctness: avg((s) => s.correctness) };
  }
  deps.log?.(`judge: ${scored.length}/${sample.length} scored`);
  return run;
}
