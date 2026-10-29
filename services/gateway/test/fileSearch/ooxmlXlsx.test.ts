// The built-in Excel reader: sheets in workbook order, each a `## Sheet: <name>` section holding one
// pipe table (first non-empty row = header, empty rows and columns dropped), cached formula values,
// dates and percentages displayed where cheap; large sheets split by rows with the header carried.
import { readXlsx } from '../../src/fileSearch/extractors/ooxml/xlsx';
import { DocumentReadError } from '../../src/fileSearch/extractors/ooxml/limits';
import { extractStructuredText, extractText, isPagedFile, isSupportedExtension } from '../../src/fileSearch/extractors/registry';
import { chunkStructuredWithSections } from '../../src/fileSearch/structureChunker';
import { xlsx, xlsxEntries, zip, withEntry, withoutEntry, SheetSpec } from './fixtures/ooxmlFixtures';

const STYLES = '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="&quot;d&quot;0.00"/></numFmts>'
  + '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>'
  + '<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="9"/><xf numFmtId="10"/><xf numFmtId="165"/></cellXfs>';

const BOOK: SheetSpec[] = [
  {
    name: 'Sales',
    rows: [
      [],
      [null, 'Region', 'Q1', null, 'Note'],
      [null, 'North', 10, null, 'ok | fine'],
      [],
      [null, 'South', 0.30000000000000004, null, { inline: 'two\nlines' }],
      [null, 'Total', { v: '10.3', f: 'SUM(C3:C5)' }, null, { v: 'computed', t: 'str', f: 'A1' }],
      [null, 'Flag', true, null, { v: '#DIV/0!', t: 'e' }],
    ],
  },
  { name: 'Empty', rows: [[], [null, null]] },
  {
    name: 'Dates & more',
    state: 'hidden',
    rows: [
      ['When', 'Stamp', 'Share', 'Precise', 'Custom'],
      [{ v: '45000', s: 1 }, { v: '45000.5', s: 2 }, { v: '0.125', s: 3 }, { v: '0.12345', s: 4 }, { v: '3.5', s: 5 }],
    ],
  },
];

const EXPECTED = [
  '## Sheet: Sales\n\n| Region | Q1 | Note |\n| --- | --- | --- |\n| North | 10 | ok \\| fine |\n| South | 0.3 | two lines |\n'
    + '| Total | 10.3 | computed |\n| Flag | TRUE | #DIV/0! |\n',
  '## Sheet: Dates & more (hidden)\n\n| When | Stamp | Share | Precise | Custom |\n| --- | --- | --- | --- | --- |\n'
    + '| 2023-03-15 | 2023-03-15 12:00 | 13% | 12.35% | 3.5 |\n',
].join('\n');

describe('readXlsx', () => {
  it('renders each non-empty sheet as a pipe table in workbook order', async () => {
    expect(await readXlsx(xlsx(BOOK, { styles: STYLES }), {})).toBe(EXPECTED);
  });

  it('without a styles part, numbers stay raw (cleaned of float noise)', async () => {
    const text = await readXlsx(xlsx([BOOK[2]]), {});
    expect(text).toBe('## Sheet: Dates & more (hidden)\n\n| When | Stamp | Share | Precise | Custom |\n| --- | --- | --- | --- | --- |\n'
      + '| 45000 | 45000.5 | 0.125 | 0.12345 | 3.5 |\n');
  });

  it('number formats come from numFmts only; padding and fill codes do not make a date', async () => {
    const styles = '<numFmts count="2"><numFmt numFmtId="164" formatCode="_-* #,##0_-;_-* &quot;-&quot;_-"/><numFmt numFmtId="165" formatCode="0.0*s"/></numFmts>'
      + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs>'
      + '<dxfs count="1"><dxf><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/></dxf></dxfs>';
    const text = await readXlsx(xlsx([{ name: 'S', rows: [['a', 'b', 'c'], [{ v: '45000', s: 1 }, { v: '45000', s: 2 }, { v: '45000', s: 3 }]] }], { styles }), {});
    expect(text).toContain('| 45000 | 45000 | 45000 |');
  });

  it('the 1904 date system', async () => {
    const text = await readXlsx(xlsx([{ name: 'S', rows: [['d'], [{ v: '0', s: 1 }]] }], { styles: STYLES, date1904: true }), {});
    expect(text).toContain('| 1904-01-01 |');
  });

  it('rich shared strings join their runs and leave out phonetic hints; _xHHHH_ escapes are decoded', async () => {
    const entries = withEntry(xlsxEntries([{ name: 'S', rows: [['x'], ['y']] }]), {
      name: 'xl/sharedStrings.xml',
      data: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Bold</t></r><r><t xml:space="preserve"> part</t></r>'
        + '<rPh sb="0" eb="1"><t>HINT</t></rPh></si><si><t>a_x000D_b_x0041_</t></si></sst>',
    });
    expect(await readXlsx(zip(entries), {})).toBe('## Sheet: S\n\n| Bold part |\n| --- |\n| a bA |\n');
  });

  it('cells without references follow on from the previous cell and row', async () => {
    const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row><c t="inlineStr"><is><t>h1</t></is></c><c t="inlineStr"><is><t>h2</t></is></c></row>'
      + '<row><c><v>1</v></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>';
    const entries = withEntry(xlsxEntries([{ name: 'S', rows: [] }]), { name: 'xl/worksheets/sheet1.xml', data: sheet });
    expect(await readXlsx(zip(entries), {})).toBe('## Sheet: S\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n');
  });

  it('a workbook with only empty sheets reads as empty text', async () => {
    expect(await readXlsx(xlsx([{ name: 'A', rows: [] }]), {})).toBe('');
  });

  it('missing shared strings that a cell needs fail the file; an unused missing part does not', async () => {
    await expect(readXlsx(xlsx([{ name: 'S', rows: [['text']] }], { sharedStrings: false }), {})).rejects.toThrow(/shared strings/);
    expect(await readXlsx(xlsx([{ name: 'S', rows: [[1]] }], { sharedStrings: false }), {})).toBe('## Sheet: S\n\n| 1 |\n| --- |\n');
  });

  it('a missing workbook or sheet part fails the file', async () => {
    await expect(readXlsx(zip(withoutEntry(xlsxEntries(BOOK), 'xl/workbook.xml')), {})).rejects.toThrow(/Excel.*workbook part is missing/);
    await expect(readXlsx(zip(withoutEntry(xlsxEntries(BOOK), 'xl/worksheets/sheet1.xml')), {})).rejects.toThrow(DocumentReadError);
  });

  it('too many cells', async () => {
    const rows = Array.from({ length: 4 }, (_, r) => [r, r]);
    await expect(readXlsx(xlsx([{ name: 'S', rows }]), { limits: { maxCells: 7 } })).rejects.toThrow(/more than 7 cells/);
  });
});

describe('the registry and the structure chunker', () => {
  it('accepts .xlsx (not paged), the same text for both strategies', async () => {
    expect(isSupportedExtension('XLSX')).toBe(true);
    expect(isPagedFile('book.xlsx')).toBe(false);
    const bytes = xlsx(BOOK, { styles: STYLES });
    expect(await extractText('book.xlsx', bytes, {})).toBe(EXPECTED);
    expect(await extractStructuredText('book.xlsx', bytes, {})).toEqual({ text: EXPECTED, format: 'markdown' });
  });

  it('a large sheet splits by rows and every continuation carries the header', async () => {
    const rows = [['Id', 'Name', 'Amount'], ...Array.from({ length: 400 }, (_, i) => [i, `Customer ${i}`, i * 3])];
    const text = await readXlsx(xlsx([{ name: 'Big', rows }]), {});
    const { chunks } = chunkStructuredWithSections(text, { maxTokens: 200, overlapTokens: 0, format: 'markdown' });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.headingPath).toBe('Sheet: Big');
      const lines = c.text.split('\n').filter((l) => l.startsWith('|'));
      for (const l of lines) expect(l.split(' | ')).toHaveLength(3); // rows are never cut
    }
    for (const c of chunks.slice(1)) expect(c.tableHeader).toBe('| Id | Name | Amount |\n| --- | --- | --- |');
  });
});
