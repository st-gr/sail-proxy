// An uploaded document must not make pandoc read another file of the gateway's machine. Against
// the real pandoc binary, like extractors.test.ts: skipped unless FILE_SEARCH_TEST_BINARIES=1
// (CI installs pandoc and sets it). Every file-inclusion mechanism of the formats the extractor
// hands to pandoc points at a temp file outside the upload; the extracted text never holds it.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { extractText, extractStructuredText } from '../../../src/fileSearch/extractors/registry';
import { runExtractorBuffer } from '../../../src/fileSearch/extractors/runners';

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const d = RUN_BINARY_TESTS ? describe : describe.skip;
if (!RUN_BINARY_TESTS) {
  // eslint-disable-next-line no-console
  console.info('extractorSandbox.test.ts skipped: set FILE_SEARCH_TEST_BINARIES=1 with pandoc installed to run it');
}

const MARKER = 'SECRET-MARKER-of-Jane-Roe';

// A refused document makes the extractor log an ERROR; the noise is expected here.
beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

d('pandoc cannot be made to read files outside the upload (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  let dir: string;
  let secretTxt: string;
  let secretCsv: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-secret-'));
    secretTxt = path.join(dir, 'secret.txt');
    secretCsv = path.join(dir, 'secret.csv');
    fs.writeFileSync(secretTxt, `${MARKER}\n`);
    fs.writeFileSync(secretCsv, `a,b\n${MARKER},2\n`);
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const rst = (directive: () => string) => Buffer.from(`Title\n=====\n\nBefore.\n\n${directive()}\n\nAfter.\n`, 'utf8');
  const cases: Array<[string, () => Buffer]> = [
    ['rst .. include::', () => rst(() => `.. include:: ${secretTxt}`)],
    ['rst .. include:: relative to the working directory', () => rst(() => `.. include:: ${path.relative(os.tmpdir(), secretTxt)}`)],
    ['rst .. csv-table:: :file:', () => rst(() => `.. csv-table:: T\n   :file: ${secretCsv}`)],
    ['rst .. raw:: :file:', () => rst(() => `.. raw:: html\n   :file: ${secretTxt}`)],
  ];

  it.each(cases)('%s: the extracted text never holds the other file', async (_name, doc) => {
    for (const run of [
      () => extractText('upload.rst', doc(), { timeoutMs: 20_000 }),
      () => extractStructuredText('upload.rst', doc(), { timeoutMs: 20_000 }).then((r) => r.text),
    ]) {
      let out = '';
      try {
        out = await run();
      } catch (error: any) {
        // a clean refusal is fine; the error must not carry the file either
        expect(String(error?.message)).not.toContain(MARKER);
      }
      expect(out).not.toContain(MARKER);
    }
  });

  // pandoc reads no outside reference of these formats; what is tested is that they still convert
  // with the sandbox on. The fixtures are built by pandoc itself, and a failed build fails the test.
  it.each(['docx', 'odt', 'epub'])('a .%s upload still converts with the sandbox on', async (to) => {
    const doc = await runExtractorBuffer('pandoc', ['-f', 'markdown', '-t', to],
      Buffer.from('# Quarterly notes\n\nThe converted paragraph of Jane Roe.\n', 'utf8'), { timeoutMs: 30_000 });
    expect(doc.length).toBeGreaterThan(0);
    expect(await extractText(`upload.${to}`, doc, { timeoutMs: 20_000 })).toContain('The converted paragraph of Jane Roe.');
    expect((await extractStructuredText(`upload.${to}`, doc, { timeoutMs: 20_000 })).text).toContain('The converted paragraph of Jane Roe.');
  });

  it('a plain .rst still extracts', async () => {
    expect(await extractText('upload.rst', Buffer.from('Title\n=====\n\nHello sandbox.\n'), { timeoutMs: 20_000 })).toContain('Hello sandbox.');
  });
});

// A document must not make the gateway fetch an address either: pandoc's reStructuredText reader
// can ask for a URL, and what comes back would be searchable text. A local server records every
// request; the test first proves, with the sandbox switched off, that this pandoc fetches at all.
d('pandoc cannot be made to fetch an address (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  const FETCH_MARKER = 'FETCHED-MARKER-of-Jane-Roe';
  let server: http.Server;
  let requests: string[];
  let url: string;
  let doc: Buffer;

  beforeAll(async () => {
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(String(req.url));
      res.end(`a,b\n${FETCH_MARKER},2\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/table.csv`;
    doc = Buffer.from(`Title\n=====\n\n.. csv-table:: T\n   :url: ${url}\n\nAfter.\n`, 'utf8');
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => { requests.length = 0; });

  const pandocWithoutSandbox = (input: Buffer): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile('pandoc', ['-f', 'rst', '-t', 'plain'], { timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin!.end(input);
  });

  it('the extractor sends no request and the text never holds the response', async () => {
    // The comparison: without the sandbox this pandoc does fetch. If it does not, say so and skip it.
    const unsandboxed = await pandocWithoutSandbox(doc).catch(() => '');
    const fetchesWithoutSandbox = requests.length > 0 && unsandboxed.includes(FETCH_MARKER);
    if (!fetchesWithoutSandbox) {
      // eslint-disable-next-line no-console
      console.warn('this pandoc does not fetch the address even without --sandbox: the comparison is skipped, the test below proves only that nothing arrived');
    }
    requests.length = 0;

    for (const run of [
      () => extractText('upload.rst', doc, { timeoutMs: 20_000 }),
      () => extractStructuredText('upload.rst', doc, { timeoutMs: 20_000 }).then((r) => r.text),
    ]) {
      let out = '';
      try {
        out = await run();
      } catch (error: any) {
        expect(String(error?.message)).not.toContain(FETCH_MARKER);
      }
      expect(out).not.toContain(FETCH_MARKER);
    }
    expect(requests).toEqual([]);
  });
});
