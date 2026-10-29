/**
 * SAP AI Core model names the live-call tests use, by role.
 *
 * This is the ONE file cli-tools/check-test-models.js may rewrite, so keep exactly one
 * `role: 'name',` per line. Mocked tests keep their own literals: some pin measured numbers
 * to a specific model, and a rename there would falsify the measurement.
 */
export const liveModels = {
  cheapChat: 'gemini-3.5-flash-lite',
  vision: 'gemini-3.8-flash',
  reasoning: 'gpt-5-nano',
  claude: 'anthropic--claude-4.5-haiku',
  gemini: 'gemini-3.5-flash',
  nova: 'amazon--nova-lite',
  mistral: 'mistralai--mistral-medium',
  embedding: 'text-embedding-3-small',
  deployedTwin: 'anthropic--claude-4.5-haiku--deployed',
} as const;

export type LiveModelRole = keyof typeof liveModels;
