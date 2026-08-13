/**
 * imageUtils.remoteUrlToDataUrl — the Task-1/Task-2 seam.
 *
 * responsesImagePlugin's own test suite (responses-image-plugin.test.ts) mocks
 * `imageUtils` wholesale, so `remoteUrlToDataUrl` itself never executes in that
 * suite — it only proves the plugin CALLS it and reacts correctly to whatever it
 * resolves or rejects with. Nothing there proves the string this function actually
 * PRODUCES is one requestTranslator.ts's `textBlocks` will accept: a typo in the
 * `data:${mediaType};base64,${base64Image}` template (imageUtils.ts:67-71) would
 * ship green through both that suite and this whole file's data-URL-shaped fixtures
 * in orchestration-request-translator.test.ts, and only surface in Task 3's live run.
 *
 * This file exercises `remoteUrlToDataUrl` UNMOCKED, stubbing only the network
 * primitive beneath it (axios), and feeds its real output through the real
 * `responsesInputToMessages` (no mocking there either) to pin the seam itself, not
 * just the helper in isolation.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGet = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockGet(...args) },
}));

import { remoteUrlToDataUrl } from '../src/utils/imageUtils';
import { responsesInputToMessages } from '../src/responses/orchestrationBridge/requestTranslator';

// A real 1x1 pink PNG, the same one the plan's live probes used to confirm the
// target shape — not a placeholder string, so a base64-encoding bug (wrong
// buffer, wrong encoding) would show up as a malformed data: URL too, not just a
// wrong media type.
const PINK_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeEach(() => { mockGet.mockReset(); });

describe('remoteUrlToDataUrl (unmocked) — the Task-1/Task-2 seam', () => {
  it('produces a data:image/… URL that starts with the gate textBlocks checks for', async () => {
    mockGet.mockResolvedValue({ data: Buffer.from(PINK_PNG_BASE64, 'base64') });

    const dataUrl = await remoteUrlToDataUrl('http://example.com/cat.png');

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.slice(dataUrl.indexOf(',') + 1)).toBe(PINK_PNG_BASE64);
  });

  it('THE SEAM: its real output is accepted by the real textBlocks, not just shaped like it should be', async () => {
    mockGet.mockResolvedValue({ data: Buffer.from(PINK_PNG_BASE64, 'base64') });
    const dataUrl = await remoteUrlToDataUrl('http://example.com/cat.png');

    // No mock of requestTranslator anywhere in this file — this is the real gate
    // (requestTranslator.ts:88, `/^data:image\//i`) a typo in the template above
    // would fail, and Task 1's own tests (which hand-write their data: URL
    // fixtures) cannot catch that.
    const msgs = responsesInputToMessages([{
      type: 'message', role: 'user',
      content: [{ type: 'input_image', image_url: dataUrl }],
    }]);

    expect(msgs).toEqual([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: dataUrl } }],
    }]);
  });

  it('media type follows the url extension, not a hardcoded default', async () => {
    mockGet.mockResolvedValue({ data: Buffer.from('not really a gif', 'utf8') });

    const dataUrl = await remoteUrlToDataUrl('http://example.com/anim.gif');

    expect(dataUrl.startsWith('data:image/gif;base64,')).toBe(true);
  });

  it('propagates a download failure rather than producing a data: URL', async () => {
    mockGet.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(remoteUrlToDataUrl('http://bad.example.com/cat.png')).rejects.toThrow();
  });
});
