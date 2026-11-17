// pandoc reads uploaded documents only inside its sandbox (--sandbox, pandoc 2.15 and later). An
// older or unreadable pandoc is refused, once, with a warning: the extractor never runs pandoc
// without the sandbox. No pandoc binary needed: the runner is mocked.

const mockRunExtractor = jest.fn();
jest.mock('../../src/fileSearch/extractors/runners', () => ({
  ...jest.requireActual('../../src/fileSearch/extractors/runners'),
  runExtractor: (...a: any[]) => mockRunExtractor(...a),
}));
const mockWarn = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ warn: (...a: any[]) => mockWarn(...a), error: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import { pandocSupportsSandbox, resetPandocSandboxCheck, PandocTooOldError } from '../../src/fileSearch/extractors/pandocSandbox';
import { extractText, extractStructuredText } from '../../src/fileSearch/extractors/registry';

describe('pandocSupportsSandbox', () => {
  it.each([
    ['pandoc 2.14.2\nCompiled with pandoc-types 1.22', false],
    ['pandoc 2.9.2.1\n', false],
    ['pandoc 1.19.2.4', false],
    ['pandoc 2.15\n', true],
    ['pandoc 2.19.2', true],
    ['pandoc 3.1.3\nFeatures: +server +lua', true],
    ['pandoc.exe 3.10.1', true],
    ['', false],
    ['not pandoc at all', false],
    ['pandoc version unknown', false],
  ])('%j -> %s', (out, ok) => expect(pandocSupportsSandbox(out)).toBe(ok));
});

describe('the extractor runs pandoc only with --sandbox', () => {
  beforeEach(() => {
    resetPandocSandboxCheck();
    mockRunExtractor.mockReset();
    mockWarn.mockReset();
  });

  it('passes --sandbox to every pandoc run', async () => {
    mockRunExtractor.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === '--version' ? 'pandoc 3.1.3\n' : 'text'));
    await extractText('a.rst', Buffer.from('x'), { timeoutMs: 1000 });
    await extractStructuredText('b.docx', Buffer.from('x'), { timeoutMs: 1000 });
    const runs = mockRunExtractor.mock.calls.filter((c) => c[0] === 'pandoc' && c[1][0] !== '--version');
    expect(runs).toHaveLength(2);
    for (const [, args] of runs) expect(args).toContain('--sandbox');
  });

  it('refuses a pandoc older than 2.15 without running it on the document, and warns once', async () => {
    mockRunExtractor.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === '--version' ? 'pandoc 2.9.2.1\n' : 'text'));
    await expect(extractText('a.rst', Buffer.from('x'), { timeoutMs: 1000 })).rejects.toBeInstanceOf(PandocTooOldError);
    await expect(extractText('b.odt', Buffer.from('x'), { timeoutMs: 1000 })).rejects.toBeInstanceOf(PandocTooOldError);
    expect(mockRunExtractor.mock.calls.filter((c) => c[1][0] !== '--version')).toHaveLength(0);
    expect(mockRunExtractor.mock.calls.filter((c) => c[1][0] === '--version')).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('refuses when the version cannot be read', async () => {
    mockRunExtractor.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === '--version' ? 'garbage' : 'text'));
    await expect(extractText('a.epub', Buffer.from('x'), { timeoutMs: 1000 })).rejects.toBeInstanceOf(PandocTooOldError);
  });

  it('the uploader is told the type cannot be converted here, without the version; the one warning holds the version', async () => {
    mockRunExtractor.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === '--version' ? 'pandoc 2.9.2.1\n' : 'text'));
    const error: any = await extractText('a.rst', Buffer.from('x'), { timeoutMs: 1000 }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(PandocTooOldError);
    expect(error.message).toBe('Files of this type cannot be converted on this installation. The administrator has been told.');
    expect(error.message).not.toMatch(/\d+\.\d+|pandoc/i);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0][1])).toContain('2.9');
  });
});
