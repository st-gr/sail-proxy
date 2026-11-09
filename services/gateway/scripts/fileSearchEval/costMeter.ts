/**
 * The evaluation's spending ceiling. Every billed step asks `ensure(estimate)` first and is skipped
 * (BudgetExceededError) when what was spent plus a conservative estimate of the step could pass
 * `maxUsd`; afterwards the step's reported usage is recorded.
 *
 * Prices: the gateway holds no price catalog (model prices live in the admin service), so these are
 * conservative constants, rounded up from the public list prices of the same models (OpenAI
 * text-embedding-3-large $0.13 / 1M tokens, Cohere Rerank 3.5 $2 / 1000 searches, OpenAI gpt-4.1
 * $2 / $8 per 1M input / output tokens), checked 2026-10-07. SAP AI Core bills in capacity units,
 * which this does not model; treat the figure as an upper-bound estimate, not an invoice.
 *
 * Context models (contextual chunks, W2) have a price row each in CONTEXT_PRICES, set 2026-10-09
 * and rounded up; the runner reads no price catalog (model prices live in the admin's Model
 * Library), so the person running the evaluation checks these rows against SAP's current prices
 * before a contextual run:
 * - anthropic--claude-4.5-haiku: Anthropic's list price, $1 input, $1.25 cache write, $0.10 cache
 *   read, $5 output per 1M tokens. SAP's catalogue (extended attributes, captured 2026-09-23)
 *   lists SAP Cost Factors (per 1K tokens, not USD): 0.00079 / 0.00099 / 0.00008 / 0.00367.
 * - gemini-3.5-flash-lite: the meter uses a USD row, not SAP's Cost Factors; the row is the Gemini Flash
 *   tier ($0.50 input, $3 output per 1M), well above the earlier Flash-Lite list price ($0.10 /
 *   $0.40). Cache reads are priced as input: implicit Gemini caching was unreliable when measured.
 * A context model without a row is refused before the run starts (UnpricedModelError): a dearer
 * model priced with a cheaper row would let the ceiling fail open. The same holds for the judge's
 * chat model (JUDGE_PRICES): gemini-3.5-flash (the default; no retirement date recorded) is priced
 * above the Gemini Flash list price ($0.50 / $3 per 1M) at $1 / $6, gpt-4.1 at the constants above.
 * The job counters report a file's uncached input with its cache writes included, without the
 * split, so uncached input is priced at the higher of the input and cache-write prices.
 *
 * Vision models (W3, page transcription) have a row each in VISION_PRICES, priced like a context
 * model (the same row for gemini-3.5-flash-lite, set 2026-10-09). A
 * vision configuration whose model has no row is refused before the run starts.
 */
export interface Prices {
  embeddingPer1kTokens: number;
  rerankPerSearchUnit: number;
  chatInputPer1kTokens: number;
  chatOutputPer1kTokens: number;
}

export const PRICES: Prices = {
  embeddingPer1kTokens: 0.00015,
  rerankPerSearchUnit: 0.0025,
  chatInputPer1kTokens: 0.0025,
  chatOutputPer1kTokens: 0.01,
};

/** USD per 1k tokens of one context model. */
export interface ContextPrices {
  inputPer1kTokens: number;
  cacheWritePer1kTokens: number;
  cachedReadPer1kTokens: number;
  outputPer1kTokens: number;
}

export const CONTEXT_PRICES: Readonly<Record<string, ContextPrices>> = {
  'gemini-3.5-flash-lite': {
    inputPer1kTokens: 0.0005, cacheWritePer1kTokens: 0.0005, cachedReadPer1kTokens: 0.0005, outputPer1kTokens: 0.003,
  },
  'anthropic--claude-4.5-haiku': {
    inputPer1kTokens: 0.001, cacheWritePer1kTokens: 0.00125, cachedReadPer1kTokens: 0.0001, outputPer1kTokens: 0.005,
  },
};

/** USD per 1k tokens of a vision model (page transcription, W3). */
export const VISION_PRICES: Readonly<Record<string, ContextPrices>> = {
  'gemini-3.5-flash-lite': CONTEXT_PRICES['gemini-3.5-flash-lite'],
};

/** USD per 1k tokens of a judge chat model (sap-client.js caps its output at 6000 tokens). */
export const JUDGE_PRICES: Readonly<Record<string, { inputPer1kTokens: number; outputPer1kTokens: number }>> = {
  'gemini-3.5-flash': { inputPer1kTokens: 0.001, outputPer1kTokens: 0.006 },
  'gpt-4.1': { inputPer1kTokens: PRICES.chatInputPer1kTokens, outputPer1kTokens: PRICES.chatOutputPer1kTokens },
};

/** A model the meter has no price row for: refused, never priced with another model's row. */
export class UnpricedModelError extends Error {
  constructor(readonly model: string, readonly kind: 'context' | 'judge' | 'vision') {
    super(`no price row for the ${kind} model ${model}: add one to `
      + `${({ context: 'CONTEXT_PRICES', judge: 'JUDGE_PRICES', vision: 'VISION_PRICES' })[kind]} in services/gateway/scripts/fileSearchEval/costMeter.ts`);
    this.name = 'UnpricedModelError';
  }
}

/** PRICES with the chat rows of `judgeModel`; throws UnpricedModelError for a model without a row. */
export function pricesForJudge(judgeModel: string, base: Prices = PRICES): Prices {
  const row = JUDGE_PRICES[judgeModel];
  if (!row) throw new UnpricedModelError(judgeModel, 'judge');
  return { ...base, chatInputPer1kTokens: row.inputPer1kTokens, chatOutputPer1kTokens: row.outputPer1kTokens };
}

/** One context model's tokens as the job counters report them. */
export interface ContextTokens { inputTokens: number; cachedTokens: number; outputTokens: number }

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly estimateUsd: number, readonly maxUsd: number) {
    super(`spending ceiling reached: $${spentUsd.toFixed(4)} spent + $${estimateUsd.toFixed(4)} estimated `
      + `would pass --max-usd ${maxUsd}`);
    this.name = 'BudgetExceededError';
  }
}

export interface CostSnapshot {
  maxUsd: number;
  spentUsd: number;
  embeddingTokens: number;
  rerankSearchUnits: number;
  chatInputTokens: number;
  chatOutputTokens: number;
  /** Context-writer tokens per context model (absent from results written before W2). */
  context?: Record<string, ContextTokens>;
  prices: Prices;
  /** The price row used for each context model in `context`. */
  contextPrices?: Record<string, ContextPrices>;
  /** Vision tokens per vision model (absent from results written before W3), as the calls reported them. */
  vision?: Record<string, ContextTokens>;
  visionPrices?: Record<string, ContextPrices>;
}

/** What the runner needs from a meter; tests pass a fake. */
export interface Meter {
  ensure(estimateUsd: number): void;
  addEmbedding(tokens: number): void;
  addRerank(searchUnits: number): void;
  addChat(inputTokens: number, outputTokens: number): void;
  /** A file's context-writer tokens: uncached input (cache writes included), cache reads, output. */
  addContext(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): void;
  /** A vision call's tokens: uncached input (cache writes included), cache reads, output. */
  addVision?(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): void;
  snapshot(): CostSnapshot;
}

const positive = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export class CostMeter implements Meter {
  private embeddingTokens = 0;
  private rerankSearchUnits = 0;
  private chatInputTokens = 0;
  private chatOutputTokens = 0;
  private readonly context = new Map<string, ContextTokens>();
  private readonly vision = new Map<string, ContextTokens>();

  constructor(
    readonly maxUsd: number, readonly prices: Prices = PRICES,
    readonly contextPriceTable: Readonly<Record<string, ContextPrices>> = CONTEXT_PRICES,
    readonly visionPriceTable: Readonly<Record<string, ContextPrices>> = VISION_PRICES,
  ) {}

  embeddingUsd(tokens: number): number { return (tokens / 1000) * this.prices.embeddingPer1kTokens; }
  rerankUsd(units: number): number { return units * this.prices.rerankPerSearchUnit; }
  chatUsd(input: number, output: number): number {
    return (input / 1000) * this.prices.chatInputPer1kTokens + (output / 1000) * this.prices.chatOutputPer1kTokens;
  }

  /** The model's price row; throws UnpricedModelError for a model without one (the runner asks
   *  before the run starts). */
  contextPrices(model: string): ContextPrices {
    const row = this.contextPriceTable[model];
    if (!row) throw new UnpricedModelError(model, 'context');
    return row;
  }

  /** Uncached input (cache writes included, so at the higher of the two prices), cache reads, output. */
  contextUsd(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number {
    return completionUsd(this.contextPrices(model), inputTokens, cachedTokens, outputTokens);
  }

  /** The vision model's price row; throws UnpricedModelError for a model without one. */
  visionPrices(model: string): ContextPrices {
    const row = this.visionPriceTable[model];
    if (!row) throw new UnpricedModelError(model, 'vision');
    return row;
  }

  visionUsd(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number {
    return completionUsd(this.visionPrices(model), inputTokens, cachedTokens, outputTokens);
  }

  /** A context estimate (estimateContextTokens: the whole prompt as sent, the reply limit) priced as
   *  if nothing were read from a cache. */
  contextEstimateUsd(model: string, estimate: { input: number; outputUpperBound: number }): number {
    return this.contextUsd(model, estimate.input, 0, estimate.outputUpperBound);
  }

  get spentUsd(): number {
    let context = 0;
    for (const [model, t] of this.context) context += this.contextUsd(model, t.inputTokens, t.cachedTokens, t.outputTokens);
    for (const [model, t] of this.vision) context += this.visionUsd(model, t.inputTokens, t.cachedTokens, t.outputTokens);
    return this.embeddingUsd(this.embeddingTokens) + this.rerankUsd(this.rerankSearchUnits)
      + this.chatUsd(this.chatInputTokens, this.chatOutputTokens) + context;
  }

  ensure(estimateUsd: number): void {
    const spent = this.spentUsd;
    if (spent + Math.max(0, estimateUsd) > this.maxUsd) throw new BudgetExceededError(spent, estimateUsd, this.maxUsd);
  }

  addEmbedding(tokens: number): void { this.embeddingTokens += positive(tokens); }
  addRerank(searchUnits: number): void { this.rerankSearchUnits += positive(searchUnits); }
  addChat(inputTokens: number, outputTokens: number): void {
    this.chatInputTokens += positive(inputTokens);
    this.chatOutputTokens += positive(outputTokens);
  }
  addContext(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): void {
    addTokens(this.context, model, inputTokens, cachedTokens, outputTokens);
  }
  addVision(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): void {
    this.visionPrices(model);
    addTokens(this.vision, model, inputTokens, cachedTokens, outputTokens);
  }

  snapshot(): CostSnapshot {
    const context: Record<string, ContextTokens> = {};
    const contextPrices: Record<string, ContextPrices> = {};
    for (const [model, t] of this.context) {
      context[model] = { ...t };
      contextPrices[model] = this.contextPrices(model);
    }
    const vision: Record<string, ContextTokens> = {};
    const visionPrices: Record<string, ContextPrices> = {};
    for (const [model, t] of this.vision) {
      vision[model] = { ...t };
      visionPrices[model] = this.visionPrices(model);
    }
    return {
      maxUsd: this.maxUsd,
      spentUsd: this.spentUsd,
      embeddingTokens: this.embeddingTokens,
      rerankSearchUnits: this.rerankSearchUnits,
      chatInputTokens: this.chatInputTokens,
      chatOutputTokens: this.chatOutputTokens,
      context,
      prices: this.prices,
      contextPrices,
      ...(this.vision.size ? { vision, visionPrices } : {}),
    };
  }
}

/** Uncached input (cache writes included, so at the higher of the two prices), cache reads, output. */
function completionUsd(p: ContextPrices, inputTokens: number, cachedTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * Math.max(p.inputPer1kTokens, p.cacheWritePer1kTokens)
    + (cachedTokens / 1000) * p.cachedReadPer1kTokens + (outputTokens / 1000) * p.outputPer1kTokens;
}

function addTokens(map: Map<string, ContextTokens>, model: string, inputTokens: number, cachedTokens: number, outputTokens: number): void {
  const t = map.get(model) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  t.inputTokens += positive(inputTokens);
  t.cachedTokens += positive(cachedTokens);
  t.outputTokens += positive(outputTokens);
  map.set(model, t);
}
