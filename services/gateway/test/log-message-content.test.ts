/**
 * Conversation content is for the console only: a log line that carries a piece of a request or of
 * model output still prints it on the console (as metadata), but the entry the gateway ships for
 * the stored log carries only what happened and where - never the content.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../src/services/modelService', () => ({ __esModule: true, default: {} }));
const mockGet: jest.Mock<any> = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { get: (...a: any[]) => (mockGet as any)(...a), post: jest.fn() } }));
const mockRunExtractor: jest.Mock<any> = jest.fn();
const mockReadOffice: jest.Mock<any> = jest.fn();
const mockReadLegacyDoc: jest.Mock<any> = jest.fn();
jest.mock('../src/fileSearch/extractors/runners', () => ({ runExtractor: (...a: any[]) => (mockRunExtractor as any)(...a) }));
jest.mock('../src/fileSearch/extractors/ooxml/ooxmlThread', () => ({ readOfficeOffThread: (...a: any[]) => (mockReadOffice as any)(...a) }));
jest.mock('../src/fileSearch/extractors/legacyDoc', () => ({
  isLegacyDocEnabled: () => true,
  readLegacyDoc: (...a: any[]) => (mockReadLegacyDoc as any)(...a),
}));

import { extractSystemPromptText } from '../src/services/anthropicUtils';
import { transformSAPResponseToAnthropic } from '../src/services/anthropicResponseService';
import { validateAndCleanSchema } from '../src/services/anthropicSchemaUtils';
import BedrockStreamParser from '../src/utils/bedrockStreamParser';
import { downloadAndEncodeImage } from '../src/utils/imageUtils';
import { extractText, extractStructuredText } from '../src/fileSearch/extractors/registry';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';

describe('conversation content stays out of the shipped log', () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleLines = [];
    shipped = [];
    for (const m of ['info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((l: unknown) => { consoleLines.push(String(l)); });
    }
    stop = startLogShipper({ publish: async (b) => { shipped.push(...b); }, settings: () => ({ enabled: true, minLevel: 'INFO' }), warn: () => undefined });
    mockGet.mockReset();
  });
  afterEach(() => { stop(); jest.useRealTimers(); jest.restoreAllMocks(); });

  /** The console line holding the marker, and the shipped entry of that same line. */
  const lineAndEntry = async (message: string | RegExp): Promise<{ line: string; entry: ShippedLogEntry }> => {
    await jest.advanceTimersByTimeAsync(1000);
    const matches = (text: string) => (typeof message === 'string' ? text.includes(message) : message.test(text));
    const line = consoleLines.find((l) => matches(l) && l.includes(MARKER));
    const entry = shipped.find((e) => matches(e.message));
    expect(line).toBeDefined();
    expect(entry).toBeDefined();
    expect(JSON.stringify(shipped)).not.toContain(MARKER);
    return { line: line as string, entry: entry as ShippedLogEntry };
  };

  it('an unrecognised system prompt: the console line holds it, the shipped entry does not', async () => {
    extractSystemPromptText({ unexpected: MARKER } as any);
    const { entry } = await lineAndEntry('Unrecognized system prompt format');
    expect(entry.message).toContain('Defaulting to empty string');
  });

  it("a tool call's unparsable arguments: on the console, not in the shipped entry", async () => {
    await transformSAPResponseToAnthropic({
      final_result: { choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: `{ ${MARKER}` } }] }, finish_reason: 'tool_calls' }] },
    } as any, false, 'claude-test');
    const { entry } = await lineAndEntry('Failed to parse tool arguments');
    expect(entry.level).toBe('WARN');
  });

  it("a tool's invalid schema value: on the console, not in the shipped entry", async () => {
    validateAndCleanSchema({ type: 'object', properties: { note: MARKER as any } } as any, 'lookup');
    const { entry } = await lineAndEntry("Property 'note' has invalid schema");
    expect(entry.message).toContain('(type: string)');
  });

  it('Bedrock stream data that is not JSON: on the console, not in the shipped entry', async () => {
    const parser: any = new BedrockStreamParser('anthropic.claude-test', '/invoke-with-response-stream');
    parser.res = { writableEnded: false, write: jest.fn(), end: jest.fn(), setHeader: jest.fn() };
    parser.handleData(`{ ${MARKER} is not json }`);
    await lineAndEntry('Failed to parse data as JSON');
  });

  it("an image URL from the request: on the console, not in the shipped entry", async () => {
    mockGet.mockResolvedValue({ data: Buffer.from('png') });
    await downloadAndEncodeImage(`https://example.org/${MARKER}.png?sig=abc`);
    await lineAndEntry('Downloading image from URL');
  });

  describe('a file whose reading fails: the console line names the file, the shipped entry does not', () => {
    const fail = () => Promise.reject(new Error('the reader exited with code 1'));
    beforeEach(() => {
      mockRunExtractor.mockImplementation(fail);
      mockReadOffice.mockImplementation(fail);
      mockReadLegacyDoc.mockImplementation(fail);
    });

    it.each([
      ['pandoc (plain)', () => extractText(`${MARKER}.docx`, Buffer.from('x'), { timeoutMs: 1000 }), 'pandoc extraction failed for .docx file'],
      ['pandoc (structured)', () => extractStructuredText(`${MARKER}.docx`, Buffer.from('x'), { timeoutMs: 1000 }), 'pandoc extraction failed for .docx file'],
      ['pdftotext', () => extractText(`${MARKER}.pdf`, Buffer.from('x'), { timeoutMs: 1000 }), 'pdftotext extraction failed'],
      ['the Office reader', () => extractText(`${MARKER}.pptx`, Buffer.from('x'), { timeoutMs: 1000 }), '.pptx extraction failed'],
      ['antiword', () => extractText(`${MARKER}.doc`, Buffer.from('x'), { timeoutMs: 1000 }), 'antiword extraction failed for .doc file'],
    ])('%s', async (_name, run, message) => {
      await expect(run()).rejects.toThrow('the reader exited with code 1');
      const { entry } = await lineAndEntry(message);
      expect(entry).toMatchObject({ level: 'ERROR', error: 'Error: the reader exited with code 1' });
    });
  });
});
