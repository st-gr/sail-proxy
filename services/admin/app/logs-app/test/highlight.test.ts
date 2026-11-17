import { escapeHtml, searchSegments, segmentsToHtml } from '../webapp/model/highlight';

describe('searchSegments', () => {
  it('splits a text into the matches of the term and the rest, case-insensitively', () => {
    expect(searchSegments('Timeout after TIMEOUT', 'timeout')).toEqual([
      { text: 'Timeout', match: true }, { text: ' after ', match: false }, { text: 'TIMEOUT', match: true }
    ]);
  });

  it('an empty or blank term gives the whole text as one segment', () => {
    expect(searchSegments('a <b>', '')).toEqual([{ text: 'a <b>', match: false }]);
    expect(searchSegments('a <b>', '   ')).toEqual([{ text: 'a <b>', match: false }]);
    expect(searchSegments('', 'x')).toEqual([]);
  });

  it('takes the term literally: regex characters, markup and quotes are plain text', () => {
    const text = 'GET /x?a=1&b=(2)* <script>alert("x")</script> 50% a.b';
    expect(searchSegments(text, '(2)*')).toEqual([{ text: 'GET /x?a=1&b=', match: false }, { text: '(2)*', match: true }, { text: ' <script>alert("x")</script> 50% a.b', match: false }]);
    expect(searchSegments(text, '<SCRIPT>').filter((s) => s.match).map((s) => s.text)).toEqual(['<script>']);
    expect(searchSegments(text, '.').filter((s) => s.match)).toHaveLength(1);
    expect(searchSegments(text, '"x"').filter((s) => s.match).map((s) => s.text)).toEqual(['"x"']);
  });

  it('trims the term as the search does', () => {
    expect(searchSegments('abc', ' b ')).toEqual([{ text: 'a', match: false }, { text: 'b', match: true }, { text: 'c', match: false }]);
  });
});

describe('segmentsToHtml', () => {
  it('escapes every piece of text and wraps only the matches in <strong>', () => {
    const html = segmentsToHtml(searchSegments('<script>alert("x&y")</script> \'q\'', 'alert'));
    expect(html).toBe('&lt;script&gt;<strong>alert</strong>(&quot;x&amp;y&quot;)&lt;/script&gt; &#39;q&#39;');
    expect(html).not.toMatch(/<(?!\/?strong>)/);
  });

  it('a match that is itself markup stays text inside the emphasis', () => {
    expect(segmentsToHtml(searchSegments('a <b> c', '<b>'))).toBe('a <strong>&lt;b&gt;</strong> c');
  });

  it('escapeHtml leaves plain text as it is', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});
