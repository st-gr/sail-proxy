#!/usr/bin/env node

/**
 * Reject literal C0 control bytes (other than tab/LF/CR) in staged TEXT files.
 *
 * WHY THIS EXISTS. A fix wave whose entire subject was "NUL bytes must never be written
 * literally into source" committed three of them into its own comments explaining that
 * rule, and a fourth had been sitting in a test fixture since earlier on the branch. They
 * are inert at runtime -- a NUL inside a `//` comment is just a character, and inside a
 * string literal it is valid test data -- which is exactly why nothing caught them. The
 * damage is to the tools everyone reads the repository with:
 *
 *   - `git diff` declares the whole file binary: "Bin 0 -> 9729 bytes, 0 insertions(+)".
 *     9.7 KB of new test code arrived unreviewable.
 *   - `grep` silently stops matching. `grep -c RecallInputError repository.ts` exited 1
 *     while `grep -ac` found 10 -- a core module invisible to the default search everyone
 *     uses, with no error message to explain it.
 *
 * The original version of this check only looked for NUL (0x00). That missed a sibling
 * incident on a later branch: a test's ESC (0x1b) and BEL (0x07) bytes were written
 * literally instead of as \u001b/\u0007 escapes, which this check let
 * straight through -- NUL is only one byte value out of roughly thirty with the same
 * "invisible in a normal read, breaks tooling or renders as garbage" problem. The check
 * now rejects every C0 control byte (0x00-0x1F) except the three that are legitimate in
 * text: tab (0x09), LF (0x0A), and CR (0x0D). NUL keeps its own dedicated message below,
 * since a NUL additionally makes `git diff` treat the whole file as binary, which the
 * other C0 bytes do not. DEL (0x7F) and the C1 range (0x80-0x9F) are deliberately NOT
 * included: C1 control characters only ever appear as multi-byte UTF-8 sequences (never as
 * a raw byte in that range), and going past C0 starts rejecting legitimate UTF-8 content
 * instead of catching invisible bytes.
 *
 * Both failure modes are silent and both mislead a reviewer into thinking there is
 * nothing there. The fix in source is always the same: write the escaped form in prose
 * (\u0000, \u001b, ...), and `String.fromCharCode(N)` where a real
 * control byte is needed at runtime.
 *
 * Genuinely binary files (images, fonts, archives, compiled output) are skipped by
 * extension. The check is deliberately NOT "does this file contain a disallowed byte" for
 * everything staged -- that would fail on every PNG.
 *
 * Pure Node.js, no grep/sed, matching the rest of the pre-commit tooling's
 * cross-platform constraint.
 *
 * Usage: run from the pre-commit hook via pre-commit-checks.js, or directly:
 *          node cli-tools/check-nul-bytes.js [file ...]
 *        With no arguments it checks the staged files.
 */

const { execSync } = require('child_process');
const fs = require('fs');

/** Extensions whose contents are expected to be binary and are therefore not scanned. */
const BINARY_EXTENSIONS = new Set([
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff', '.icns',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives and compiled artefacts
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.wasm', '.node',
  // media
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  // misc binary payloads used as fixtures
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.bin', '.dat', '.p12', '.pfx',
]);

const NUL_BYTE = 0x00;
const LF_BYTE = 0x0a;

// C0 control bytes that are legitimate in text and therefore never flagged: tab, LF, CR.
// Every other byte in 0x00-0x1F is disallowed -- NUL is handled as its own special case
// below (see module doc comment for why), everything else in this set falls into the
// generic "other control byte" report.
const ALLOWED_CONTROL_BYTES = new Set([0x09, LF_BYTE, 0x0d]); // tab, LF, CR

/** Friendly abbreviations for the C0 control bytes most likely to actually turn up --
 *  copy-pasted terminal output, ANSI escapes -- falling back to a bare hex value for any
 *  other byte in range. */
const CONTROL_BYTE_NAMES = {
  0x00: 'NUL', 0x01: 'SOH', 0x02: 'STX', 0x03: 'ETX', 0x04: 'EOT', 0x05: 'ENQ',
  0x06: 'ACK', 0x07: 'BEL', 0x08: 'BS', 0x0b: 'VT', 0x0c: 'FF', 0x0e: 'SO',
  0x0f: 'SI', 0x10: 'DLE', 0x11: 'DC1', 0x12: 'DC2', 0x13: 'DC3', 0x14: 'DC4',
  0x15: 'NAK', 0x16: 'SYN', 0x17: 'ETB', 0x18: 'CAN', 0x19: 'EM', 0x1a: 'SUB',
  0x1b: 'ESC', 0x1c: 'FS', 0x1d: 'GS', 0x1e: 'RS', 0x1f: 'US',
};

function isDisallowedControlByte(byte) {
  return byte <= 0x1f && !ALLOWED_CONTROL_BYTES.has(byte);
}

function controlByteLabel(byte) {
  const hex = `0x${byte.toString(16).padStart(2, '0')}`;
  const name = CONTROL_BYTE_NAMES[byte];
  return name ? `${hex} (${name})` : hex;
}

function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return dot > slash ? file.slice(dot).toLowerCase() : '';
}

function isBinaryByExtension(file) {
  return BINARY_EXTENSIONS.has(extensionOf(file));
}

function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Scans each file's raw bytes directly (never a decoded string) so multi-byte UTF-8
 * content can never shift byte positions or line counts -- every C0 control byte is
 * always a single byte in UTF-8, never a continuation byte, so this is safe even for a
 * file that isn't valid UTF-8 elsewhere.
 *
 * @param {string[]} files
 * @returns {Array<{
 *   file: string,
 *   nul: {count: number, lines: number[]} | null,
 *   other: Array<{byte: number, line: number}>,
 * }>} one entry per offending file; `nul` is null when the file has no NUL bytes, `other`
 *     is empty when the file has no non-NUL disallowed control bytes.
 */
function findControlBytes(files) {
  const offenders = [];
  for (const file of files) {
    if (isBinaryByExtension(file)) continue;
    let contents;
    try {
      contents = fs.readFileSync(file);
    } catch {
      continue;                       // deleted or unreadable; not this check's business
    }

    let nulCount = 0;
    const nulLines = [];
    const other = [];
    let line = 1;
    let sawNulOnThisLine = false;

    for (let i = 0; i < contents.length; i++) {
      const byte = contents[i];
      if (byte === LF_BYTE) {
        line += 1;
        sawNulOnThisLine = false;
        continue;
      }
      if (byte === NUL_BYTE) {
        nulCount += 1;
        if (!sawNulOnThisLine) {
          nulLines.push(line);
          sawNulOnThisLine = true;
        }
        continue;
      }
      if (isDisallowedControlByte(byte)) {
        other.push({ byte, line });
      }
    }

    if (nulCount > 0 || other.length > 0) {
      offenders.push({
        file,
        nul: nulCount > 0 ? { count: nulCount, lines: nulLines } : null,
        other,
      });
    }
  }
  return offenders;
}

function main(argv = []) {
  const files = argv.length > 0 ? argv : getStagedFiles();
  if (files.length === 0) return;

  const offenders = findControlBytes(files);
  if (offenders.length === 0) return;

  console.error('');
  console.error('❌ Literal control bytes found in staged text files:');
  console.error('');
  for (const { file, nul, other } of offenders) {
    if (nul) {
      console.error(`   ${file}  (${nul.count} NUL byte${nul.count === 1 ? '' : 's'}, line${nul.lines.length === 1 ? '' : 's'} ${nul.lines.join(', ')})`);
    }
    for (const { byte, line } of other) {
      console.error(`   ${file}  (control byte ${controlByteLabel(byte)} at line ${line})`);
    }
  }
  console.error('');
  console.error('   A NUL byte is inert at runtime but breaks the tools used to read this repo:');
  console.error('   `git diff` renders the whole file as binary, and `grep` stops matching it');
  console.error('   entirely (compare `grep -c` with `grep -ac`). Both fail silently.');
  console.error('');
  console.error("   Other C0 control bytes (ESC, BEL, ...) don't break git/grep the same way, but");
  console.error('   are just as invisible in a normal diff or editor view -- the incident this');
  console.error('   check exists for involved exactly these bytes, not just NUL.');
  console.error('');
  console.error('   In prose or a comment: write the escaped form, e.g. \\u001b, not the raw byte.');
  console.error('   Where a real control byte is needed at runtime: String.fromCharCode(N).');
  console.error('');
  throw new Error('literal control bytes in staged text files');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

module.exports = { main, findControlBytes, isBinaryByExtension, isDisallowedControlByte };
