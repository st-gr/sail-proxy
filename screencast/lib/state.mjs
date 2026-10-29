// The seed state file (screencast/out/seed-keys.json) holds keys: a parse error must not quote it
// (V8's SyntaxError does), so the error is replaced by a fixed message.
export function loadState(text) {
  try { return JSON.parse(text); } catch { throw new Error('seed-keys.json is not valid JSON'); }
}
