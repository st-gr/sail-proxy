/**
 * Read an upstream (axios) error body that may be a stream.
 *
 * Streaming requests use `responseType: 'stream'`, so on an error status axios
 * delivers `error.response.data` as a Readable stream — logging it directly
 * prints an unusable stream object, and body-matching logic (e.g. the beta-flag
 * quarantine) sees nothing. Drain up to a small cap with a short timeout and
 * parse JSON when possible; non-stream bodies are returned unchanged.
 */

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 3000;

export async function readUpstreamErrorBody(response: any): Promise<any> {
  const data = response?.data;
  if (!data || typeof data.on !== 'function') {
    return data;
  }
  try {
    const raw: string = await new Promise((resolve) => {
      let buf = '';
      let settled = false;
      const swallowLateErrors = (): void => { /* keep post-drain stream errors from crashing the process */ };
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof data.off === 'function') {
          data.off('data', onData);
          data.off('end', done);
          data.off('error', done);
        }
        // The stream may keep erroring after we stop caring; without a listener
        // Node treats that as an uncaught exception. Park a swallow-handler and
        // tear the stream down.
        data.on('error', swallowLateErrors);
        if (typeof data.destroy === 'function') {
          try { data.destroy(); } catch { /* already destroyed */ }
        }
        resolve(buf);
      };
      const onData = (chunk: any): void => {
        buf += chunk.toString('utf8');
        if (buf.length >= MAX_ERROR_BODY_BYTES) done();
      };
      const timer = setTimeout(done, READ_TIMEOUT_MS);
      // 'error' first: attaching 'data' switches the stream to flowing mode, and a
      // stream that errors synchronously would otherwise emit before we listen.
      data.on('error', done);
      data.on('end', done);
      data.on('data', onData);
    });
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
}
