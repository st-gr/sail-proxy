// Tests for cli-tools/check-nul-bytes.js, the pre-commit guard that rejects literal
// control bytes in staged text files (see that file's module doc comment for the two
// incidents — NUL bytes, then separately ESC/BEL bytes — that motivated it).
//
// Lives here rather than under cli-tools/ because this repo's only Jest runner is
// services/gateway's; test/docker-manifest-sync.test.ts already establishes the pattern
// of a gateway test covering a file outside services/gateway (there, package.docker.json;
// here, a repo-root cli-tools script).
//
// Every fixture below is built from raw byte arrays (Buffer.from([0x1b, ...])), never
// from a string containing a JS escape sequence in this file's own source — the exact
// trap this suite exists to guard against elsewhere. Fixtures are written to a scratch
// temp directory per test (never under the repo tree), so they can never themselves be
// staged and trip the real pre-commit hook.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const checkNulBytes = require('../../../cli-tools/check-nul-bytes.js');
const { main, findControlBytes, isBinaryByExtension, isDisallowedControlByte } = checkNulBytes;

let scratchDir: string;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-nul-bytes-test-'));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function writeFixture(name: string, bytes: number[]): string {
  const file = path.join(scratchDir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

const ESC = 0x1b;
const BEL = 0x07;
const NUL = 0x00;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

function bytesOf(text: string): number[] {
  return Array.from(Buffer.from(text, 'utf8'));
}

describe('check-nul-bytes.js — widened C0 control-byte guard', () => {
  it('rejects a file with a literal ESC byte, naming the byte and the line', () => {
    const file = writeFixture('esc.txt', [
      ...bytesOf('before'), ESC, ...bytesOf('after\n'),
      ...bytesOf('second line\n'),
    ]);

    expect(() => main([file])).toThrow(/literal control bytes/);

    const offenders = findControlBytes([file]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].other).toEqual([{ byte: ESC, line: 1 }]);
  });

  it('rejects a literal BEL byte the same way', () => {
    const file = writeFixture('bel.txt', [...bytesOf('ring'), BEL, ...bytesOf('\n')]);

    expect(() => main([file])).toThrow(/literal control bytes/);
    const offenders = findControlBytes([file]);
    expect(offenders[0].other).toEqual([{ byte: BEL, line: 1 }]);
  });

  it('accepts a file containing only tab, LF, and CR — none of them flagged', () => {
    const file = writeFixture('tabcrlf.txt', [
      ...bytesOf('a'), TAB, ...bytesOf('b'), CR, LF,
      ...bytesOf('c'), LF,
    ]);

    expect(() => main([file])).not.toThrow();
    expect(findControlBytes([file])).toHaveLength(0);
  });

  it('skips a .png even when it carries an ESC byte — binary files are not scanned', () => {
    const file = writeFixture('picture.png', [ESC, NUL, ESC, ...bytesOf('not really a png')]);

    expect(isBinaryByExtension(file)).toBe(true);
    expect(() => main([file])).not.toThrow();
    expect(findControlBytes([file])).toHaveLength(0);
  });

  it('still reports NUL with its own distinct message, separate from other control bytes', () => {
    const file = writeFixture('mixed.txt', [
      ...bytesOf('a'), NUL, ...bytesOf('b\n'),
      ...bytesOf('c'), ESC, ...bytesOf('d\n'),
    ]);

    const offenders = findControlBytes([file]);
    expect(offenders).toHaveLength(1);
    // NUL gets its own {count, lines} shape...
    expect(offenders[0].nul).toEqual({ count: 1, lines: [1] });
    // ...distinct from the generic {byte, line} shape used for every other
    // disallowed control byte.
    expect(offenders[0].other).toEqual([{ byte: ESC, line: 2 }]);

    // The two also read as distinct messages, not a single merged line.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => main([file])).toThrow();
      const rendered = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(rendered).toMatch(/1 NUL byte/);
      expect(rendered).toMatch(/control byte 0x1b/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('classifies every C0 byte correctly: disallowed except tab/LF/CR, and never DEL or C1', () => {
    for (let b = 0; b <= 0x1f; b++) {
      const allowed = b === TAB || b === LF || b === CR;
      expect(isDisallowedControlByte(b)).toBe(!allowed);
    }
    expect(isDisallowedControlByte(0x7f)).toBe(false); // DEL — not C0, stays unflagged
    expect(isDisallowedControlByte(0x80)).toBe(false); // start of the C1 range — unflagged
  });
});
