/**
 * awsBedrockService logs `authToken` (the bearer token used to call SAP AI
 * Core / AWS Bedrock) in full on 401 responses when DEBUG=true. Driving this
 * module directly requires a full axios/plugin/streaming harness (it pulls
 * in modelService, configService, the plugin executor, SSE writers, usage
 * tracking, etc.) — awkward enough that a source-level check is the
 * pragmatic option here, per the redaction test plan for awkward modules.
 *
 * This asserts the module imports the shared secretLabel helper and that
 * neither DEBUG log site still hands the raw token to the logger.
 *
 * @see ../src/services/awsBedrockService.ts
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('awsBedrockService never logs the raw auth token', () => {
  const source = readFileSync(join(__dirname, '../src/services/awsBedrockService.ts'), 'utf8');

  it('imports the shared secretLabel helper', () => {
    expect(source).toMatch(/import\s*\{\s*secretLabel\s*\}\s*from\s*'\.\.\/utils\/secretLabel'/);
  });

  it('no longer logs the raw token object at either DEBUG - Auth token used site', () => {
    expect(source).not.toContain('{ token: authToken }');
    const matches = source.match(/DEBUG - Auth token used:.*tokenLabel: secretLabel\(authToken\)/g) || [];
    expect(matches.length).toBe(2);
  });
});
