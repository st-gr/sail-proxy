// A synchronous child fed on stdin (execFileSync/spawnSync/execSync with `input`) hung a database
// run for 1h50m: on macOS, poppler's `pdftotext - -` started that way intermittently waits for its
// input forever (about one call in 35-140 here; `cat` and the async runner never do), and the
// synchronous call blocks the event loop, so neither jest's test timeout nor any timer can fire.
// The gateway feeds every tool through the bounded async runner (extractors/runners.ts); this
// keeps the file_search sources and their tests that way.
import * as fs from 'fs';
import * as path from 'path';

const ROOTS = [path.join(__dirname, '..', '..', 'src'), __dirname];
const SYNC_WITH_INPUT = /\b(?:execFileSync|spawnSync|execSync)\s*\([^;]*?\binput\s*:/s;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(ts|js)$/.test(e.name) ? [p] : [];
  });
}

describe('no synchronous child process fed on stdin', () => {
  it('none in the gateway sources or the file_search tests', () => {
    const offenders = ROOTS.flatMap(files)
      .filter((f) => f !== __filename && SYNC_WITH_INPUT.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '..', '..'), f));
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the shape that hung', () => {
    expect(SYNC_WITH_INPUT.test("const text = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString();")).toBe(true);
    expect(SYNC_WITH_INPUT.test("execFileSync('tesseract', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })")).toBe(false);
  });
});
