jest.mock('../../src/fileSearch/extractors/runners', () => ({ runExtractor: jest.fn() }));

import { runExtractor } from '../../src/fileSearch/extractors/runners';
import { extractStructuredText, extractText, UnsupportedFileTypeError } from '../../src/fileSearch/extractors/registry';
import { decodeEntities, htmlToStructuredText, tidyPandocMarkdown } from '../../src/fileSearch/extractors/htmlText';
import { chunkStructured } from '../../src/fileSearch/structureChunker';

const run = runExtractor as jest.MockedFunction<typeof runExtractor>;

beforeEach(() => run.mockReset());

describe('extractStructuredText', () => {
  it('passes Markdown through unchanged and reads it as markdown', async () => {
    const md = '# Title\r\n\r\n| a | b |\r\n|---|---|\r\n';
    expect(await extractStructuredText('a.md', Buffer.from(md), {})).toEqual({ text: md, format: 'markdown' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reads other direct formats as plain text', async () => {
    expect(await extractStructuredText('a.txt', Buffer.from('# not md'), {})).toEqual({ text: '# not md', format: 'plain' });
    expect(await extractStructuredText('a.py', Buffer.from('x = 1'), {})).toEqual({ text: 'x = 1', format: 'plain' });
  });

  it('converts HTML to Markdown-shaped text under structure only', async () => {
    const html = '<h2>Ports</h2><p>Use 8080.</p>';
    expect(await extractStructuredText('a.html', Buffer.from(html), {})).toEqual({ text: '## Ports\n\nUse 8080.', format: 'markdown' });
    expect(await extractText('a.html', Buffer.from(html), {})).toBe(html); // static keeps the raw markup
  });

  it.each([['docx', 'docx'], ['odt', 'odt'], ['epub', 'epub'], ['rst', 'rst']])(
    'asks pandoc for GitHub-flavoured Markdown without wrapping for .%s',
    async (ext, reader) => {
      run.mockResolvedValue('# Heading\n\n| a |\n|---|\n');
      const out = await extractStructuredText(`doc.${ext}`, Buffer.from('bytes'), { timeoutMs: 1234 });
      expect(out).toEqual({ text: '# Heading\n\n| a |\n|---|\n', format: 'markdown' });
      expect(run).toHaveBeenCalledWith('pandoc', ['-f', reader, '-t', 'gfm', '--wrap=none'], Buffer.from('bytes'), { timeoutMs: 1234 });
    }
  );

  it('drops the empty anchors and wrapper divs, keeps HTML tables', async () => {
    run.mockResolvedValue([
      '<span id="ch001.xhtml"></span>', '', '<div id="s1" class="section level1">', '', '# <span id="anchor"></span>Install',
      '', '<table><tr><td><p>cell</p></td></tr></table>', '', '</div>', '',
    ].join('\n'));
    const { text } = await extractStructuredText('doc.epub', Buffer.from('x'), {});
    expect(text).toBe('\n\n\n# Install\n\n<table><tr><td><p>cell</p></td></tr></table>\n\n');
    expect(tidyPandocMarkdown('a\r\n</div>\r\nb')).toBe('a\r\nb');
  });

  it('keeps the static pandoc call on plain text', async () => {
    run.mockResolvedValue('Heading\n');
    await extractText('doc.docx', Buffer.from('bytes'), { timeoutMs: 1234 });
    expect(run).toHaveBeenCalledWith('pandoc', ['-f', 'docx', '-t', 'plain'], Buffer.from('bytes'), { timeoutMs: 1234 });
  });

  it('reads pdftotext output (the static call) as pages', async () => {
    run.mockResolvedValue('page one\fpage two\f');
    const out = await extractStructuredText('doc.pdf', Buffer.from('%PDF'), { timeoutMs: 1234 });
    expect(out).toEqual({ text: 'page one\fpage two\f', format: 'pdf' });
    expect(run).toHaveBeenCalledWith('pdftotext', ['-', '-'], Buffer.from('%PDF'), { timeoutMs: 1234 });
  });

  it('rejects unsupported types like extractText', async () => {
    await expect(extractStructuredText('deck.ppt', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
    await expect(extractStructuredText('README', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('propagates a pandoc failure', async () => {
    run.mockRejectedValue(new Error('pandoc exited 64'));
    await expect(extractStructuredText('doc.docx', Buffer.from('x'), {})).rejects.toThrow('pandoc exited 64');
  });
});

describe('htmlToStructuredText', () => {
  it('turns headings into an ATX heading chain the chunker reads', () => {
    const html = `<!doctype html><html><head><title>Guide</title><style>h1{color:red}</style>
      <script>if (a < b) { document.write("<h1>x</h1>") }</script></head>
      <body><h1 class="t">Install</h1><p>Intro &amp; more.</p><!-- <h2>hidden</h2> -->
      <h2>Docker <small>v2</small></h2><ul><li>one</li><li>two</li></ul>
      <h3>Ports</h3><table><tr><th>Port</th><th>Use</th></tr><tr><td>8080</td><td>gateway</td></tr></table>
      </body></html>`;
    const text = htmlToStructuredText(html);
    expect(text).toBe([
      'Guide', '', '# Install', '', 'Intro & more.', '', '## Docker v2', '', '- one', '- two', '', '### Ports', '',
      'Port Use', '8080 gateway',
    ].join('\n'));
    const chunks = chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format: 'markdown', minSectionTokens: 0 });
    expect(chunks.map((c) => c.headingPath)).toEqual([null, 'Install', 'Install > Docker v2', 'Install > Docker v2 > Ports']);
  });

  it('keeps <pre> content as a fenced block, lines and indentation intact', () => {
    const html = '<p>Run:</p><pre><code>  if x &lt; 1:\n\n    # not a heading\n    print("```")</code></pre><p>Done.</p>';
    expect(htmlToStructuredText(html)).toBe('Run:\n\n````\n  if x < 1:\n\n    # not a heading\n    print("```")\n````\n\nDone.');
  });

  it('decodes numeric and named entities, leaves unknown and invalid ones', () => {
    expect(decodeEntities('&lt;a&gt; &#65;&#x1F600; &bogus; &#xD800; &#99999999;')).toBe('<a> A😀 &bogus; &#xD800; &#99999999;');
    expect(decodeEntities('&constructor; &__proto__;')).toBe('&constructor; &__proto__;');
  });

  it('treats a bare "<" as text and ignores unclosed headings', () => {
    expect(htmlToStructuredText('<p>a < b and 3<4</p><h2>no close')).toBe('a < b and 3<4\nno close');
  });

  it('an <h1> closed only at the end does not turn the body into a heading', () => {
    const body = Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i} of the body text.</p>`).join('');
    const text = htmlToStructuredText(`<h1>Title ${body}</h1>`);
    expect(text.split('\n').every((line) => !line.startsWith('#'))).toBe(true);
    expect(text).toContain('Paragraph 199 of the body text.');
    expect(text.split('\n').length).toBeGreaterThan(100); // the body keeps its paragraphs
    const chunks = chunkStructured(text, { maxTokens: 100, overlapTokens: 0, format: 'markdown' });
    expect(chunks.reduce((n, c) => n + (c.headingPath ?? '').length, 0)).toBe(0);
  });

  it('a heading longer than 200 characters of text is body text', () => {
    const text = htmlToStructuredText(`<h2>${'long words '.repeat(30)}</h2><h2>Short</h2>`);
    expect(text).toBe(`${'long words '.repeat(30).trim()}\n\n## Short`);
  });

  it('drops script and style content inside headings and <pre>', () => {
    expect(htmlToStructuredText('<h2>Ports<script>alert("x")</script><style>.a{}</style></h2>')).toBe('## Ports');
    expect(htmlToStructuredText('<pre>a<script>bad()</script>\nb<!-- c --></pre>')).toBe('```\na\nb\n```');
  });

  it('a ">" inside a quoted attribute does not leak markup into the text', () => {
    expect(htmlToStructuredText('<p title="a>b">x</p>')).toBe('x');
    expect(htmlToStructuredText("<p title='a>b' data-x=\"c>d\">y</p>")).toBe('y');
    expect(htmlToStructuredText('<h3 title="1>2">Head</h3>')).toBe('### Head');
    // A quote that never closes inside the tag falls back to the first '>'.
    expect(htmlToStructuredText('<p title="a>b<i>c</i>')).toBe('bc');
  });

  it('drops the rest of the document after an unclosed <script>', () => {
    expect(htmlToStructuredText('<p>kept</p><script>var x = "<p>gone</p>";')).toBe('kept');
  });

  it('stays linear on hostile input', () => {
    const hostile = [
      '<h1>'.repeat(50000), '<p '.repeat(50000), '<pre>'.repeat(50000), '<!--', 'x'.repeat(1000),
    ].join('');
    const started = Date.now();
    htmlToStructuredText(hostile);
    htmlToStructuredText('<a '.repeat(100000));
    htmlToStructuredText(`<pre>${'<b'.repeat(100000)}</pre>`);
    htmlToStructuredText('<a title="x>" '.repeat(50000));
    htmlToStructuredText(`<h1>${'<p title="'.repeat(50000)}</h1>`);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
