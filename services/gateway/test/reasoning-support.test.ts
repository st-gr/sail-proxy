/**
 * Pure-resolver coverage for resolveReasoningEffort (explicit per-model map,
 * exact name only — no version/prefix heuristic — see
 * src/utils/reasoningSupport.ts), following the same layout as
 * test/prompt-caching-support.test.ts.
 */
import { describe, it, expect } from '@jest/globals';
import {
  resolveReasoningEffort,
  explainReasoningEffort,
  reasoningWasEmitted,
} from '../src/utils/reasoningSupport';

describe('resolveReasoningEffort', () => {
  it('anthropic--claude-4.8-opus: every one of the five efforts produces the adaptive shape carrying it', () => {
    const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
    for (const effort of efforts) {
      expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.8-opus', effort })).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort },
      });
    }
  });

  it('anthropic--claude-4.5-sonnet: every one of the five efforts maps to its own budget_tokens, no output_config', () => {
    // maxTokens well above double every mapped budget (max is xhigh's 32768,
    // so half of maxTokens must clear that) so nothing here exercises
    // clamping -- this pins each of the five EFFORT_TO_BUDGET_TOKENS rows
    // individually, not just medium.
    const expectedBudgets: Record<string, number> = {
      minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768,
    };
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.5-sonnet', effort, maxTokens: 70000,
      })).toEqual({
        thinking: { type: 'enabled', budget_tokens: expectedBudgets[effort] },
      });
    }
  });

  it('an adaptive-shape model with max_tokens absent still emits the adaptive shape', () => {
    // The adaptive branch never reads maxTokens -- absent must not suppress it.
    expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.8-opus', effort: 'medium' })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });

  it('an adaptive-shape model refuses below max_tokens: 2048, same threshold as the budget shape', () => {
    // See the MIN_MAX_TOKENS_FOR_THINKING comment in reasoningSupport.ts --
    // measured live (reasoning-probe-results.md, "Adaptive thinking
    // truncates answers on a small max_output_tokens"): a request that
    // completes today comes back TRUNC (incomplete: max_output_tokens) once
    // adaptive thinking is on, below this boundary.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.8-opus', effort: 'medium', maxTokens: 2047,
    })).toEqual({});
  });

  it('an adaptive-shape model emits normally AT max_tokens: 2048 -- refusal only below the threshold', () => {
    // Non-discriminating alone (the pre-fix adaptive branch ignores maxTokens
    // entirely, so it would also emit here) -- paired with the 2047 case
    // immediately above, which IS discriminating, to prove the boundary is
    // exactly 2048 and not some neighbouring value.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.8-opus', effort: 'medium', maxTokens: 2048,
    })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });

  it('anthropic--claude-4.7-opus + high: nothing — it accepts adaptive (HTTP 200) but never produced reasoning_content', () => {
    expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.7-opus', effort: 'high', maxTokens: 16384 }))
      .toEqual({});
  });

  it('gpt-5.5 + medium: nothing — non-Anthropic models are absent from the map entirely', () => {
    expect(resolveReasoningEffort({ modelName: 'gpt-5.5', effort: 'medium', maxTokens: 16384 })).toEqual({});
  });

  it('an unmapped Anthropic model name: nothing — absent from the table means unmeasured, not permitted', () => {
    expect(resolveReasoningEffort({ modelName: 'anthropic--claude-9-opus', effort: 'medium', maxTokens: 16384 }))
      .toEqual({});
  });

  it('an unknown effort value on a supported model: nothing, never a guessed nearest neighbour', () => {
    expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.8-opus', effort: 'turbo' })).toEqual({});
    expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.5-sonnet', effort: 'turbo', maxTokens: 16384 }))
      .toEqual({});
  });

  it('clamps budget_tokens to leave HALF of max_tokens for the answer', () => {
    // xhigh maps to 32768, far above max_tokens (4096) -- clamped to
    // floor(max_tokens / 2), i.e. 2048. NOT max_tokens - 1024 (an earlier,
    // corrected version of this clamp): that reserved only a flat 1024 for
    // the answer regardless of max_tokens, so on this exact input it sent
    // budget_tokens: 3072, leaving just 1024 of the client's 4096-token
    // budget for the actual answer -- and thinking bills inside completion
    // tokens on this path, so a turn that finished today could come back
    // truncated after this feature shipped.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-opus', effort: 'xhigh', maxTokens: 4096,
    })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('resolves to exactly the 1024 floor at the max_tokens: 2048 boundary', () => {
    // floor(2048 / 2) = 1024 -- AT the floor, so this still emits (unlike
    // 2047 below, which lands one short of it).
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 2048,
    })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
  });

  it('emits nothing when the clamped budget would fall below the 1024 floor', () => {
    // medium maps to 8192, clamped to floor(512 / 2) = 256 -- below the floor, so nothing.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-haiku', effort: 'medium', maxTokens: 512,
    })).toEqual({});
  });

  it('emits nothing when max_tokens is below the 2048 floor implied by halving', () => {
    // floor(2047 / 2) = 1023, one short of the 1024 floor -- the boundary the
    // clamp-below-floor case above doesn't pin on its own, and the mirror of
    // the 2048-boundary test above.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-sonnet', effort: 'minimal', maxTokens: 2047,
    })).toEqual({});
  });

  it('emits the UNCLAMPED mapped budget when max_tokens is absent', () => {
    // This branch used to refuse, which made it dead for real traffic: every
    // request that carries reasoning.effort sends no max_output_tokens.
    // Measured with none sent -- every mapped budget from 1024 to 32768
    // completed on 4.5-sonnet/opus/haiku, and SAP's own ceiling is 64000, so
    // there is nothing to clamp against and nothing to protect.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium',
    })).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } });
  });

  it('does not halve the budget when max_tokens is absent -- xhigh goes out whole', () => {
    // Guards the specific regression of routing the absent case through the
    // halving path with some invented ceiling: that would send 32000 here.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-haiku', effort: 'xhigh',
    })).toEqual({ thinking: { type: 'enabled', budget_tokens: 32768 } });
  });

  it('emits nothing for a non-integer max_tokens (fractional or NaN), never an unclamped or fractional budget', () => {
    // Number.isInteger rules both out. NaN in particular would otherwise skip
    // the clamp comparisons silently (any comparison against NaN is false)
    // and fall through to the unclamped mapped value.
    //
    // 4001.5, not a value like 1500.5: floor(1500.5/2)=750 is already below
    // the 1024 floor on its own, so that value would return {} even under the
    // old `typeof === 'number'` guard -- it pins nothing about Number.isInteger
    // specifically. floor(4001.5/2)=2000 clears the floor, so under the old
    // guard this would return budget_tokens: 2000, not {} -- only the
    // Number.isInteger guard makes this one {}.
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 4001.5,
    })).toEqual({});
    expect(resolveReasoningEffort({
      modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: NaN,
    })).toEqual({});
  });

  it('does not resolve for a model name reaching an inherited Object.prototype key', () => {
    // 'constructor' is not in MODEL_REASONING_SUPPORT, but a naive
    // `support === undefined` guard would see MODEL_REASONING_SUPPORT.constructor
    // (the Object constructor function, not undefined) and fall through into
    // the budget branch for a model that was never measured.
    expect(resolveReasoningEffort({
      modelName: 'constructor', effort: 'medium', maxTokens: 16384,
    })).toEqual({});
  });

  describe('incompatible sampling params suppress thinking on both shapes', () => {
    // Measured live: the same request WITHOUT thinking succeeds today (200)
    // for both temperature:0.2 and top_p:0.9, so silently keeping thinking on
    // here would turn a working request into a live 400 -- see
    // hasIncompatibleSampling's comment in reasoningSupport.ts for the
    // verbatim SAP errors this guards against.
    //
    // The four "does not suppress" / "imposes no constraint" cases below
    // (temperature:1, top_p:0.95, top_p:1, both absent) pass against a
    // resolver with NO sampling guard at all -- they document the compatible
    // boundary rather than pinning the guard's existence. They are kept
    // anyway, as boundary documentation, not deleted: what makes the boundary
    // itself falsifiable is the neighbour immediately on the suppress side of
    // each one (0.999 instead of 1, 0.949 instead of 0.95), added below --
    // together each pair proves the guard checks an exact threshold, not a
    // range or nothing at all. (top_p:1 has no dedicated suppress-side
    // neighbour of its own -- it shares 0.949's, being further from 0.95 on
    // the same compatible side.)

    it('temperature other than 1 suppresses thinking, on the budget shape', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 16384, temperature: 0.2,
      })).toEqual({});
    });

    it('temperature 0.999 -- one thousandth off exact -- still suppresses (this is an equality check, not a range)', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 16384, temperature: 0.999,
      })).toEqual({});
    });

    it('temperature exactly 1 does not suppress thinking', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 16384, temperature: 1,
      })).toEqual({
        thinking: { type: 'enabled', budget_tokens: 8192 },
      });
    });

    it('top_p below 0.95 suppresses thinking, on the adaptive shape', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.6-opus', effort: 'medium', topP: 0.9,
      })).toEqual({});
    });

    it('top_p 0.949 -- one thousandth under the threshold -- still suppresses', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.6-opus', effort: 'medium', topP: 0.949,
      })).toEqual({});
    });

    it('top_p at exactly 0.95 does not suppress thinking', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.6-opus', effort: 'medium', topP: 0.95,
      })).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      });
    });

    it('top_p above the threshold (1) does not suppress thinking either', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.6-opus', effort: 'medium', topP: 1,
      })).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      });
    });

    it('both absent imposes no constraint', () => {
      expect(resolveReasoningEffort({ modelName: 'anthropic--claude-4.8-opus', effort: 'medium' })).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      });
    });
  });

  describe('tool_choice: "required" suppresses thinking on every model, including 4.8-opus', () => {
    // Measured live: 'required' + thinking 400s on 4.5-sonnet (budget) and
    // 4.6-opus (adaptive) with an identical error, while the same request
    // without thinking succeeds today -- see isForcedToolChoice's comment in
    // reasoningSupport.ts for the verbatim error and why 4.8-opus (measured
    // to PASS with 'required' + thinking) is suppressed anyway: two data
    // points is not enough to carve a per-model exception into a boundary
    // that has already proven ragged once.

    it('the exact string "required" suppresses, on the budget shape', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.5-sonnet', effort: 'medium', maxTokens: 16384, toolChoice: 'required',
      })).toEqual({});
    });

    it('"required" suppresses on 4.8-opus too, despite that model measuring compatible', () => {
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.8-opus', effort: 'medium', toolChoice: 'required',
      })).toEqual({});
    });

    it('"auto", "none", the function-choice object form, and absent all do not suppress', () => {
      const expected = { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } };
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.8-opus', effort: 'medium', toolChoice: 'auto',
      })).toEqual(expected);
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.8-opus', effort: 'medium', toolChoice: 'none',
      })).toEqual(expected);
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.8-opus', effort: 'medium',
        toolChoice: { type: 'function', name: 'x' },
      })).toEqual(expected);
      expect(resolveReasoningEffort({
        modelName: 'anthropic--claude-4.8-opus', effort: 'medium',
      })).toEqual(expected);
    });
  });
});

/**
 * explainReasoningEffort exists so a decline can be logged with its reason.
 * Its value is only as good as its agreement with resolveReasoningEffort, so
 * the load-bearing test here is the last one: every case asserted above is
 * re-run through BOTH functions and checked for consistency. A reason that
 * drifts from the decision it explains is worse than no reason at all.
 */
describe('explainReasoningEffort', () => {
  const M45 = 'anthropic--claude-4.5-sonnet';
  const M48 = 'anthropic--claude-4.8-opus';

  it('names each decline reason distinctly', () => {
    expect(explainReasoningEffort({ modelName: M48 })).toBe('no-effort');
    expect(explainReasoningEffort({ modelName: M48, effort: 'turbo' })).toBe('unknown-effort');
    expect(explainReasoningEffort({ modelName: M48, effort: 'medium', temperature: 0.2 }))
      .toBe('incompatible-sampling');
    expect(explainReasoningEffort({ modelName: M48, effort: 'medium', topP: 0.9 }))
      .toBe('incompatible-sampling');
    expect(explainReasoningEffort({ modelName: M48, effort: 'medium', toolChoice: 'required' }))
      .toBe('forced-tool-choice');
    expect(explainReasoningEffort({ modelName: 'anthropic--claude-4.7-opus', effort: 'medium' }))
      .toBe('model-not-supported');
    expect(explainReasoningEffort({ modelName: 'gpt-5.5', effort: 'medium' }))
      .toBe('model-not-supported');
    expect(explainReasoningEffort({ modelName: M48, effort: 'medium', maxTokens: 2047 }))
      .toBe('max-tokens-too-small');
    expect(explainReasoningEffort({ modelName: M45, effort: 'medium', maxTokens: 4001.5 }))
      .toBe('max-tokens-not-an-integer');
  });

  it('names the two emitting decisions', () => {
    expect(explainReasoningEffort({ modelName: M48, effort: 'medium' })).toBe('adaptive');
    expect(explainReasoningEffort({ modelName: M45, effort: 'medium' })).toBe('budget');
  });

  it('reasoningWasEmitted agrees with the emitting decisions only', () => {
    expect(reasoningWasEmitted('adaptive')).toBe(true);
    expect(reasoningWasEmitted('budget')).toBe(true);
    expect(reasoningWasEmitted('no-effort')).toBe(false);
    expect(reasoningWasEmitted('model-not-supported')).toBe(false);
    expect(reasoningWasEmitted('max-tokens-too-small')).toBe(false);
  });

  it('never disagrees with resolveReasoningEffort about whether anything was emitted', () => {
    // The whole point of the shared `decide` helper. Sweeping the inputs that
    // matter rather than a hand-picked few: if a future edit adds a guard to
    // one wrapper and not the other, this fails.
    const models = [M48, M45, 'anthropic--claude-4.6-opus', 'anthropic--claude-4.7-opus',
                    'anthropic--claude-4.5-haiku', 'gpt-5.5', 'constructor', 'unknown--model'];
    const efforts = [undefined, 'minimal', 'medium', 'xhigh', 'turbo'];
    const maxes = [undefined, 512, 2047, 2048, 4096, 4001.5, NaN, 40000];
    const temps = [undefined, 1, 0.2];
    const topPs = [undefined, 0.95, 0.9];
    const choices = [undefined, 'auto', 'required', { type: 'function', name: 'x' }];

    let checked = 0;
    for (const modelName of models) {
      for (const effort of efforts) {
        for (const maxTokens of maxes) {
          for (const temperature of temps) {
            for (const topP of topPs) {
              for (const toolChoice of choices) {
                const input = { modelName, effort, maxTokens, temperature, topP, toolChoice };
                const emitted = Object.keys(resolveReasoningEffort(input)).length > 0;
                expect(reasoningWasEmitted(explainReasoningEffort(input))).toBe(emitted);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(models.length * efforts.length * maxes.length
                         * temps.length * topPs.length * choices.length);
  });
});
