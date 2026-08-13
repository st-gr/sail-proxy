const rules = require('../src/plugins/responsesCustomToolsPlugin');
const configService = require('../src/services/configService').default;

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const before = rules.find((r: any) => r.strategy === 'before').handler;

/** Drive the interceptor by running the before handler on a streaming request. */
function makeStream() {
  const written: string[] = [];
  const res: any = {
    write: (c: any) => { written.push(String(c)); return true; },
    end: (...a: any[]) => a,
  };
  return { res, written };
}
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
const parseAll = (written: string[]) => written.join('')
  .split('\n\n').filter((b) => b.startsWith('data: '))
  .map((b) => JSON.parse(b.slice(6)));

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('translate');
});

describe('custom tool streaming interceptor', () => {
  async function install() {
    const { res, written } = makeStream();
    await before({
      req: { body: { stream: true, tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] } } as any,
      res, utils: { logger },
    });
    return { res, written };
  }

  it('rewrites the added item and converts the argument stream into custom input frames', async () => {
    const { res, written } = await install();

    res.write(frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"input":"*** Beg' }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'in Patch\\n"}' }));
    res.write(frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"input":"*** Begin Patch\\n"}' }));
    res.write(frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n"}' } }));

    const events = parseAll(written);
    const types = events.map((e) => e.type);

    expect(types).not.toContain('response.function_call_arguments.delta');
    expect(types).not.toContain('response.function_call_arguments.done');
    expect(types).toContain('response.custom_tool_call_input.delta');
    expect(types).toContain('response.custom_tool_call_input.done');

    expect(events[0].item.type).toBe('custom_tool_call');
    expect(events.find((e) => e.type === 'response.custom_tool_call_input.done').input)
      .toBe('*** Begin Patch\n');
    const doneItem = events[events.length - 1].item;
    expect(doneItem.type).toBe('custom_tool_call');
    expect(doneItem.input).toBe('*** Begin Patch\n');
  });

  it('rewrites the terminal frame output array', async () => {
    const { res, written } = await install();
    res.write(frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
    res.write(frame({ type: 'response.completed', response: { output: [
      { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '{"input":"P"}' },
    ] } }));
    const events = parseAll(written);
    const terminal = events.find((e) => e.type === 'response.completed');
    expect(terminal.response.output[0].type).toBe('custom_tool_call');
    expect(terminal.response.output[0].input).toBe('P');
  });

  // A no-op interceptor trivially satisfies plain byte-identity (it forwards everything
  // unchanged), so this must also assert the OTHER frame in the same stream really was
  // rewritten — otherwise a stub passes this test. It also has to use event:/id: lines,
  // since a `data:`-only block cannot show whether a rewrite preserved them.
  it('passes an untranslated frame through byte-for-byte, event:/id: lines included, ' +
    'while a translated call in the same stream is rewritten', async () => {
    const { res, written } = await install();
    const untouched = `event: response.function_call_arguments.delta\nid: 7\n`
      + `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 3, delta: '{"cmd":"ls"}' })}\n\n`;
    const added = frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } });

    res.write(added);
    res.write(untouched);

    const raw = written.join('');
    expect(raw).toContain(untouched);                       // byte-identical, event:/id: lines included

    const events = parseAll(written);
    expect(events[0].item.type).toBe('custom_tool_call');    // the translated call WAS rewritten
  });

  it('handles a frame split across two writes', async () => {
    const { res, written } = await install();
    const whole = frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } });
    res.write(whole.slice(0, 25));
    res.write(whole.slice(25));
    const events = parseAll(written);
    expect(events[0].item.type).toBe('custom_tool_call');
  });

  it('flushes a trailing partial block with no terminator on end()', async () => {
    const { res, written } = await install();
    const whole = frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } });

    res.write(whole.slice(0, -2));                          // everything but the trailing \n\n
    expect(written).toHaveLength(0);                        // held back entirely as a partial block

    res.end();

    const events = parseAll(written);
    expect(events[0].item.type).toBe('custom_tool_call');
  });

  it('flushes buffered arguments through the same synthesis when function_call_arguments.done ' +
    'never arrives (e.g. a cancelled turn), and warns', async () => {
    const { res, written } = await install();

    res.write(frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"input":"*** Beg' }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'in Patch' }));
    // The stream stops here — no function_call_arguments.done, no output_item.done, no
    // terminal frame — exactly what a client cancellation looks like.

    res.end();

    const events = parseAll(written);
    const deltaEvent = events.find((e) => e.type === 'response.custom_tool_call_input.delta');
    const doneEvent = events.find((e) => e.type === 'response.custom_tool_call_input.done');
    expect(deltaEvent).toBeDefined();
    expect(doneEvent).toBeDefined();
    // The arguments never closed their JSON, so JSON.parse fails and the raw partial
    // text is what passes through — still better than losing it outright.
    expect(doneEvent.input).toBe('{"input":"*** Begin Patch');
    expect(logger.warn).toHaveBeenCalled();
  });

  // The two previous tests each cover ONE of patchedEnd's two flushes in isolation:
  // a trailing partial block with nothing buffered, or buffered args with no partial
  // tail. Neither exercises them landing on the wire together, which is exactly where
  // the tail's missing `\n\n` terminator would run straight into the flushed synthetic
  // frames with no separator between them, corrupting the frame boundary.
  it('keeps every frame independently parseable when a trailing partial block and ' +
    'non-empty buffered arguments coincide at end()', async () => {
    const { res, written } = await install();

    res.write(frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"input":"partial' }));

    // An unrelated frame that never finished arriving — held back as `tail`, exactly
    // like a connection dying mid-write of some other event.
    const trailing = frame({ type: 'response.output_text.delta', output_index: 1, delta: 'hello' });
    res.write(trailing.slice(0, -2));                        // everything but the trailing \n\n

    res.end();

    const raw = written.join('');
    const blocks = raw.split('\n\n').map((b) => b.trim()).filter((b) => b.length > 0);
    // Every block the client receives must parse as JSON on its own. If the tail block
    // and a flushed synthetic frame ran together with no separator, one of these throws
    // "Unexpected non-whitespace character after JSON" instead.
    const events = blocks.map((b) => JSON.parse(b.slice(6)));

    expect(events.some((e) => e.type === 'response.output_text.delta')).toBe(true);
    expect(events.some((e) => e.type === 'response.custom_tool_call_input.delta')).toBe(true);
    expect(events.some((e) => e.type === 'response.custom_tool_call_input.done')).toBe(true);
  });

  // The orchestration bridge (streamTranslator.ts) never sends function_call_arguments.*
  // at all: for every tool call it emits exactly output_item.added then output_item.done
  // back to back, both carrying the complete arguments — no delta, no .done for it. That
  // leaves `buffered[idx]` still present (set to '' at output_item.added) but genuinely
  // empty by the time output_item.done lands, which is this route's NORMAL shape, not an
  // out-of-order upstream. Presence alone must not warn — only a non-empty leftover may.
  it('restores the item with no function_call_arguments.* frames at all (orchestration ' +
    'shape), and does not warn', async () => {
    const { res, written } = await install();

    res.write(frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch',
        arguments: '{"input":"*** Begin Patch\\n"}' } }));
    res.write(frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch',
        arguments: '{"input":"*** Begin Patch\\n"}' } }));

    const events = parseAll(written);
    const doneItem = events[events.length - 1].item;
    expect(doneItem.type).toBe('custom_tool_call');
    expect(doneItem.input).toBe('*** Begin Patch\n');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe('write callback invariant', () => {
    // pseudonymizationPlugin's interceptor sits directly below this one and deliberately
    // pops the write callback so "it must fire even when we buffer". This interceptor
    // must not swallow the argument before it ever gets there.
    function callbackCapturingStream() {
      const seen: any[][] = [];
      const res: any = {
        write: (_c: any, ...rest: any[]) => { seen.push(rest); return true; },
        end: (...a: any[]) => a,
      };
      return { res, seen };
    }
    async function installOn(res: any) {
      await before({
        req: { body: { stream: true, tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] } } as any,
        res, utils: { logger },
      });
    }

    it('fires exactly once when every block in a write is suppressed', async () => {
      const { res, seen } = callbackCapturingStream();
      await installOn(res);

      // Register the call first so the delta below is tracked, and thus suppressed.
      res.write(frame({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
      expect(seen).toHaveLength(1);                         // the added frame itself passed through

      const cb = jest.fn();
      res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'x' }), cb);

      expect(seen).toHaveLength(1);                         // nothing new reached the layer below
      expect(cb).toHaveBeenCalledTimes(1);                  // but the callback still fired
    });

    it('fires exactly once, on the last block, when one incoming block expands into several', async () => {
      const { res, seen } = callbackCapturingStream();
      await installOn(res);

      res.write(frame({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: '' } }));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([]);                          // no callback on the added-frame write

      const cb = jest.fn();
      res.write(frame({ type: 'response.function_call_arguments.done', output_index: 0,
        arguments: '{"input":"hi"}' }), cb);

      // The .done frame expands into two synthesised frames: delta then done.
      expect(seen).toHaveLength(3);
      expect(seen[1]).toEqual([]);                          // not on the first synthesised block
      expect(seen[2]).toEqual([cb]);                        // once, on the last
    });
  });

  describe('strip mode', () => {
    // Strip governs only the declaration, but the before handler ALSO decides whether to
    // install the streaming interceptor at all — no translated names means nothing for it
    // to restore, so a stripped request must reach the client with res.write untouched.
    it('installs no interceptor on a streaming request', async () => {
      jest.spyOn(configService, 'getCustomToolMode').mockReturnValue('strip');
      const { res } = makeStream();
      const originalWrite = res.write;

      await before({
        req: { body: { stream: true, tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }] } } as any,
        res, utils: { logger },
      });

      expect(res.write).toBe(originalWrite);
    });
  });
});
