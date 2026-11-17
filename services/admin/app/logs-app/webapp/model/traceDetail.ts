/**
 * What the detail of one request offers (controller/TraceDetail.ts, view/TraceDetail.fragment.xml),
 * decided from its facts: masked text at once; a sealed prompt behind "Show content" (opening it is
 * recorded); for a facts-only trace (raw capture while payload capture was off) a note that it holds
 * no content; and for a request captured raw its stages, each to view and to download, and all of
 * them. No UI5 imports, so it runs under jest.
 */
import type { OpenedTrace } from './api';
import { contentState, problemKey, type TraceFacts } from './traceView';

export interface DetailState {
  /** A light trace exists (not a raw-only row): its facts, its content and its own download. */
  hasLight: boolean;
  masked: boolean;
  raw: boolean;
  /** A sealed prompt is stored: "Show content" opens it. */
  sealed: boolean;
  /** The light trace holds no content (facts only). */
  noContent: boolean;
  /** The masked text is read as the detail opens. */
  loadContent: boolean;
  /** The stage list is read as the detail opens. */
  loadStages: boolean;
  /** The trace's own Download. */
  downloadTrace: boolean;
  /** View and Download per stage, and Download all. */
  stageActions: boolean;
}

export function detailState(row: { rawOnly?: boolean; facts: TraceFacts }): DetailState {
  const hasLight = !row.rawOnly;
  const content = hasLight ? contentState(row.facts) : 'none';
  return {
    hasLight,
    masked: row.facts.masked,
    raw: row.facts.raw,
    sealed: content === 'sealed',
    noContent: content === 'none',
    loadContent: content === 'masked',
    loadStages: row.facts.raw,
    downloadTrace: hasLight,
    stageActions: row.facts.raw
  };
}

/** "Show content" is offered for a sealed prompt until it is shown. */
export function offersShowContent(state: { sealed: boolean; contentShown: boolean }): boolean {
  return state.sealed && !state.contentShown;
}

/**
 * The answer of openPayloadTrace as the detail shows it: the texts, or the key of why they cannot be
 * shown; a trace that holds no text says so (a masked raw-capture trace recorded while payload capture was off).
 */
export function openedContent(body: OpenedTrace): { prompt: string; answer: string; contentShown: boolean; noContent: boolean; problemKey: string } {
  const prompt = body.prompt ?? '';
  const answer = body.answer ?? '';
  if (body.problem) return { prompt, answer, contentShown: false, noContent: false, problemKey: problemKey(body.problem) };
  return { prompt, answer, contentShown: true, noContent: !prompt && !answer, problemKey: '' };
}

/** A stage opened with View: JSON indented; a cut stage, or one that is not JSON, as it is. */
export function stageText(content: string, cut: boolean): string {
  if (cut) return content;
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch (error) { return content; }
}
