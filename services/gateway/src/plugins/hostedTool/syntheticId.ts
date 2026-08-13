import * as crypto from 'crypto';

/**
 * Ids for the items the gateway synthesises — a hosted-tool call item, a result-dump
 * message, a stand-in terminal frame's response id.
 *
 * One module-global counter shared by the engine and every descriptor, so two items minted
 * in the same millisecond can never collide WITHIN a process. The trailing random chars make
 * them safe ACROSS processes too: two gateway processes each start this counter at 0, and
 * without the random tail, both minting at the same Date.now() millisecond would produce the
 * identical id. That matters because these ids become cache keys (see the hosted-tool result
 * cache) — a collision would let one conversation read another's cached tool results.
 *
 * The `<prefix>_<base36 time><base36 counter><6 base36 random chars>` shape is load-bearing
 * for the characterization suite, which normalises ids of exactly this shape (7+ base36
 * chars after the underscore) and leaves short fixture ids alone.
 *
 * The 6-char tail is drawn one character at a time from `crypto.randomInt(36)`, uniform over
 * the 36-symbol alphabet by construction — full ~31 bits of entropy (36^6 ≈ 2.18 billion
 * equally likely tails). An earlier version built the tail by base36-encoding a random
 * uint32 and slicing to 6 chars; that silently dropped the low digit for any draw ≥ 36^6
 * (~49% of draws), collapsing runs of 36 consecutive raw values onto one identical tail and
 * cutting worst-case entropy to ~26.8 bits. Per-character rejection sampling avoids that.
 */
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
let counter = 0;

export function syntheticId(prefix: string): string {
  counter += 1;
  let random = '';
  for (let i = 0; i < 6; i += 1) {
    random += BASE36_ALPHABET[crypto.randomInt(36)];
  }
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}
