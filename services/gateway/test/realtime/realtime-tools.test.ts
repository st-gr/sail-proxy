import { declaredToolsFromSessionUpdate, invokedToolsFromResponseDone } from '../../src/realtime/realtimeObserver';

describe('realtime tool observation', () => {
  it('reads declared function tools from a session.update frame', () => {
    const frame = JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'book' }] } });
    expect(declaredToolsFromSessionUpdate(frame)).toEqual(['function:get_weather', 'function:book']);
    expect(declaredToolsFromSessionUpdate(JSON.stringify({ type: 'input_audio_buffer.append' }))).toEqual([]);
    expect(declaredToolsFromSessionUpdate('not json')).toEqual([]);
  });
  it('reads invoked function calls from a response.done frame', () => {
    const frame = JSON.stringify({ type: 'response.done', response: { output: [{ type: 'message' }, { type: 'function_call', name: 'get_weather' }] } });
    expect(invokedToolsFromResponseDone(frame)).toEqual(['function:get_weather']);
    expect(invokedToolsFromResponseDone(JSON.stringify({ type: 'response.created' }))).toEqual([]);
  });
});
