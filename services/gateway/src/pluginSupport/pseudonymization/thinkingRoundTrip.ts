/**
 * Thinking round trip.
 *
 * A model writes placeholders into its thinking, and signs that text. The client is shown the real
 * values; on the next turn the upstream must get back exactly the text it signed, and no real value.
 *
 * So every thinking block that passes the gateway under masking gets a restore record on its
 * signature: `<signature>.sp1.<base64url JSON>.`. The record names each placeholder and where its
 * value stands in the restored text; it holds no value. A block in which nothing was restored gets
 * an empty record: it says the text is the model's own, so the next request leaves it alone. A
 * signature is base64, so `.` cannot occur in it: the mark and the closing dot are unambiguous,
 * also for a signature that an upstream sends in two events around the record. On the way back the
 * gateway strips the record (always: with masking off the upstream would refuse the longer
 * signature) and rebuilds the masked text from it. Nothing is stored: every deployment shape and
 * any number of gateway instances behave the same.
 *
 * A block that comes back without a usable record (a client that changed the text, a conversation
 * from before this existed, a turn made with masking off) cannot be rebuilt. Its known values are
 * masked again wherever they occur, so nothing leaves in plain text, at the price that the text
 * may differ from what the model signed.
 *
 * Thinking is restored without the handling of placeholders the model invented: one stays in the
 * text as written, where the answer text would withhold it. The record must describe exactly the
 * text the client holds.
 *
 * A record is taken from the client and proves nothing: it only says how to turn one text the
 * client could have sent into another. Thinking is the model's text and never went through the
 * detectors; a restored block is no different.
 */
import { createHash } from 'crypto';
import { ReplacementMap } from './replacementMap';
import { valueReplacer } from './replacer';
import { ThinkingRef, thinkingRefsOfContent, thinkingRefsOfMessages } from './thinkingBlocks';

export const RECORD_MARK = '.sp1.';
const RECORD_END = '.';

/** [offset of the value in the restored text, length of the value, the placeholder it replaced] */
export type Replacement = [number, number, string];

export interface RestoreRecord {
  v: 1;
  /** first 16 hex digits of the SHA-256 of the masked text */
  h: string;
  r: Replacement[];
}

export const maskedTextHash = (masked: string): string =>
  createHash('sha256').update(masked, 'utf8').digest('hex').slice(0, 16);

/** The suffix a signature gets for a block whose masked text hashes to `hash`. */
export function encodeRecord(hash: string, replacements: Replacement[]): string {
  const record: RestoreRecord = { v: 1, h: hash, r: replacements };
  return RECORD_MARK + Buffer.from(JSON.stringify(record), 'utf8').toString('base64url') + RECORD_END;
}

function readRecord(encoded: string): RestoreRecord | null {
  try {
    const record = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!record || record.v !== 1 || typeof record.h !== 'string' || !Array.isArray(record.r)) return null;
    for (const entry of record.r) {
      if (!Array.isArray(entry) || entry.length !== 3) return null;
      const [offset, length, placeholder] = entry;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || typeof placeholder !== 'string') return null;
    }
    return record as RestoreRecord;
  } catch {
    return null;
  }
}

/**
 * A signature as a client sent it: the model's signature, and the record if it carries a readable
 * one. `marked` says the mark was there, readable record or not: the mark is stripped either way.
 */
export function splitSignature(value: string): { signature: string; record: RestoreRecord | null; marked: boolean } {
  const at = value.indexOf(RECORD_MARK);
  if (at === -1) return { signature: value, record: null, marked: false };
  const start = at + RECORD_MARK.length;
  const end = value.indexOf(RECORD_END, start);
  // A record without its closing dot was cut off: nothing after the mark is the model's.
  if (end === -1) return { signature: value.slice(0, at), record: null, marked: true };
  return { signature: value.slice(0, at) + value.slice(end + RECORD_END.length), record: readRecord(value.slice(start, end)), marked: true };
}

/**
 * The masked text a record describes, rebuilt from the restored text; null when the record does
 * not fit this text (the client changed it) - checked against the hash of the masked original.
 */
export function applyRecord(restored: string, record: RestoreRecord): string | null {
  let masked = '';
  let position = 0;
  for (const [offset, length, placeholder] of record.r) {
    if (offset < position || offset + length > restored.length) return null;
    masked += restored.slice(position, offset) + placeholder;
    position = offset + length;
  }
  masked += restored.slice(position);
  return maskedTextHash(masked) === record.h ? masked : null;
}

/** A masked text with its placeholders restored, and where each value now stands. */
export function unmaskWithRecord(masked: string, map: ReplacementMap): { text: string; replacements: Replacement[] } {
  const replacements: Replacement[] = [];
  if (map.reverse.size === 0) return { text: masked, replacements };
  // Longest first, as the stream buffer does: a placeholder that starts with a shorter one wins.
  const placeholders = Array.from(map.reverse.keys()).sort((a, b) => b.length - a.length);
  const regex = new RegExp(placeholders.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  let text = '';
  let last = 0;
  for (const match of masked.matchAll(regex)) {
    const original = map.reverse.get(match[0]);
    if (original === undefined) continue;
    text += masked.slice(last, match.index);
    replacements.push([text.length, original.length, match[0]]);
    text += original;
    last = match.index! + match[0].length;
  }
  return { text: text + masked.slice(last), replacements };
}

/** The thinking texts of an answer in one piece: an Anthropic message or a Converse answer. */
function thinkingRefsOfResponse(response: any): ThinkingRef[] {
  if (!response || typeof response !== 'object') return [];
  return [...thinkingRefsOfContent(response.content), ...thinkingRefsOfContent(response.output?.message?.content)];
}

/** Whether an answer in one piece holds thinking that has not been through unmaskThinkingBlocks. */
export function hasUnmarkedThinking(response: any): boolean {
  return thinkingRefsOfResponse(response).some(({ holder }) => !(typeof holder.signature === 'string' && holder.signature.includes(RECORD_MARK)));
}

/**
 * Restore the thinking of an answer in one piece, in place: an Anthropic message (`content[]`) or
 * a Converse answer (`output.message.content[]`). A block with a signature gets the record on it,
 * also when nothing was restored; one that already carries a record was here before and is left
 * alone.
 */
export function unmaskThinkingBlocks(response: any, map: ReplacementMap): void {
  for (const { holder, textKey } of thinkingRefsOfResponse(response)) {
    const signature = holder.signature;
    if (typeof signature === 'string' && signature.includes(RECORD_MARK)) continue;
    const masked: string = holder[textKey];
    const { text, replacements } = unmaskWithRecord(masked, map);
    holder[textKey] = text;
    if (typeof signature === 'string' && signature) holder.signature = signature + encodeRecord(maskedTextHash(masked), replacements);
  }
}

/**
 * Runs `work` with the thinking texts of an answer taken out, then puts them back: for a pass that
 * rewrites every string of the answer and must not touch thinking (unmaskThinkingBlocks owns it).
 */
export function withThinkingSetAside<T>(response: any, work: () => T): T {
  const refs = thinkingRefsOfResponse(response);
  const texts = refs.map(({ holder, textKey }) => holder[textKey]);
  for (const { holder, textKey } of refs) holder[textKey] = '';
  try {
    return work();
  } finally {
    refs.forEach(({ holder, textKey }, i) => { holder[textKey] = texts[i]; });
  }
}

export interface ThinkingRestoreSummary {
  /** blocks rebuilt exactly from their record */
  restored: number;
  /** blocks whose mark was stripped but whose record did not fit */
  unreadable: number;
  /** the signatures of the blocks rebuilt exactly: no later pass may change those blocks */
  exact: Set<string>;
}

/**
 * Every request, before anything else reads the body: strip the record from each thinking
 * signature and rebuild the masked text it describes. Runs with masking on or off.
 */
export function restoreThinkingBlocks(body: any): ThinkingRestoreSummary {
  const summary: ThinkingRestoreSummary = { restored: 0, unreadable: 0, exact: new Set() };
  if (!body || typeof body !== 'object') return summary;
  for (const { holder, textKey } of thinkingRefsOfMessages(body.messages)) {
    if (typeof holder.signature !== 'string') continue;
    const { signature, record, marked } = splitSignature(holder.signature);
    if (!marked) continue;
    holder.signature = signature;
    const masked = record ? applyRecord(holder[textKey], record) : null;
    if (masked === null) {
      summary.unreadable++;
      continue;
    }
    holder[textKey] = masked;
    summary.restored++;
    summary.exact.add(signature);
  }
  return summary;
}

/**
 * Thinking without a signature is no model-signed text: it goes through `maskText` (the detectors)
 * like any other text of the request. Before the request-wide propagation, so a value first found
 * here is masked in the other nodes too.
 */
export function maskUnsignedThinking(body: any, maskText: (text: string) => string): void {
  for (const { holder, textKey } of thinkingRefsOfMessages(body?.messages)) {
    if (typeof holder.signature === 'string' && holder.signature) continue;
    holder[textKey] = maskText(holder[textKey]);
  }
}

/**
 * With masking running, the thinking blocks that were not rebuilt exactly: every value this
 * request's map knows is replaced by its placeholder, whatever its length and wherever it stands
 * (in a restored text the value stands where the placeholder stood, also against a word
 * character: `backup_<value>`). Returns the number of blocks changed.
 */
export function remaskThinkingBlocks(body: any, map: ReplacementMap, exact: ReadonlySet<string> | undefined): number {
  const replaceKnown = valueReplacer(map, { minLength: 1, everywhere: true });
  if (!replaceKnown) return 0;
  let changed = 0;
  for (const { holder, textKey } of thinkingRefsOfMessages(body?.messages)) {
    const signature = typeof holder.signature === 'string' ? holder.signature : '';
    if (signature && exact?.has(signature)) continue;
    const before: string = holder[textKey];
    const text = replaceKnown(before);
    if (text !== before) {
      holder[textKey] = text;
      changed++;
    }
  }
  return changed;
}
