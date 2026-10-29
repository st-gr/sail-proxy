/**
 * What the facade may log about a request or an error.
 *
 * A request body is the conversation, so a request is logged by model and size only. An AxiosError
 * carries the request config (its headers hold x-api-key, its data the prompt) and the raw request,
 * so an error is logged by name, message, status and code only.
 */

/** `model=<model>, <n> bytes` for a request body. */
const describeRequest = (body) => {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8');
  } catch {
    bytes = 0;
  }
  const model = body && typeof body === 'object' && typeof body.model === 'string' ? body.model : 'n/a';
  return `model=${model}, ${bytes} bytes`;
};

/** `<name>: <message>[ status=<s>][ code=<c>]` for an error, without its config, request or response. */
const describeError = (error) => {
  if (!error || typeof error !== 'object') return String(error);
  let text = `${error.name || 'Error'}: ${error.message}`;
  if (error.status !== undefined) text += ` status=${error.status}`;
  if (error.code !== undefined) text += ` code=${error.code}`;
  return text;
};

module.exports = { describeRequest, describeError };
