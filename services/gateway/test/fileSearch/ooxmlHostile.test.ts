// Hostile and broken .pptx/.xlsx files: every limit violation, malformed archive or XML ends in a
// DocumentReadError (a permanent failure of the file) with a clear reason — never a crash, never an
// unbounded inflate, never a DTD. The time bound is a transient ExtractionTimeoutError.
import { readPptx } from '../../src/fileSearch/extractors/ooxml/pptx';
import { readXlsx } from '../../src/fileSearch/extractors/ooxml/xlsx';
import { asDocumentRead, DocumentReadError, OOXML_LIMITS } from '../../src/fileSearch/extractors/ooxml/limits';
import { openZip } from '../../src/fileSearch/extractors/ooxml/zip';
import { scanXml } from '../../src/fileSearch/extractors/ooxml/xml';
import { ExtractionTimeoutError } from '../../src/fileSearch/extractors/runners';
import { pptxEntries, xlsx, xlsxEntries, zip, withEntry, ZipEntry, slideXml } from './fixtures/ooxmlFixtures';

const SHEET = 'xl/worksheets/sheet1.xml';
const book = (): ZipEntry[] => xlsxEntries([{ name: 'S', rows: [['a', 'b'], [1, 2]] }]);
const workbookWithSheet = (xml: string): Buffer => zip(withEntry(book(), { name: SHEET, data: xml }));
const fails = async (bytes: Buffer, re: RegExp, opts: Parameters<typeof readXlsx>[1] = {}): Promise<void> => {
  const err = await readXlsx(bytes, opts).catch((e) => e);
  expect(err).toBeInstanceOf(DocumentReadError);
  expect(err.message).toMatch(/^Could not read the Excel file: /);
  expect(err.message).toMatch(re);
};

describe('the archive', () => {
  it('not a zip at all (also what a password-protected Office file is)', async () => {
    await fails(Buffer.from('PK definitely not a zip file'), /not a valid zip archive/);
    await fails(Buffer.alloc(0), /not a valid zip archive/);
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    await fails(ole, /password-protected/);
  });

  it('a truncated archive', async () => {
    const bytes = xlsx([{ name: 'S', rows: [['a']] }]);
    await fails(bytes.subarray(0, bytes.length - 30), /not a valid zip archive/);
    await fails(bytes.subarray(40), /not a valid zip archive|corrupt/);
  });

  it('too many entries', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `junk/${i}.bin`, data: 'x', store: true }));
    await fails(zip([...book(), ...many]), /more than 20 entries/, { limits: { maxEntries: 20 } });
  });

  it('a zip bomb: an entry whose declared ratio is too high is never inflated', async () => {
    const bomb = { name: SHEET, data: Buffer.alloc(40 * 1024 * 1024, 0x20) };
    await fails(zip(withEntry(book(), bomb)), /compression ratio/);
  });

  it('a zip bomb that lies about its size: inflation stops at the declared size', async () => {
    const liar = { name: SHEET, data: Buffer.alloc(20 * 1024 * 1024, 0x20), declaredSize: 4096 };
    await fails(zip(withEntry(book(), liar)), /larger than it declares|corrupt/);
  });

  it('one entry over the single-entry cap, by its declared size, before inflating', async () => {
    const huge = { name: SHEET, data: Buffer.from('<x/>'), store: true, declaredSize: OOXML_LIMITS.maxEntryBytes + 1 };
    await fails(zip(withEntry(book(), huge)), /entry larger than/);
  });

  it('the parts read together over the total cap', async () => {
    const sheet = `<worksheet><sheetData>${'<row/>'.repeat(20_000)}</sheetData></worksheet>`;
    await fails(zip(withEntry(book(), { name: SHEET, data: sheet })), /more than 100000 bytes in all/,
      { limits: { maxTotalBytes: 100_000, maxEntryBytes: 1_000_000 } });
  });

  it('an encrypted entry or an unknown compression method', async () => {
    await fails(zip(withEntry(book(), { name: SHEET, data: '<x/>', flags: 1 })), /encrypted/);
    await fails(zip(withEntry(book(), { name: SHEET, data: '<x/>', method: 12, store: true })), /compression method/);
  });

  it('a duplicate part name is ambiguous', async () => {
    await fails(zip([...book(), { name: 'XL/Workbook.xml', data: '<workbook/>' }]), /duplicate/);
  });

  it('names are only lookup keys: a traversing name is never written anywhere and never matches a part', async () => {
    const zipFile = openZip(zip([{ name: '../../etc/passwd', data: 'x' }, { name: '/abs/part.xml', data: 'y' }]), OOXML_LIMITS);
    expect(zipFile.has('../../etc/passwd')).toBe(true);
    expect(zipFile.has('abs/part.xml')).toBe(true);
    expect(zipFile.has('etc/passwd')).toBe(false);
  });

  it('corrupt deflate data', async () => {
    const entries = book();
    const bytes = zip(entries);
    const at = bytes.indexOf(Buffer.from(SHEET)) + SHEET.length; // the first local copy's data follows its name
    for (let i = 0; i < 8; i += 1) bytes[at + i] = 0xff;
    await fails(bytes, /corrupt/);
  });
});

describe('the XML', () => {
  const sheetWith = (xml: string): Buffer => zip(withEntry(book(), { name: SHEET, data: xml }));

  it('a DTD is refused outright (no entity expansion: billion laughs)', async () => {
    const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>'
      + '<worksheet><sheetData><row><c t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>';
    await fails(sheetWith(laughs), /DTD/);
  });

  it('an undefined entity reference is malformed, not expanded', async () => {
    await fails(sheetWith('<worksheet><sheetData><row><c t="inlineStr"><is><t>&lol;</t></is></c></row></sheetData></worksheet>'), /malformed/);
    await fails(sheetWith('<worksheet><sheetData><row><c t="inlineStr"><is><t>a & b</t></is></c></row></sheetData></worksheet>'), /malformed/);
  });

  it('deep nesting stops at the depth cap', async () => {
    await fails(sheetWith(`<worksheet>${'<x>'.repeat(100_000)}${'</x>'.repeat(100_000)}</worksheet>`), /nested more than 256/);
  });

  it.each([
    ['an unclosed element', '<worksheet><sheetData>'],
    ['a mismatched end tag', '<worksheet><sheetData></row></worksheet>'],
    ['text after the root', '<worksheet/>trailing'],
    ['an unterminated tag', '<worksheet><sheetData'],
    ['an unterminated comment', '<worksheet><!-- open'],
    ['two roots', '<worksheet/><worksheet/>'],
    ['no root at all', '   '],
    ['a broken character reference', '<worksheet><x>&#xD800;</x></worksheet>'],
  ])('%s is malformed', async (_label, xml) => {
    await fails(sheetWith(xml), /malformed/);
  });

  it('attribute values may hold ">" and quotes of the other kind', async () => {
    const events: string[] = [];
    scanXml('<a b="x > y" c=\'say "hi"\'><t>v</t></a>', {
      open: (name, attrs) => events.push(`${name}:${attrs.get('b') ?? ''}|${attrs.get('c') ?? ''}`),
      text: (t) => events.push(`#${t}`),
    });
    expect(events).toEqual(['a:x > y|say "hi"', 't:|', '#v']);
  });

  it('a long tag or comment full of ">" is scanned once, not again with every slice', async () => {
    const xml = `<worksheet a="${'x>'.repeat(12_000_000)}"><!--${'y>'.repeat(12_000_000)}--><sheetData/></worksheet>`;
    const bytes = sheetWith(xml);
    const started = Date.now();
    // Repetitive (past the bomb ratio) and longer than the tag cap: both lifted to measure the scan.
    expect(await readXlsx(bytes, { limits: { maxRatio: 1e6, maxTokenChars: 64 * 1024 * 1024 } })).toBe('');
    // ~1 s here; rescanning the token from its start with every 128 KiB slice took ~8 s. The ceiling sits
    // above a loaded runner's time; a quadratic rescan on this 24 MB token still runs past it.
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 30_000);

  it('a long run of name characters without "=" is a broken attribute, found in linear time', async () => {
    for (const len of [200_000, 400_000]) {
      const started = Date.now();
      expect(() => scanXml(`<a ${'x'.repeat(len)}/>`, {})).toThrow(/broken attribute/);
      expect(() => scanXml(`<a b="1" ${'x'.repeat(len)}="2" ${'y'.repeat(len)}/>`, {})).toThrow(/broken attribute/);
      // Linear: milliseconds. The old regex took ~10 s at 80 000 and grows quadratically (minutes at these sizes).
      expect(Date.now() - started).toBeLessThan(10_000);
    }
    const started = Date.now();
    await fails(sheetWith(`<worksheet><sheetData><row ${'a'.repeat(900_000)}/></sheetData></worksheet>`), /broken attribute/,
      { limits: { maxRatio: 1e6 } });
    expect(Date.now() - started).toBeLessThan(10_000); // quadratic attribute scanning: minutes at 900 000
  });

  it('a tag longer than the cap', async () => {
    await fails(sheetWith(`<worksheet><sheetData><row a="${'1'.repeat(2_000_000)}"/></sheetData></worksheet>`), /tag or text longer than 1048576/,
      { limits: { maxRatio: 1e6 } });
  });

  it('the scanner reads a document fed in arbitrary pieces exactly like at once', () => {
    const xml = '<?xml version="1.0"?><!-- c --><a x="1"><b>t&amp;u</b><![CDATA[<raw>]]><c/></a>';
    const whole: string[] = [];
    const pieces: string[] = [];
    const sink = (out: string[]) => ({
      open: (n: string, a: Map<string, string>, self: boolean) => out.push(`<${n} ${[...a].join()} ${self}`),
      close: (n: string) => out.push(`</${n}`),
      text: (t: string) => out.push(t),
    });
    scanXml(xml, sink(whole));
    scanXml([...xml], sink(pieces)); // one character at a time
    expect(pieces).toEqual(whole);
  });
});

describe('expensive shapes stop early', () => {
  it('one long shared string referenced by many cells: the output cap fires while reading, quickly', async () => {
    const shared = `<sst><si><t>${'w '.repeat(500_000)}</t></si></sst>`;
    const rows = '<row><c t="s"><v>0</v></c></row>'.repeat(20_000);
    const entries = withEntry(withEntry(book(), { name: 'xl/sharedStrings.xml', data: shared, store: true }),
      { name: SHEET, data: `<worksheet><sheetData>${rows}</sheetData></worksheet>`, store: true });
    const started = Date.now();
    await fails(zip(entries), /longer than the limit/);
    // Cleaning the string per cell took 4.6 s here (and grows with cells x length); the cap now fires
    // after a few cells. The ceiling is generous for a loaded runner.
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('a wide slide table is charged for its structure before it is built', async () => {
    const head = `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>h</a:t></a:r></a:p></a:txBody></a:tc>${'<a:tc/>'.repeat(99_999)}</a:tr>`;
    const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${head}${'<a:tr/>'.repeat(1000)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const entries = withEntry(pptxEntries([{ shapes: [] }]), {
      name: 'ppt/slides/slide1.xml', data: slideXml({ shapes: [] }).replace('</p:spTree>', `${table}</p:spTree>`),
    });
    const started = Date.now();
    await expect(readPptx(zip(entries), { limits: { maxRatio: 1e6 } })).rejects.toThrow(/longer than the limit/);
    // Building 100 000 x 1 000 cells first would take minutes and gigabytes; the charge stops it early.
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('a text node, comment or tag over the token cap fails before it is decoded', async () => {
    const started = Date.now();
    await fails(workbookWithSheet(`<worksheet><sheetData><row><c t="str"><v>${'&amp;'.repeat(400_000)}</v></c></row></sheetData></worksheet>`),
      /tag or text longer than 1048576/, { limits: { maxRatio: 1e6 } });
    await fails(workbookWithSheet(`<worksheet><!--${'c'.repeat(1_100_000)}--></worksheet>`), /tag or text longer/, { limits: { maxRatio: 1e6 } });
    await fails(workbookWithSheet(`<worksheet a="${'x'.repeat(3_000_000)}`), /tag or text longer/, { limits: { maxRatio: 1e6 } });
    // Decoding 400 000 entities / 3 MB tokens before the cap check is what this guards; generous for load.
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('a very long number format is not read (numbers raw), and each format is worked out once', async () => {
    const code = 'yyyy'.repeat(250_000);
    const styles = `<numFmts count="1"><numFmt numFmtId="164" formatCode="${code}"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>`;
    const rows = [['h'], ...Array.from({ length: 2000 }, (_, i) => [{ v: String(40000 + i), s: 1 }])];
    const started = Date.now();
    const text = await readXlsx(xlsx([{ name: 'S', rows }], { styles }), { limits: { maxRatio: 1e6 } });
    expect(text).toContain('| 40000 |');
    // Working the 1 MB format out per cell (2000 times) took tens of seconds; once, milliseconds.
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('a cell beyond the last column', async () => {
    const cells = '<c><v>1</v></c>'.repeat(16_385);
    await fails(zip(withEntry(book(), { name: SHEET, data: `<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>` })),
      /beyond the last column/);
  });

  it('a slide table with a million rows', async () => {
    const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${'<a:tr/>'.repeat(1_000_000)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const entries = withEntry(pptxEntries([{ shapes: [] }]), {
      name: 'ppt/slides/slide1.xml', store: true,
      data: slideXml({ shapes: [] }).replace('</p:spTree>', `${table}</p:spTree>`),
    });
    await expect(readPptx(zip(entries), {})).rejects.toThrow(/^Could not read the PowerPoint file: a slide table has more than 100000 rows/);
  });

  it('a RangeError (a structure too large for a step) is a permanent read error, not a transient one', async () => {
    await expect(asDocumentRead('Excel', async () => { throw new RangeError('Maximum call stack size exceeded'); }))
      .rejects.toThrow(DocumentReadError);
  });
});

describe('PowerPoint limits and the time bound', () => {
  it('a hostile slide fails as a PowerPoint read error', async () => {
    const entries = withEntry(pptxEntries([{ shapes: [] }]), { name: 'ppt/slides/slide1.xml', data: '<!DOCTYPE x><p:sld/>' });
    await expect(readPptx(zip(entries), {})).rejects.toThrow(/^Could not read the PowerPoint file: .*DTD/);
  });

  it('a read past its time limit is a (transient) timeout', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => [i, `row ${i}`, i * 2]);
    const err = await readXlsx(xlsx([{ name: 'S', rows }]), { timeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionTimeoutError);
  });

  it('an over-long slide list fails before any slide is read', async () => {
    const pres = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${'<p:sldId id="1" r:id="x"/>'.repeat(10)}</p:sldIdLst></p:presentation>`;
    const entries = withEntry(pptxEntries([{ shapes: [] }]), { name: 'ppt/presentation.xml', data: pres });
    await expect(readPptx(zip(entries), { limits: { maxSlides: 5 } })).rejects.toThrow(/more than 5 slides/);
  });

  it('the output cap', async () => {
    const big = slideXml({ shapes: [{ text: ['word '.repeat(5000)] }] });
    const entries = withEntry(pptxEntries([{ shapes: [] }]), { name: 'ppt/slides/slide1.xml', data: big });
    await expect(readPptx(zip(entries), { limits: { maxOutputChars: 1000 } })).rejects.toThrow(/more than 1000 characters/);
  });
});
