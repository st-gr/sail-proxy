/**
 * Orchestration streams in character chunks. At 800 characters a short answer reached Claude Code
 * in two frames, the first only after about three seconds, so an interactive session looked frozen
 * and then dumped the text. A request without its own size gets the 200 the chat-completions and
 * Gemini paths ask for. An already aborted request returns before any upstream call, which keeps
 * this at the payload the service would send.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, currentSapTarget: () => ({}) }));

import { streamChatCompletion } from '../src/services/sapAIService';

async function chunkSizeFor(stream: any): Promise<number | undefined> {
  const payload: any = { config: { stream } };
  await streamChatCompletion(payload, () => {}, undefined, { aborted: true } as any);
  return payload.config.stream.chunk_size;
}

describe('streamChatCompletion chunk size', () => {
  it('asks for 200 characters when the request sets none', async () => {
    expect(await chunkSizeFor({ enabled: true })).toBe(200);
  });

  it('replaces a size under the minimum of 64 with the same default', async () => {
    expect(await chunkSizeFor({ enabled: true, chunk_size: 10 })).toBe(200);
  });

  it('keeps a size the caller chose', async () => {
    expect(await chunkSizeFor({ enabled: true, chunk_size: 500 })).toBe(500);
  });
});
