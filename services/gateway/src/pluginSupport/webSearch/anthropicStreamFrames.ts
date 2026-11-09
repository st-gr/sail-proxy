/**
 * The Anthropic SSE frames a streaming `web_search` turn is made of.
 *
 * Pure builders, no I/O, so the golden fixture can be asserted against them
 * directly. Shapes are copied from a real capture (2026-08-07, mitmproxy,
 * claude-haiku-4-5-20251001) — see
 * `test/fixtures/anthropic/websearch-golden.stream.jsonl`.
 *
 * `encrypted_content` is an Anthropic-signed blob we cannot mint. It is emitted
 * as an empty string rather than omitted: the key's PRESENCE is part of the
 * shape an SDK destructures, and a missing key and an empty one are different
 * failures. Nothing on our side consumes it.
 */
import * as crypto from 'crypto';
import { SearchResult } from './searchExecutor';

// hex, not base64url: the golden's real ids (e.g.
// `srvtoolu_01Hb28EqZtcERCejd1AG8NW4`) are alphanumeric only. base64url can
// emit `-`/`_`, which would make minted ids distinguishable from real ones
// and reintroduces a test flake if changed back — see
// `src/fileSearch/ids.ts` for the same convention elsewhere in this codebase.
export function serverToolUseId(): string {
  return `srvtoolu_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * `content_block_start` + `input_json_delta`s + `content_block_stop`.
 *
 * Anthropic streams the tool input as partial JSON across several deltas. We
 * emit it as ONE delta carrying the whole object: a client accumulating
 * `partial_json` and parsing at `content_block_stop` — which is the documented
 * way to read it — gets an identical result, and splitting it into arbitrary
 * fragments would fake a property of their tokeniser we cannot reproduce.
 */
export function serverToolUseFrames(toolUseId: string, query: string, index: number): any[] {
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: {} },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
    },
    { type: 'content_block_stop', index },
  ];
}

/** `content_block_start` + `content_block_stop` for the result block. */
export function webSearchResultFrames(
  toolUseId: string,
  results: SearchResult[],
  index: number,
): any[] {
  return [
    {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        caller: { type: 'direct' },
        content: results.map((r) => ({
          type: 'web_search_result',
          title: r.title ?? '',
          url: r.url ?? '',
          encrypted_content: '',
          // SearchResult.date is the publication/last-updated date — the same
          // semantic Anthropic's page_age carries (golden values look like
          // "February 13, 2026" or "1 month ago"). No field literally named
          // `page_age` exists on SearchResult, so we source it from `date`.
          page_age: r.date ?? null,
        })),
      },
    },
    { type: 'content_block_stop', index },
  ];
}
