export type OpenAIErrorBody = {
  error: { message: string; type: 'invalid_request_error'; param: string | null; code: string | null };
};

function err(message: string, param: string): OpenAIErrorBody {
  return { error: { message, type: 'invalid_request_error', param, code: null } };
}

/** Validate an OpenAI chat-completions request body. Returns a 400-shaped error
 *  body when invalid, else null. Mirrors OpenAI: `model` and a non-empty
 *  `messages` array are required. */
export function validateChatRequest(body: any): OpenAIErrorBody | null {
  if (!body || typeof body.model !== 'string' || body.model.trim() === '') {
    return err('you must provide a model parameter', 'model');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err('you must provide the messages parameter with at least one message', 'messages');
  }
  return null;
}
