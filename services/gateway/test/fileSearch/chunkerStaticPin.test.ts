// Pins today's `static` chunking output on the evaluation corpus' Markdown files.
// Static chunk boundaries are part of every existing store and of the W1
// evaluation's store key, so a change here — even one that "only" improves the
// text — silently invalidates both. If this fails, the static chunker changed.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { chunkText } from '../../src/fileSearch/chunker';
import { extractText } from '../../src/fileSearch/extractors/registry';
import { STATIC_CHUNK_PINS as PINS } from './fixtures/staticChunkPins';

const CORPUS = join(__dirname, '../../../../ci/file-search-eval/corpus/markdown');

function staticDigest(file: string, size: number, overlap: number): { count: number; sha256: string } {
  const text = readFileSync(join(CORPUS, file), 'utf8');
  const chunks = chunkText(text, {
    type: 'static',
    static: { max_chunk_size_tokens: size, chunk_overlap_tokens: overlap },
  });
  return { count: chunks.length, sha256: createHash('sha256').update(JSON.stringify(chunks)).digest('hex') };
}

describe('static extraction stays byte-identical on the evaluation corpus', () => {
  // Markdown is decoded as is: extractText's output hashes to the manifest's sha256 of the file.
  const manifest: Array<{ file: string; kind: string; sha256: string }> = JSON.parse(
    readFileSync(join(CORPUS, '../manifest.json'), 'utf8')
  );
  it.each(manifest.filter((m) => m.kind === 'markdown').map((m) => [m.file, m.sha256]))('%s', async (file, sha256) => {
    const text = await extractText(file, readFileSync(join(CORPUS, '..', file)), { timeoutMs: 10000 });
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(sha256);
  });

  it('html is indexed with its markup', async () => {
    const html = '<!doctype html><h1 class="a">Title</h1>\n<p>Body &amp; more</p>';
    const text = await extractText('page.html', Buffer.from(html, 'utf8'), { timeoutMs: 10000 });
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(createHash('sha256').update(html, 'utf8').digest('hex'));
  });
});

describe('static chunking stays byte-identical on the evaluation corpus', () => {
  it.each(PINS)('%s at %d/%d', (file, size, overlap, count, sha256) => {
    expect(staticDigest(file, size, overlap)).toEqual({ count, sha256 });
  });
});
