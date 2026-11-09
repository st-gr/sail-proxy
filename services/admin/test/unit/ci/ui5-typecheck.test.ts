import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The UI5 type-check gate (ci/scripts/ui5-typecheck.js) is a plain node CI tool.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tool = require('../../../../../ci/scripts/ui5-typecheck.js');

type TscError = { file: string | null; line: number | null; code: string; message: string };
type Result = { app: string; status: number; errors: TscError[] };

const LOCATED = [
  "webapp/ext/SetApiKey.ts(8,24): error TS2307: Cannot find module 'sap/ui/core/ValueState' or its corresponding type declarations.",
  "webapp/ext/SetApiKey.ts(74,32): error TS2532: Object is possibly 'undefined'.",
  "webapp/controller/App.controller.ts(736,5): error TS2339: Property 'getTitle' does not exist on type 'string'."
].join('\n');

const MISSING_TYPES = [
  "error TS2688: Cannot find type definition file for '@sapui5/types'.",
  '  The file is in the program because:',
  "    Entry point of type library '@sapui5/types' specified in compilerOptions"
].join('\n');

function result(app: string, output: string, status = output ? 2 : 0): Result {
  return { app, status, errors: tool.parseTscOutput(output) };
}

describe('ui5-typecheck', () => {
  describe('parseTscOutput', () => {
    it('reads file, line and code of located errors', () => {
      expect(tool.parseTscOutput(LOCATED)).toEqual([
        { file: 'webapp/ext/SetApiKey.ts', line: 8, code: 'TS2307', message: "Cannot find module 'sap/ui/core/ValueState' or its corresponding type declarations." },
        { file: 'webapp/ext/SetApiKey.ts', line: 74, code: 'TS2532', message: "Object is possibly 'undefined'." },
        { file: 'webapp/controller/App.controller.ts', line: 736, code: 'TS2339', message: "Property 'getTitle' does not exist on type 'string'." }
      ]);
    });

    it('reads a global error and ignores its explanation lines', () => {
      expect(tool.parseTscOutput(MISSING_TYPES)).toEqual([
        { file: null, line: null, code: 'TS2688', message: "Cannot find type definition file for '@sapui5/types'." }
      ]);
    });

    it('finds nothing in clean output', () => {
      expect(tool.parseTscOutput('')).toEqual([]);
    });
  });

  it('summarises codes, most frequent first', () => {
    expect(tool.codeSummary(tool.parseTscOutput(`${LOCATED}\n${LOCATED.split('\n')[1]}`)))
      .toBe('TS2532×2, TS2307×1, TS2339×1');
  });

  describe('decide', () => {
    const gated = ['users-app'];

    it('passes with a clean gated app and errors in an ungated one', () => {
      expect(tool.decide([result('users-app', ''), result('shell', LOCATED)], gated))
        .toEqual({ exitCode: 0, failures: [] });
    });

    it('fails on any error in a gated app', () => {
      const verdict = tool.decide([result('users-app', LOCATED), result('shell', '')], gated);
      expect(verdict.exitCode).toBe(1);
      expect(verdict.failures).toEqual([{ app: 'users-app', reason: '3 error(s) in a gated app' }]);
    });

    it('fails on TS2688 in any app, gated or not', () => {
      const verdict = tool.decide([result('users-app', ''), result('shell', MISSING_TYPES)], gated);
      expect(verdict.exitCode).toBe(1);
      expect(verdict.failures[0].app).toBe('shell');
      expect(verdict.failures[0].reason).toMatch(/^TS2688/);
    });

    it('fails when tsc exits non-zero without an error it could parse', () => {
      const verdict = tool.decide([result('users-app', ''), { app: 'shell', status: 1, errors: [] }], gated);
      expect(verdict.failures).toEqual([{ app: 'shell', reason: 'tsc exited 1 without reporting an error' }]);
    });

    it('fails when a gated app does not exist', () => {
      const verdict = tool.decide([result('shell', '')], gated);
      expect(verdict.failures).toEqual([{ app: 'users-app', reason: 'gated but not found' }]);
    });

    it('names each failing app by its app field, whatever its reason says', () => {
      const verdict = tool.decide([{ app: 'users-app', status: 2, errors: [
        { file: null, line: null, code: 'TS2688', message: "Cannot find type definition file for 'a:b'." }
      ] }], gated);
      expect(verdict.failures.map((f: { app: string }) => f.app)).toEqual(['users-app']);
    });
  });

  it('discovers the apps that have a tsconfig.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui5-typecheck-'));
    try {
      for (const app of ['b-app', 'a-app', 'plain']) fs.mkdirSync(path.join(root, app));
      fs.writeFileSync(path.join(root, 'a-app', 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(root, 'b-app', 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(root, 'services.cds'), '');
      expect(tool.discoverApps(root)).toEqual(['a-app', 'b-app']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gates only apps that exist', () => {
    const apps: string[] = tool.discoverApps();
    for (const app of tool.loadGated()) expect(apps).toContain(app);
  });
});
