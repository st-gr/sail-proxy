import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from '@jest/globals';
import { loadOpenApi } from '@libs/test-utils';

const ROOT = path.resolve(__dirname, '../../..');
const OPENAPI_DIR = path.join(ROOT, 'openapi');
const rootVersion: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

describe('OpenAPI documents follow the release version', () => {
  it.each(['gateway.yaml', 'admin-rest.yaml', 'ollama.yaml', 'admin-odata.json'])('%s info.version equals the root package.json', async (file) => {
    expect((await loadOpenApi(path.join(OPENAPI_DIR, file))).info.version).toBe(rootVersion);
  });
});
