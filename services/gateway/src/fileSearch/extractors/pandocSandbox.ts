// pandoc reads an uploaded document only inside its sandbox. Without `--sandbox` a document can
// ask pandoc's readers to pull in another file of this machine (reStructuredText `include`,
// `csv-table :file:`, `raw :file:`, ...) and its text would land in the extracted output. The
// option exists from pandoc 2.15 on; an older (or unreadable) pandoc is refused, never run without
// it. The version is read once per process.

import { getDefaultLogger } from '@libs/logger';
import { runExtractor } from './runners';

const logger = getDefaultLogger();

export const PANDOC_SANDBOX_ARG = '--sandbox';
const MIN_MAJOR = 2;
const MIN_MINOR = 15;

/** Permanent (ingestWorker.isPermanentFailure). Its message reaches the uploader through the file's
 *  last_error, so it names neither the tool nor its version: those are in the one warning below. */
export class PandocTooOldError extends Error {
  constructor() {
    super('Files of this type cannot be converted on this installation. The administrator has been told.');
    this.name = 'PandocTooOldError';
  }
}

/** The `x.y` version of `pandoc --version` output, or null when it cannot be read. */
function versionOf(versionOutput: string): [number, number] | null {
  const m = /^pandoc(?:\.exe)?\s+(\d+)\.(\d+)/.exec(String(versionOutput).split('\n')[0].trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether `pandoc --version` output names a pandoc that has `--sandbox` (2.15 or later). */
export function pandocSupportsSandbox(versionOutput: string): boolean {
  const v = versionOf(versionOutput);
  return !!v && (v[0] > MIN_MAJOR || (v[0] === MIN_MAJOR && v[1] >= MIN_MINOR));
}

let check: Promise<void> | null = null;

/** Resolves when pandoc may run (it has --sandbox); rejects with PandocTooOldError otherwise. */
export function ensurePandocSandbox(): Promise<void> {
  if (!check) {
    check = runExtractor('pandoc', ['--version'], Buffer.alloc(0), { timeoutMs: 10_000 }).then(
      (out) => {
        if (pandocSupportsSandbox(out)) return;
        const v = versionOf(out);
        const found = v ? `${v[0]}.${v[1]}` : '(version not readable)';
        logger.warn('FileSearchExtractor', `pandoc ${found} is older than 2.15 and has no --sandbox: .docx, .odt, .epub and .rst uploads are refused until pandoc is updated`);
        throw new PandocTooOldError();
      },
      (error) => {
        // pandoc missing or not runnable: let the next upload try again, it fails as before
        check = null;
        throw error;
      },
    );
  }
  return check;
}

/** For tests: forget the version read. */
export function resetPandocSandboxCheck(): void {
  check = null;
}
