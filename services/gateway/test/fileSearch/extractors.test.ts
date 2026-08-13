import { extractText, isSupportedExtension, UnsupportedFileTypeError }
  from '../../src/fileSearch/extractors/registry';

describe('extension support', () => {
  it.each(['txt','md','json','py','js','ts','c','cpp','cs','go','java','php','rb','sh','css','html','tex','docx','odt','epub','rst','pdf'])
    ('supports .%s', (e) => expect(isSupportedExtension(e)).toBe(true));

  it.each(['pptx','doc'])('rejects .%s as a documented gap', (e) =>
    expect(isSupportedExtension(e)).toBe(false));

  it('is case-insensitive and tolerates a leading dot', () => {
    expect(isSupportedExtension('.TXT')).toBe(true);
    expect(isSupportedExtension('PDF')).toBe(true);
  });

  it('for a multi-dot filename fragment, only the final segment counts', () => {
    // "archive.tar.gz" should be treated as a ".gz" file (unsupported), not
    // as ".tar" or ".tar.gz".
    expect(isSupportedExtension('tar.gz')).toBe(false);
  });

  // Regression: the pandoc-reader lookup used to be a plain object, so
  // `ext in obj` / `obj[ext]` walked the prototype chain. An extension of
  // "constructor" or "__proto__" resolved to Object.prototype's own
  // properties and was treated as supported — this codebase has been bitten
  // by a `__proto__` key silently corrupting a lookup map before, so this is
  // pinned explicitly rather than trusted to the general allowlist tests.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])
    ('does not treat inherited Object.prototype property %s as a supported extension', (e) =>
      expect(isSupportedExtension(e)).toBe(false));
});

describe('direct read', () => {
  it('reads utf-8 text unchanged', async () => {
    expect(await extractText('a.md', Buffer.from('# Title\n\nBody', 'utf8'), {})).toContain('# Title');
  });

  it('rejects an encoding outside utf-8/utf-16/ascii', async () => {
    // Lone continuation byte: not valid UTF-8.
    await expect(extractText('a.txt', Buffer.from([0xff, 0xfe, 0x41, 0x80, 0x9f]), {}))
      .rejects.toThrow(/encoding/i);
  });

  it('reads plain ascii unchanged', async () => {
    expect(await extractText('a.txt', Buffer.from('hello world', 'ascii'), {})).toBe('hello world');
  });

  it('reads valid utf-16le (with BOM) text', async () => {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from('hi', 'utf16le');
    expect(await extractText('a.txt', Buffer.concat([bom, body]), {})).toBe('hi');
  });

  it('dispatches on extension, not on file content', async () => {
    // A .json file containing text that is NOT valid JSON should still come
    // back verbatim: the direct-read path is a decode, not a JSON.parse.
    const out = await extractText('a.json', Buffer.from('not actually json {{{', 'utf8'), {});
    expect(out).toBe('not actually json {{{');
  });
});

describe('unsupported types', () => {
  it('throws UnsupportedFileTypeError naming the type for .pptx', async () => {
    await expect(extractText('deck.pptx', Buffer.from('x'), {}))
      .rejects.toThrow(UnsupportedFileTypeError);
    await expect(extractText('deck.pptx', Buffer.from('x'), {})).rejects.toThrow(/pptx/);
  });

  it('throws UnsupportedFileTypeError naming the type for .doc', async () => {
    await expect(extractText('report.doc', Buffer.from('x'), {}))
      .rejects.toThrow(/doc/);
  });

  it('rejects an extension with no dot in the filename', async () => {
    await expect(extractText('README', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('rejects a dot-less filename even when it happens to spell a supported extension name', async () => {
    // Regression: a filename with no dot at all used to have its whole
    // basename treated as "the extension" (normalizeExtension on a dot-less
    // string just returns the string unchanged), so a file literally named
    // "pdf" or "txt" — no extension, just that as the whole name — got
    // dispatched to the pdftotext/direct-read runner as if ".pdf"/".txt" had
    // been supplied.
    await expect(extractText('pdf', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
    await expect(extractText('txt', Buffer.from('x'), {})).rejects.toThrow(/no file extension/);
  });

  it('names a trailing-dot filename\'s extension meaningfully rather than as ".(none)"', async () => {
    await expect(extractText('notes.', Buffer.from('x'), {})).rejects.toThrow(/no file extension/);
  });

  it('fails safe (as unsupported) rather than executing shell metacharacters smuggled into the extension', async () => {
    // The dispatcher never builds a command string, so this can't be a real
    // injection — but it should still resolve as a plain unsupported-type
    // rejection, not a crash or a silent fall-through to some other runner.
    await expect(extractText('file.docx; rm -rf /tmp', Buffer.from('x'), {}))
      .rejects.toThrow(UnsupportedFileTypeError);
  });

  // Regression: see the "does not treat inherited Object.prototype
  // property" case above — this pins the same bug at the extractText()
  // dispatch level, where the consequence was worse than a wrong boolean:
  // PANDOC_READERS['constructor'] was spawned as a pandoc argv element.
  it('does not dispatch "constructor"/"__proto__" extensions to pandoc', async () => {
    await expect(extractText('a.constructor', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
    await expect(extractText('a.__proto__', Buffer.from('x'), {})).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('bounds and sanitizes the extension echoed back in the error message', async () => {
    const hostile = 'a\nb'.repeat(2000); // newlines (log-injection) + far past any reasonable length
    const err = await extractText(`file.${hostile}`, Buffer.from('x'), {}).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedFileTypeError);
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).not.toMatch(/\n/);
  });
});
