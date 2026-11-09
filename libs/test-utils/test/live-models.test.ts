import * as fs from 'fs';
import * as path from 'path';
import { liveModels } from '../src';

const ROLES = ['cheapChat', 'vision', 'reasoning', 'claude', 'gemini', 'nova', 'mistral', 'embedding', 'deployedTwin'];

describe('liveModels', () => {
  it('has exactly the documented roles', () => {
    expect(Object.keys(liveModels).sort()).toEqual([...ROLES].sort());
  });

  it('holds SAP model names: lower-case, no whitespace, optional --deployed suffix', () => {
    for (const name of Object.values(liveModels)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9.-]*(--deployed)?$/);
    }
  });

  it('keeps one role per line in the source so the checker can rewrite it line by line', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/live-models.ts'), 'utf8');
    const lines = source.split('\n').filter((line) => /^\s{2}[a-zA-Z]+: '[^']+',$/.test(line));
    expect(lines).toHaveLength(ROLES.length);
  });

  it('uses the deployed twin of a model in the table', () => {
    expect(liveModels.deployedTwin).toBe(`${liveModels.claude}--deployed`);
  });
});
