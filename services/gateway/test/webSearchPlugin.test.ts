/**
 * Web Search Plugin Tests
 *
 * Tests that the afterHandler filters out intermediate blocks
 * (server_tool_use, web_search_tool_result) from the response,
 * matching 1P Anthropic API behavior.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies before importing the plugin
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getDeploymentId: () => Promise.resolve('mock-deployment-id'),
    getAccessToken: () => Promise.resolve('mock-token'),
  },
}));

// Mock deployment discovery — returns a direct Perplexity deployment by default
jest.mock('../src/services/deploymentDiscoveryService', () => ({
  __esModule: true,
  getPerplexityDeploymentId: () => Promise.resolve('mock-perplexity-deployment'),
}));

// Default mock response: direct Perplexity API format (top-level citations/search_results)
const defaultMockResponse = {
  data: {
    choices: [{
      message: {
        content: JSON.stringify({
          summary: 'Test summary of results.',
          results: [
            {
              title: 'Test Result 1',
              url: 'https://hallucinated.example.com/1',
              snippet: 'This is a test result snippet.',
              content: 'Full content of test result 1.',
              date: '2026-04-10'
            },
            {
              title: 'Test Result 2',
              url: 'https://hallucinated.example.com/2',
              snippet: 'Another test result.',
              content: 'Full content of test result 2.',
              date: '2026-04-10'
            }
          ]
        })
      }
    }],
    citations: [
      'https://real-citation-1.com/article',
      'https://real-citation-2.com/page'
    ],
    search_results: [
      {
        title: 'Real Result 1',
        url: 'https://real-citation-1.com/article',
        date: '2026-04-08',
        snippet: 'Real snippet from search API for result 1.'
      },
      {
        title: 'Real Result 2',
        url: 'https://real-citation-2.com/page',
        date: '2026-04-09',
        snippet: 'Real snippet from search API for result 2.'
      }
    ]
  }
};

const mockAxiosPost = jest.fn((): Promise<any> => Promise.resolve(defaultMockResponse));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => (mockAxiosPost as any)(...args),
  },
}));

jest.mock('fs', () => ({
  readFileSync: () => 'Mock system prompt for web search',
  existsSync: () => true,
}));

// Import plugin rules (the module's default export)
import pluginRules = require('../src/plugins/webSearchPlugin');

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

describe('webSearchPlugin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Extract the after handler from plugin rules
  const afterRule = (pluginRules as any[]).find(
    (r: any) => r.strategy === 'after'
  );
  const afterHandler = afterRule?.handler;

  if (!afterHandler) {
    throw new Error('Could not find after handler in webSearchPlugin rules');
  }

  describe('afterHandler — response block filtering', () => {
    it('should return only text blocks (no server_tool_use or web_search_tool_result)', async () => {
      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'What is today?' }],
          },
        },
        upstreamResponse: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            { type: 'text', text: "I'll search for that." },
            {
              type: 'tool_use',
              id: 'toolu_test_123',
              name: 'web_search',
              input: { query: "today's date" },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      // Verify no intermediate blocks
      const blockTypes = result.content.map((b: any) => b.type);
      expect(blockTypes).not.toContain('server_tool_use');
      expect(blockTypes).not.toContain('web_search_tool_result');

      // All blocks should be text
      for (const block of result.content) {
        expect(block.type).toBe('text');
      }
    });

    it('should preserve citations on the final text block with real URLs from API', async () => {
      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'Search for hello' }],
          },
        },
        upstreamResponse: {
          id: 'msg_test2',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            { type: 'text', text: 'Searching.' },
            {
              type: 'tool_use',
              id: 'toolu_test_456',
              name: 'web_search',
              input: { query: 'hello' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      // Find the text block with citations (should be the last one)
      const citedBlock = result.content.find(
        (b: any) => b.type === 'text' && b.citations
      );
      expect(citedBlock).toBeDefined();
      expect(citedBlock.citations).toBeInstanceOf(Array);
      expect(citedBlock.citations.length).toBeGreaterThan(0);

      // Each citation should have url, title, cited_text
      for (const citation of citedBlock.citations) {
        expect(citation.type).toBe('web_search_result_location');
        expect(citation.url).toBeDefined();
        expect(citation.title).toBeDefined();
        expect(citation.cited_text).toBeDefined();
      }

      // URLs should be the real ones from API search_results, not hallucinated
      expect(citedBlock.citations[0].url).toBe('https://real-citation-1.com/article');
      expect(citedBlock.citations[1].url).toBe('https://real-citation-2.com/page');
    });

    it('should preserve original text blocks from before tool_use', async () => {
      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test' }],
          },
        },
        upstreamResponse: {
          id: 'msg_test3',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            { type: 'text', text: 'Let me search for that.' },
            {
              type: 'tool_use',
              id: 'toolu_test_789',
              name: 'web_search',
              input: { query: 'test query' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      // First text block should be the original "Let me search for that."
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('Let me search for that.');

      // Should have at least 2 text blocks (original + summary with citations)
      expect(result.content.length).toBeGreaterThanOrEqual(2);
    });

    it('should set stop_reason to end_turn', async () => {
      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test' }],
          },
        },
        upstreamResponse: {
          id: 'msg_test4',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test_abc',
              name: 'web_search',
              input: { query: 'test' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);
      expect(result.stop_reason).toBe('end_turn');
    });

    it('should pass through unchanged if no web_search tool in request', async () => {
      const upstreamResponse = {
        id: 'msg_passthrough',
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      };

      const context = {
        req: {
          body: {
            tools: [{ name: 'some_other_tool', input_schema: {} }],
            messages: [{ role: 'user', content: 'hi' }],
          },
        },
        upstreamResponse,
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);
      expect(result).toBe(upstreamResponse); // Same reference — not modified
    });

    it('should fall back to LLM content when no API citations/search_results', async () => {
      // Override mock to return response without citations/search_results
      // (simulates orchestration path where Perplexity fields are stripped)
      mockAxiosPost.mockImplementationOnce(() => Promise.resolve({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                summary: 'Fallback summary.',
                results: [
                  {
                    title: 'LLM Result',
                    url: 'https://hallucinated-url.com',
                    snippet: 'LLM-generated snippet.',
                    content: 'LLM-generated content.',
                    date: '2026-04-10'
                  }
                ]
              })
            }
          }]
        }
      }));

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test fallback' }],
          },
        },
        upstreamResponse: {
          id: 'msg_fallback',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_fallback',
              name: 'web_search',
              input: { query: 'test fallback' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      // Should still produce text blocks with results
      const citedBlock = result.content.find(
        (b: any) => b.type === 'text' && b.citations
      );
      expect(citedBlock).toBeDefined();
      // URL will be the hallucinated one since no API citations available
      expect(citedBlock.citations[0].url).toBe('https://hallucinated-url.com');

      // Verify warning was logged about fallback
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('falling back to LLM content parsing')
      );
    });

    it('should use citations array to replace LLM URLs when search_results absent', async () => {
      // Override mock: citations present but no search_results
      // (direct API may return citations without search_results)
      mockAxiosPost.mockImplementationOnce(() => Promise.resolve({
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                summary: 'Summary with citations only.',
                results: [
                  {
                    title: 'LLM Title',
                    url: 'https://hallucinated.com',
                    snippet: 'LLM snippet.',
                    content: 'LLM content.',
                    date: '2026-04-10'
                  }
                ]
              })
            }
          }],
          citations: ['https://real-url-from-citations.com/page']
        }
      }));

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test citations' }],
          },
        },
        upstreamResponse: {
          id: 'msg_citations',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_citations',
              name: 'web_search',
              input: { query: 'test citations' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      const citedBlock = result.content.find(
        (b: any) => b.type === 'text' && b.citations
      );
      expect(citedBlock).toBeDefined();
      // URL should be replaced with real citation URL
      expect(citedBlock.citations[0].url).toBe('https://real-url-from-citations.com/page');
    });

    it('should pass through unchanged if response has no tool_use for web_search', async () => {
      const upstreamResponse = {
        id: 'msg_no_tool_use',
        content: [{ type: 'text', text: 'Just a normal reply.' }],
        stop_reason: 'end_turn',
      };

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'hello' }],
          },
        },
        upstreamResponse,
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);
      expect(result).toBe(upstreamResponse); // Same reference — not modified
    });
  });

  describe('afterHandler — orchestration v2 path', () => {
    // For these tests, force the orchestration path by making Perplexity deployment unavailable
    const deploymentDiscoveryMock = jest.requireMock('../src/services/deploymentDiscoveryService') as any;

    it('should handle orchestration v2 structured citations (ref_id/title/url objects)', async () => {
      // Force orchestration path
      deploymentDiscoveryMock.getPerplexityDeploymentId = () => Promise.resolve(null);

      const v2LlmContent = JSON.stringify({
        summary: 'V2 orchestration summary.',
        results: [
          {
            title: 'LLM Hallucinated Title 1',
            url: 'https://hallucinated-v2.com/1',
            snippet: 'LLM snippet 1.',
            content: 'LLM content 1.',
            date: '2026-04-12'
          },
          {
            title: 'LLM Hallucinated Title 2',
            url: 'https://hallucinated-v2.com/2',
            snippet: 'LLM snippet 2.',
            content: 'LLM content 2.',
            date: '2026-04-12'
          }
        ]
      });

      mockAxiosPost.mockImplementationOnce(() => Promise.resolve({
        data: {
          request_id: 'test-v2-request-id',
          intermediate_results: {
            templating: [{ role: 'user', content: 'test' }],
            llm: {
              choices: [{ message: { content: v2LlmContent }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
              citations: [
                { ref_id: 1, title: 'Real V2 Title 1', url: 'https://real-v2-citation-1.com/article' },
                { ref_id: 2, title: 'Real V2 Title 2', url: 'https://real-v2-citation-2.com/page' }
              ]
            }
          },
          final_result: {
            choices: [{ message: { content: v2LlmContent }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            citations: [
              { ref_id: 1, title: 'Real V2 Title 1', url: 'https://real-v2-citation-1.com/article' },
              { ref_id: 2, title: 'Real V2 Title 2', url: 'https://real-v2-citation-2.com/page' }
            ]
          }
        }
      }));

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test v2' }],
          },
        },
        upstreamResponse: {
          id: 'msg_v2_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            { type: 'text', text: 'Searching via orchestration v2.' },
            {
              type: 'tool_use',
              id: 'toolu_v2_test',
              name: 'web_search',
              input: { query: 'test v2 query' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      const result = await afterHandler(context);

      // Should have text blocks with citations
      const citedBlock = result.content.find(
        (b: any) => b.type === 'text' && b.citations
      );
      expect(citedBlock).toBeDefined();
      expect(citedBlock.citations.length).toBe(2);

      // URLs should be from v2 structured citations, not hallucinated
      expect(citedBlock.citations[0].url).toBe('https://real-v2-citation-1.com/article');
      expect(citedBlock.citations[1].url).toBe('https://real-v2-citation-2.com/page');

      // Titles should also come from v2 citations
      expect(citedBlock.citations[0].title).toBe('Real V2 Title 1');
      expect(citedBlock.citations[1].title).toBe('Real V2 Title 2');
    });

    it('should call v2/completion endpoint when using orchestration path', async () => {
      deploymentDiscoveryMock.getPerplexityDeploymentId = () => Promise.resolve(null);

      mockAxiosPost.mockImplementationOnce(() => Promise.resolve({
        data: {
          final_result: {
            choices: [{ message: { content: JSON.stringify({ summary: 'test', results: [] }) } }]
          }
        }
      }));

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test endpoint' }],
          },
        },
        upstreamResponse: {
          id: 'msg_endpoint_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_endpoint_test',
              name: 'web_search',
              input: { query: 'test endpoint' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      await afterHandler(context);

      // Verify axios was called with the v2/completion URL
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/completion'),
        expect.anything(),
        expect.anything()
      );
    });

    it('should send v2 payload format when using orchestration path', async () => {
      deploymentDiscoveryMock.getPerplexityDeploymentId = () => Promise.resolve(null);

      mockAxiosPost.mockImplementationOnce(() => Promise.resolve({
        data: {
          final_result: {
            choices: [{ message: { content: JSON.stringify({ summary: 'test', results: [] }) } }]
          }
        }
      }));

      const context = {
        req: {
          body: {
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'test payload' }],
          },
        },
        upstreamResponse: {
          id: 'msg_payload_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_payload_test',
              name: 'web_search',
              input: { query: 'test payload' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        utils: { logger: mockLogger },
      };

      await afterHandler(context);

      // Verify v2 payload structure was sent
      const callArgs = mockAxiosPost.mock.calls[0] as any[];
      const payload = callArgs[1];
      expect(payload).toHaveProperty('config.modules.prompt_templating');
      expect(payload.config.modules.prompt_templating).toHaveProperty('prompt.template');
      expect(payload.config.modules.prompt_templating).toHaveProperty('model.name', 'sonar-pro');

      // Should NOT have v1 structure
      expect(payload).not.toHaveProperty('orchestration_config');
    });

    afterAll(() => {
      // Restore mock to default (direct Perplexity deployment available)
      deploymentDiscoveryMock.getPerplexityDeploymentId = () => Promise.resolve('mock-perplexity-deployment');
    });
  });
});
