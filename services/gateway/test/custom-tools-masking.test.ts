import { extractResponsesInputTexts } from '../src/utils/responsesBodyAdapter';

describe('extractResponsesInputTexts — custom tool shapes', () => {
  it('extracts custom_tool_call.input so the patch body is masked', () => {
    const body = {
      input: [{ type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: 'contact alice@example.com' }],
    };
    const found = extractResponsesInputTexts(body);
    expect(found).toContainEqual({ text: 'contact alice@example.com', path: 'input.0.input' });
  });

  it('extracts each part of an array-shaped custom_tool_call_output', () => {
    const body = {
      input: [{ type: 'custom_tool_call_output', call_id: 'c', output: [
        { type: 'input_text', text: 'wrote alice@example.com' },
      ] }],
    };
    expect(extractResponsesInputTexts(body)).toContainEqual({
      text: 'wrote alice@example.com', path: 'input.0.output.0.text',
    });
  });

  it('still extracts a string-shaped output', () => {
    const body = { input: [{ type: 'function_call_output', call_id: 'c', output: 'plain' }] };
    expect(extractResponsesInputTexts(body)).toContainEqual({ text: 'plain', path: 'input.0.output' });
  });
});
