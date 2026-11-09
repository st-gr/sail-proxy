/**
 * Gemini `generateContent` request -> SAP orchestration payload.
 *
 * The bridge's request half. Orchestration speaks OpenAI chat shape, so this
 * is a semantics translation: `contents[]` turns become chat messages,
 * `tools[].functionDeclarations` become chat function tools, and
 * `generationConfig` becomes `model.params`. Gemini carries NO tool-call ids,
 * so the translator mints them (`c<turn:5><part:3>`, nine alphanumerics for Mistral) and matches a
 * `functionResponse` to the preceding turn's calls BY ORDER.
 *
 * Anything the translator cannot express throws `UnsupportedGeminiInputError`
 * carrying the item's path — the controller turns that into a 400
 * INVALID_ARGUMENT that names the offending item, instead of forwarding
 * something orchestration would reject with a message about neither.
 */
import { describe, it, expect } from '@jest/globals';
import {
  geminiContentsToMessages,
  geminiGenerationConfigToParams,
  geminiToOrchestrationPayload,
  geminiToolsToOrchestration,
  UnsupportedGeminiInputError,
} from '../src/google/orchestrationBridge/requestTranslator';
import { buildOrchestrationPayload } from '../src/responses/orchestrationBridge/requestTranslator';
import { resolveReasoningEffort } from '../src/utils/reasoningSupport';

/** A model in reasoningSupport's measured table, so effort actually resolves. */
const ADAPTIVE_MODEL = 'anthropic--claude-4.8-opus';

describe('geminiContentsToMessages', () => {
  const badContents: Array<{ name: string; body: any }> = [
    { name: 'missing', body: { systemInstruction: { parts: [{ text: 'be brief' }] } } },
    { name: 'a single Content object rather than an array', body: { contents: { role: 'user', parts: [{ text: 'hi' }] } } },
    { name: 'an empty array', body: { contents: [] } },
  ];

  it.each(badContents)('throws when contents is $name', ({ body }) => {
    // Without the guard these produce a payload carrying nothing but the
    // system message, and the model answers a turn nobody sent.
    let err: any;
    try {
      geminiContentsToMessages(body);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents');
  });

  it('turns a text-only user turn into one user message with block content', () => {
    // Blocks, not a plain string, for the same reason responsesInputToMessages
    // emits blocks: a string has nowhere to hang a cache_control breakpoint.
    expect(geminiContentsToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('puts systemInstruction first as a system message, its parts joined with a newline', () => {
    const msgs = geminiContentsToMessages({
      systemInstruction: { parts: [{ text: 'be brief' }, { text: 'be kind' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(msgs[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be brief\nbe kind' }] });
    expect(msgs[1].role).toBe('user');
  });

  it('accepts a bare-string systemInstruction rather than dropping the system prompt', () => {
    // Several Gemini SDK versions allow the string form; silently losing a
    // system prompt is the one failure mode this bridge must not have.
    expect(geminiContentsToMessages({
      systemInstruction: 'be brief',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be brief' }] });
  });

  it('maps the `model` role to `assistant` across a multi-turn history, in order', () => {
    const msgs = geminiContentsToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'q1' }] },
        { role: 'model', parts: [{ text: 'a1' }] },
        { role: 'user', parts: [{ text: 'q2' }] },
      ],
    });
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs.map((m: any) => m.content[0].text)).toEqual(['q1', 'a1', 'q2']);
  });

  it('turns an inline image into the image_url data-URI block orchestration accepts', () => {
    // The shape the Responses bridge measured live against orchestration:
    // `{type:'image_url', image_url:{url:'data:image/...'}}`, never
    // Anthropic's `{type:'image', source:{...}}`.
    expect(geminiContentsToMessages({
      contents: [{
        role: 'user',
        parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'AAAB' } }],
      }],
    })).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
      ],
    }]);
  });

  it('throws for non-image inlineData, naming the part path', () => {
    // Audio has no orchestration content block; dropping it would make the
    // model answer a question the user did not ask.
    let err: any;
    try {
      geminiContentsToMessages({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAB' } }] }],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents[0].parts[0].inlineData');
  });

  it('throws for fileData, naming the part path', () => {
    // A Files-API reference the gateway cannot resolve: this translator is
    // pure (no I/O), so there is nothing to inline.
    let err: any;
    try {
      geminiContentsToMessages({
        contents: [{
          role: 'user',
          parts: [{ text: 'summarise' }, { fileData: { mimeType: 'application/pdf', fileUri: 'files/abc' } }],
        }],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents[0].parts[1].fileData');
  });

  it('turns a functionCall in a model turn into assistant tool_calls with a minted id and stringified args', () => {
    // Gemini carries no ids: `c<turn:5><part:3>` is minted here and
    // is the ONLY thing the following functionResponse can be keyed to.
    // content is '' (never []) — orchestration 400s on an empty block array.
    const msgs = geminiContentsToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
      ],
    });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c00001000',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
      }],
    });
  });

  it('keeps a model turn\'s text alongside its tool_calls', () => {
    const msgs = geminiContentsToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ text: 'checking' }, { functionCall: { name: 'get_weather', args: {} } }] },
      ],
    });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking' }],
      tool_calls: [{
        id: 'c00001001',
        type: 'function',
        function: { name: 'get_weather', arguments: '{}' },
      }],
    });
  });

  it('matches a functionResponse in the next user turn to the preceding call, by order', () => {
    // A tool message's content must be a plain STRING — orchestration's
    // Anthropic harmonization step rejects block content there.
    const msgs = geminiContentsToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Berlin' } } },
            { functionCall: { name: 'get_time', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_weather', response: { c: 21 } } },
            { functionResponse: { name: 'get_time', response: { t: '10:00' } } },
          ],
        },
      ],
    });
    expect(msgs.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'c00001000', content: '{"c":21}' },
      { role: 'tool', tool_call_id: 'c00001001', content: '{"t":"10:00"}' },
    ]);
  });

  it('matches two calls answered by two consecutive single-response user turns', () => {
    // A client is free to send one functionResponse per Content. The pending
    // ids survive a turn that is nothing but tool results, so the second turn
    // matches the SECOND call instead of starting over at the first.
    const msgs = geminiContentsToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'weather and time?' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: {} } },
            { functionCall: { name: 'get_time', args: {} } },
          ],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { c: 21 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_time', response: { t: '10:00' } } }] },
      ],
    });
    expect(msgs.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'c00001000', content: '{"c":21}' },
      { role: 'tool', tool_call_id: 'c00001001', content: '{"t":"10:00"}' },
    ]);
  });

  it('leaves a functionResponse orphaned once the user has said something else', () => {
    // Only a turn of PURE tool results keeps the round trip open; a text turn
    // closes it, and a response arriving after that answers nothing.
    let err: any;
    try {
      geminiContentsToMessages({
        contents: [
          { role: 'user', parts: [{ text: 'weather?' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
          { role: 'user', parts: [{ text: 'actually, never mind' }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { c: 21 } } }] },
        ],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents[3].parts[0].functionResponse');
  });

  it('throws for a functionResponse with no preceding functionCall to match', () => {
    let err: any;
    try {
      geminiContentsToMessages({
        contents: [
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { c: 21 } } }] },
        ],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents[0].parts[0].functionResponse');
  });

  it('throws when a user turn carries MORE functionResponses than the preceding turn had calls', () => {
    let err: any;
    try {
      geminiContentsToMessages({
        contents: [
          { role: 'user', parts: [{ text: 'weather?' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'get_weather', response: { c: 21 } } },
              { functionResponse: { name: 'get_time', response: { t: '10:00' } } },
            ],
          },
        ],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('contents[2].parts[1].functionResponse');
  });
});

describe('geminiToolsToOrchestration', () => {
  it('nests functionDeclarations under the chat `function` shape', () => {
    expect(geminiToolsToOrchestration({
      tools: [{
        functionDeclarations: [
          { name: 'get_weather', description: 'weather by city', parameters: { type: 'object' } },
        ],
      }],
    }).tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'weather by city', parameters: { type: 'object' } },
      },
    ]);
  });

  it('accepts parametersJsonSchema as the same thing as parameters', () => {
    expect(geminiToolsToOrchestration({
      tools: [{ functionDeclarations: [{ name: 'ls', parametersJsonSchema: { type: 'object' } }] }],
    }).tools).toEqual([
      { type: 'function', function: { name: 'ls', parameters: { type: 'object' } } },
    ]);
  });

  it('flattens declarations from several tool entries into one list', () => {
    expect(geminiToolsToOrchestration({
      tools: [
        { functionDeclarations: [{ name: 'a' }] },
        { functionDeclarations: [{ name: 'b' }] },
      ],
    }).tools!.map((t: any) => t.function.name)).toEqual(['a', 'b']);
  });

  it('throws for a hosted tool, naming its path', () => {
    // googleSearch/codeExecution run inside Google's own serving stack; the
    // orchestration bridge has nothing to run them with.
    let err: any;
    try {
      geminiToolsToOrchestration({ tools: [{ googleSearch: {} }] });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('tools[0].googleSearch');
    expect(String(err.message)).toMatch(/hosted tools are not available on this gateway/);
  });

  it('ignores a hosted-tool key that is present but null', () => {
    // An SDK that builds the entry from a fixed shape leaves the slots it did
    // not fill as null; that declares no hosted tool and must not be refused.
    expect(geminiToolsToOrchestration({
      tools: [{ functionDeclarations: [{ name: 'get_weather' }], googleSearch: null }],
    }).tools).toEqual([
      { type: 'function', function: { name: 'get_weather' } },
    ]);
  });

  const toolChoiceCases: Array<{ name: string; toolConfig: any; expected: any }> = [
    { name: 'AUTO -> auto', toolConfig: { functionCallingConfig: { mode: 'AUTO' } }, expected: 'auto' },
    { name: 'ANY -> required', toolConfig: { functionCallingConfig: { mode: 'ANY' } }, expected: 'required' },
    { name: 'NONE -> none', toolConfig: { functionCallingConfig: { mode: 'NONE' } }, expected: 'none' },
    {
      name: 'ANY with exactly one allowed name -> that function',
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
      expected: { type: 'function', function: { name: 'get_weather' } },
    },
    {
      name: 'ANY with several allowed names -> required (chat cannot express a subset)',
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'b'] } },
      expected: 'required',
    },
  ];

  it.each(toolChoiceCases)('toolConfig $name', ({ toolConfig, expected }) => {
    expect(geminiToolsToOrchestration({ toolConfig }).tool_choice).toEqual(expected);
  });

  it('leaves tool_choice unset when there is no toolConfig', () => {
    expect(geminiToolsToOrchestration({ tools: [{ functionDeclarations: [{ name: 'a' }] }] }).tool_choice)
      .toBeUndefined();
  });
});

describe('geminiGenerationConfigToParams', () => {
  it('maps the sampling and length keys onto their chat names', () => {
    const { params } = geminiGenerationConfigToParams({
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 256,
        stopSequences: ['STOP'],
      },
    }, 'm');
    expect(params).toEqual({ temperature: 0.2, top_p: 0.9, max_tokens: 256, stop: ['STOP'] });
  });

  it('ignores the keys orchestration has no equivalent for', () => {
    // topK / seed / penalties / safetySettings are documented as dropped —
    // pinned so a later "helpful" pass-through has to change this test.
    const { params } = geminiGenerationConfigToParams({
      generationConfig: { topK: 40, seed: 7, presencePenalty: 1, frequencyPenalty: 1 },
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    }, 'm');
    expect(params).toEqual({});
  });

  it('throws for candidateCount > 1', () => {
    // Orchestration returns one choice; silently answering with one candidate
    // when two were asked for is a wrong answer, not a degraded one.
    let err: any;
    try {
      geminiGenerationConfigToParams({ generationConfig: { candidateCount: 2 } }, 'm');
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedGeminiInputError);
    expect(err.path).toBe('generationConfig.candidateCount');
  });

  it('accepts candidateCount 1', () => {
    expect(geminiGenerationConfigToParams({ generationConfig: { candidateCount: 1 } }, 'm').params)
      .toEqual({});
  });

  it('maps responseMimeType application/json to a json_object response_format', () => {
    expect(geminiGenerationConfigToParams({
      generationConfig: { responseMimeType: 'application/json' },
    }, 'm').response_format).toEqual({ type: 'json_object' });
  });

  it('maps responseSchema to a json_schema response_format', () => {
    expect(geminiGenerationConfigToParams({
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    }, 'm').response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object', properties: { a: { type: 'string' } } } },
    });
  });

  it('maps responseJsonSchema the same way as responseSchema', () => {
    expect(geminiGenerationConfigToParams({
      generationConfig: { responseJsonSchema: { type: 'object' } },
    }, 'm').response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object' } },
    });
  });

  it('leaves response_format unset without a responseMimeType or schema', () => {
    expect(geminiGenerationConfigToParams({ generationConfig: { temperature: 1 } }, 'm').response_format)
      .toBeUndefined();
  });

  describe('thinkingConfig.thinkingBudget -> reasoning effort', () => {
    const budgetCases: Array<{ budget: number; effort: string }> = [
      { budget: 0, effort: 'minimal' },
      { budget: 512, effort: 'low' },
      { budget: 1024, effort: 'low' },
      { budget: 4096, effort: 'medium' },
      { budget: 20000, effort: 'high' },
      { budget: -1, effort: 'medium' },
    ];

    it.each(budgetCases)('budget $budget -> effort $effort', ({ budget, effort }) => {
      const { params } = geminiGenerationConfigToParams({
        generationConfig: { thinkingConfig: { thinkingBudget: budget } },
      }, ADAPTIVE_MODEL);
      const expected = resolveReasoningEffort({ modelName: ADAPTIVE_MODEL, effort });
      // Non-vacuous: this model resolves every effort to a real fragment, so
      // an all-empty comparison cannot pass by accident.
      expect(expected).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort } });
      expect(params).toEqual(expected);
    });

    it('emits no thinking key when thinkingConfig is absent', () => {
      expect(geminiGenerationConfigToParams({ generationConfig: { temperature: 1 } }, ADAPTIVE_MODEL).params)
        .toEqual({ temperature: 1 });
    });

    it('lets resolveReasoningEffort suppress thinking on a forced tool choice, keeping tool_choice', () => {
      // toolConfig ANY -> tool_choice 'required', which reasoningSupport
      // measured as incompatible with thinking on five of six models.
      const { params } = geminiGenerationConfigToParams({
        generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      }, ADAPTIVE_MODEL);
      expect(params.tool_choice).toBe('required');
      expect(params.thinking).toBeUndefined();
      expect(params.output_config).toBeUndefined();
    });
  });
});

describe('geminiToOrchestrationPayload', () => {
  const body = {
    systemInstruction: { parts: [{ text: 'be brief' }] },
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  };

  it('builds the same envelope buildOrchestrationPayload builds for an equivalent Responses body', () => {
    // The envelope — template/messages_history split, model.name/version,
    // placeholder_values, the stream flag — is shared, not re-derived here.
    for (const stream of [false, true]) {
      const gemini = geminiToOrchestrationPayload(body, { modelName: 'm', stream });
      const responses: any = buildOrchestrationPayload(
        { instructions: 'be brief', input: 'hello' }, { modelName: 'm', stream });
      // identical envelopes, except that the Gemini bridge also asks orchestration for
      // 200-character stream chunks (the chat-completions path's size) instead of the 800 default
      const expected = stream
        ? { ...responses, config: { ...responses.config, stream: { ...responses.config.stream, chunk_size: 200 } } }
        : responses;
      expect(gemini).toEqual(expected);
    }
  });

  it('names the model and sets the streaming flag exactly as the shared envelope does', () => {
    const off: any = geminiToOrchestrationPayload(body, { modelName: 'gemini-2.5-pro', stream: false });
    const on: any = geminiToOrchestrationPayload(body, { modelName: 'gemini-2.5-pro', stream: true });
    expect(off.config.modules.prompt_templating.model.name).toBe('gemini-2.5-pro');
    expect(off.config.modules.prompt_templating.model.version).toBe('latest');
    expect(off.config.stream).toBeUndefined();
    // enabled like the Responses bridge; chunk_size 200 like the chat-completions path, so a short
    // answer streams in several frames instead of one 800-character block
    expect(on.config.stream).toEqual({ enabled: true, chunk_size: 200 });
  });

  it('keeps the system message in the template only, with the turns in messages_history', () => {
    const p: any = geminiToOrchestrationPayload({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [
        { role: 'user', parts: [{ text: 'q1' }] },
        { role: 'model', parts: [{ text: 'a1' }] },
      ],
    }, { modelName: 'm', stream: false });
    expect(p.config.modules.prompt_templating.prompt.template).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    ]);
    expect(p.messages_history.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect((JSON.stringify(p).match(/be brief/g) || [])).toHaveLength(1);
  });

  it('puts tools on prompt.tools, response_format on the prompt, and tool_choice in model.params', () => {
    const p: any = geminiToOrchestrationPayload({
      ...body,
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
    }, { modelName: 'm', stream: false });

    const prompt = p.config.modules.prompt_templating.prompt;
    expect(prompt.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
    ]);
    expect(prompt.response_format).toEqual({ type: 'json_object' });
    expect(p.config.modules.prompt_templating.model.params)
      .toEqual({ temperature: 0.4, tool_choice: 'auto' });
  });

  it('leaves prompt.tools and prompt.response_format unset when the request has neither', () => {
    const prompt: any = geminiToOrchestrationPayload(body, { modelName: 'm', stream: false })
      .config.modules.prompt_templating.prompt;
    expect(prompt.tools).toBeUndefined();
    expect(prompt.response_format).toBeUndefined();
  });

  it('carries a full tool round trip into messages_history', () => {
    const p: any = geminiToOrchestrationPayload({
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { c: 21 } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
    }, { modelName: 'm', stream: false });
    expect(p.messages_history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c00001000',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c00001000', content: '{"c":21}' },
    ]);
  });

  it('puts a Mistral tool turn into the template with the system message leading the history', () => {
    // SAP appends the template after messages_history and Mistral refuses a system message
    // after a tool result (see assembleOrchestrationPayload); every other model keeps the
    // system-only template above.
    const p: any = geminiToOrchestrationPayload({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { note: 'see {{?forecast}}' } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
    }, { modelName: 'mistralai--mistral-medium', stream: false });
    expect(p.config.modules.prompt_templating.prompt.template).toEqual([
      { role: 'tool', tool_call_id: 'c00001000', content: '{"note":"see {{?forecast}}"}' },
    ]);
    expect(p.messages_history.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(p.placeholder_values).toEqual({ forecast: '{{?forecast}}' });
  });
});

describe('geminiGenerationConfigToParams - the temperature/topP pair', () => {
  const both = { generationConfig: { temperature: 0, topP: 1 } };
  it('keeps only temperature for an Anthropic model (SAP refuses the pair for Claude)', () => {
    const { params } = geminiGenerationConfigToParams(both, 'anthropic--claude-4.5-haiku');
    expect(params.temperature).toBe(0);
    expect(params.top_p).toBeUndefined();
  });
  it('passes both through for a model that accepts them (Mistral, gpt-4.x, Gemini)', () => {
    for (const m of ['mistralai--mistral-medium', 'gpt-4.1', 'gemini-2.5-pro']) {
      const { params } = geminiGenerationConfigToParams(both, m);
      expect(params.temperature).toBe(0);
      expect(params.top_p).toBe(1);
    }
  });
  it('drops both for the gpt-5 family (SAP refuses top_p and any temperature but 1), keeps temperature 1', () => {
    const { params } = geminiGenerationConfigToParams(both, 'gpt-5-mini');
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    const one = geminiGenerationConfigToParams({ generationConfig: { temperature: 1, topP: 1 } }, 'gpt-5.4').params;
    expect(one.temperature).toBe(1);
    expect(one.top_p).toBeUndefined();
  });
  it('leaves a lone topP alone even for Anthropic', () => {
    const { params } = geminiGenerationConfigToParams({ generationConfig: { topP: 0.9 } }, 'anthropic--claude-4.5-haiku');
    expect(params.top_p).toBe(0.9);
    expect(params.temperature).toBeUndefined();
  });
});
