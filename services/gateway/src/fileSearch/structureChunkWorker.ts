// Worker-thread entry of the structure chunker (structureChunkThread.ts starts
// it). Imports the chunker only — no logger, no configuration, no path aliases —
// so it loads as plain compiled JavaScript next to this file, or through ts-node
// when the gateway itself runs from TypeScript.
import { parentPort } from 'worker_threads';
import { chunkStructuredWithSections, countTokens, StructuredChunkOptions } from './structureChunker';

interface ChunkRequest {
  id: number;
  text: string;
  opts: StructuredChunkOptions;
  countDocument: boolean;
}

parentPort?.on('message', (request: ChunkRequest) => {
  const started = Date.now();
  try {
    const { chunks, sections } = chunkStructuredWithSections(request.text, request.opts);
    const starts = chunks.map((c) => sections[c.section].start + c.sectionOffset);
    const documentTokens = request.countDocument ? countTokens(request.text) : undefined;
    parentPort!.postMessage({ id: request.id, ok: true, chunks, starts, documentTokens, elapsedMs: Date.now() - started });
  } catch (error: any) {
    parentPort!.postMessage({ id: request.id, ok: false, message: String(error?.message ?? error) });
  }
});

// Loaded: the main thread counts a failure before this as "cannot start".
parentPort?.postMessage({ ready: true });
