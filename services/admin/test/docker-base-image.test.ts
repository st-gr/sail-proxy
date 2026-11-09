/**
 * Docker base image test
 *
 * The gateway, admin and ollama images run on Node.js 24 LTS (node:20-alpine
 * reached end of life on 2026-04-30). Every Node stage must name the same base
 * image, and CI must run the host phases on the same major.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASE_IMAGE = 'node:24-alpine';

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
}

describe('Docker base image', () => {
  it('every Node stage of the gateway, admin and ollama images is node:24-alpine', () => {
    const wrong: string[] = [];
    for (const file of ['gateway', 'admin', 'ollama']) {
      const lines = read('docker', `${file}.Dockerfile`).split('\n');
      const froms = lines.filter((l) => /^FROM node:/.test(l));
      expect(froms.length).toBeGreaterThan(0);
      for (const l of froms) {
        if (!l.startsWith(`FROM ${BASE_IMAGE}`)) wrong.push(`${file}.Dockerfile: ${l}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the CI NODE_VERSION is '24'", () => {
    expect(read('.github', 'workflows', 'ci.yml')).toMatch(/^\s*NODE_VERSION: '24'\s*$/m);
  });
});
