import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { SecurityEventType } from '../src/types/security';

// Absolute, __dirname-anchored roots so the walk is independent of jest's cwd.
const GATEWAY_SRC = path.join(__dirname, '..', 'src');
const ADMIN_SRC = path.join(__dirname, '..', '..', 'admin', 'src');
const EMITTER_PATH = path.join(GATEWAY_SRC, 'services', 'securityEventEmitter.ts');
const TYPES_PATH = path.join(GATEWAY_SRC, 'types', 'security.ts');

const SKIP_DIRS = new Set(['node_modules', 'dist']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(p, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip `/* ... */` block comments and `//` line comments before any call-detection regex
// runs over a corpus. Without this, `// TODO: call emitFoo(x) here` reads as a real call —
// exactly the hole this file exists to close (see git history / task-4 report for the repro).
// Best-effort only (no string-literal awareness beyond avoiding `://`), which is adequate for
// our own source tree.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Strip single-, double-, and backtick-quoted string literals. Without this, a helper name
// mentioned only inside a string (e.g. a doc string that happens to spell out a call shape,
// `'see securityEventEmitter.emitFoo( for details'`) reads as a real call even though nothing
// invokes it. Best-effort: honors backslash escapes within a literal, does not attempt to
// understand `${...}` interpolation inside backticks (adequate for our own source tree).
//
// Must be a single alternation-based pass, not three sequential per-quote-type passes: an
// unescaped apostrophe inside a double-quoted string (e.g. "don't") would otherwise be misread
// by a standalone single-quote pass as opening an unterminated literal, silently swallowing
// everything up to the next stray `'` anywhere later in the corpus — including real call sites.
// One combined regex resolves the correct quote type at each position because the engine always
// matches the earliest-starting alternative first.
//
// Single- and double-quoted matches are bounded to one line (`[^'\n]` / `[^"\n]`), because real
// JS/TS string literals never span a raw newline. This also contains the blast radius of the one
// case regex can't tell from a real string: an apostrophe inside a *regex literal*, e.g.
// `/driver'?s?\s*licen[sc]e/` in regexDetectors.ts. Without the newline bound, that stray `'`
// is read as opening an unterminated string and swallows everything up to the next quote
// character anywhere later in the corpus — including real call sites in other files entirely
// (confirmed against this codebase's actual pseudonymization detectors). Bounding to one line
// caps the damage at the rest of that single line. Backtick literals are deliberately left
// unbounded since template literals legitimately span multiple lines and backtick is never a
// regex-literal delimiter.
function stripStrings(src: string): string {
  return src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '');
}

// Clean each file BEFORE joining them, for any corpus the call detector runs over.
//
// stripStrings' backtick branch is deliberately unbounded (template literals legitimately span
// lines), so a file left holding an odd backtick swallows everything up to the next backtick —
// in a *later file entirely* if the files are joined first. That is not hypothetical: `maskUrl`
// in src/config/unifiedAuthConfig.ts contains `${parsed.protocol}//***:***@...`, whose `//`
// stripComments removes as a line comment (its guard only spares `://`), taking the literal's
// closing backtick with it. Every backtick downstream then pairs one position off, so the *gaps
// between* template literals get eaten instead of the literals — silently hiding real call sites
// in unrelated files. Cleaning per file caps that at the file that actually has the imbalance,
// which is the same blast-radius reasoning the single/double-quote branches already apply per
// line.
//
// The trailing `replace` then drops whatever quote characters the per-file clean left behind: a
// quote surviving a clean is by definition an unterminated literal (the maskUrl case), and
// carrying it into the join would let findOrphanedHelpers' own second cleaning pass re-pair it
// with a stray from a different file — re-creating the very cross-file swallow this containment
// exists to stop, one pass later. Measured against this codebase, the four leftover backticks
// cost 24,917 characters on that second pass before this line was added.
function cleanedCorpus(sources: string[]): string {
  return sources.map((src) => stripStrings(stripComments(src)).replace(/[`'"]/g, '')).join('\n');
}

// The strict detector, factored out so it can be driven directly against a hand-built corpus
// (see the regression test below) rather than only through the filesystem walk. A helper counts
// as called only if the cleaned (comment-stripped) corpus contains a call-shaped, receiver-
// prefixed reference — `this.emitFoo(` or `securityEventEmitter.emitFoo(` — not a bare substring
// match, which a log message, identifier, or comment could satisfy without a real call existing.
// Known limitation: the receiver prefix must be the literal `this` or `securityEventEmitter`.
// A call through an alias — `const emitter = securityEventEmitter; emitter.emitFoo(x);` — would
// not match and the helper would be reported as an orphan even though it is genuinely called.
// That pattern does not occur in the codebase today, and the failure direction is safe (a loud
// false positive on correct code, not a silent pass on a real gap), so it's left as-is rather
// than generalized. If you introduce such an alias, expect this test to flag it and update the
// pattern below rather than treating the failure as a real orphan.
function findOrphanedHelpers(corpus: string, helperNames: string[]): string[] {
  const cleaned = stripStrings(stripComments(corpus));
  return helperNames.filter((h) => {
    const pattern = new RegExp(`\\b(?:this|securityEventEmitter)\\.${escapeRegExp(h)}\\s*\\(`);
    return !pattern.test(cleaned);
  });
}

const emitterSrc = fs.readFileSync(EMITTER_PATH, 'utf8');

// Emitter helpers that are declared ahead of the code that calls them, each with the task that
// wires it up. This is NOT a general escape hatch: an entry is only legitimate while the caller
// is genuinely still to come, and the "no stale entry" test below deletes the exception for you
// by failing the moment the call site lands. Anything not listed here is still a hard orphan.
//
// The set is empty: emitDeploymentCreated's caller landed with Task 11's
// controllers/deploymentController.ts, so its entry was deleted as designed.
const PENDING_CALLERS = new Set<string>([]);

// Gateway source that could plausibly *call* an emitter helper: everything except the
// emitter itself (which would trivially "call" its own helpers via definition) and the
// type declarations file (which restates event-type strings without emitting anything).
const gatewayCallerFiles = sourceFiles(GATEWAY_SRC).filter(
  (f) => f !== EMITTER_PATH && f !== TYPES_PATH,
);
const gatewayCallerSources = gatewayCallerFiles.map((f) => fs.readFileSync(f, 'utf8'));
// Raw join — used only by the cross-service `eventType: '...'` search below, which needs the
// string literals intact.
const gatewayCallerCorpus = gatewayCallerSources.join('\n');
// Cleaned per file, THEN joined, for the orphan detector — see cleanedCorpus() above for why
// the order matters. The raw join above stays raw because the cross-service search needs the
// string literals intact.
const gatewayCallerCleanedCorpus = cleanedCorpus(gatewayCallerSources);

// CREDENTIAL_ROTATION is emitted by the admin service (SecurityEventService.createAwsSecurityEvent
// in admin-service.ts), not by the gateway's securityEventEmitter. "Is this type emitted anywhere"
// has to search both services, or that legitimate cross-service emission reads as dead.
const adminFiles = sourceFiles(ADMIN_SRC);
const adminCorpus = adminFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const crossServiceCorpus = gatewayCallerCorpus + '\n' + adminCorpus;

describe('every declared security event type is actually emitted', () => {
  it.each(Object.entries(SecurityEventType))(
    'type %s (%s) has a live emission site in the gateway or the admin service',
    (key, value) => {
      // Gateway-side emission: the emitter builds an event object tagged with this enum member.
      const emittedFromGateway = emitterSrc.includes(`SecurityEventType.${key}`);
      // Admin-side emission: a real object-literal assignment of the raw string value to
      // `eventType`, e.g. `eventType: 'credential_rotation'` — not a type-union declaration
      // or an unrelated string match.
      const emittedFromAdmin = new RegExp(`eventType:\\s*['"\`]${value}['"\`]`).test(
        crossServiceCorpus,
      );
      expect(emittedFromGateway || emittedFromAdmin).toBe(true);
    },
  );

  // The strict check: this is what would have caught the orphaned emitter helpers this plan
  // deleted. A helper with no caller anywhere outside the emitter is dead code masquerading
  // as a live event source.
  it('every gateway emitter helper has at least one caller outside the emitter', () => {
    const helperNames = [...emitterSrc.matchAll(/public\s+(?:async\s+)?(emit\w+)\s*\(/g)].map(
      (m) => m[1],
    );
    const orphans = findOrphanedHelpers(gatewayCallerCleanedCorpus, helperNames);
    expect(orphans.filter((h) => !PENDING_CALLERS.has(h))).toEqual([]);
  });

  // The pending-caller allowance is only honest if it expires by itself. Once the named task
  // lands its call site the helper stops being an orphan, and this test fails until the entry is
  // deleted — so the exception cannot quietly outlive the reason for it.
  it('has no stale entry in PENDING_CALLERS', () => {
    const helperNames = [...emitterSrc.matchAll(/public\s+(?:async\s+)?(emit\w+)\s*\(/g)].map(
      (m) => m[1],
    );
    const orphans = new Set(findOrphanedHelpers(gatewayCallerCleanedCorpus, helperNames));
    const stale = [...PENDING_CALLERS].filter((h) => !orphans.has(h));
    expect(stale).toEqual([]);
  });

  // Regression guard for cleanedCorpus()'s per-file cleaning, reproducing the exact failure this
  // plan hit. File A is maskUrl in src/config/unifiedAuthConfig.ts in miniature: an unguarded
  // `//` inside a template literal, which stripComments deletes along with the literal's closing
  // backtick, leaving that file one backtick short. File B is deploymentController.ts in
  // miniature: a real call site sandwiched between two log lines that each use a template
  // literal.
  //
  // Joined before cleaning, file A's stray backtick pairs with file B's first *opening* backtick;
  // that literal's *closing* backtick is then read as an opening one and swallows everything up
  // to the next backtick — which is file B's second log line, with the call in between. Both of
  // file B's literals are load-bearing: a stray with no later backtick to pair with, or with only
  // one, leaves the call untouched, so a shorter fixture passes even with the containment
  // reverted and pins nothing.
  it('per-file cleaning stops an unbalanced backtick from swallowing a later file', () => {
    const fileA = 'const u = `${p}//***`;';
    const fileB = [
      "logger.error('Ctl', `boom: ${e}`);",
      'await securityEventEmitter.emitDeploymentCreated({});',
      "logger.warn('Ctl', `done: ${id}`);",
    ].join('\n');

    // Cleaned per file, file B's call survives the join and reads as a real caller.
    expect(findOrphanedHelpers(cleanedCorpus([fileA, fileB]), ['emitDeploymentCreated'])).toEqual(
      [],
    );

    // Joined raw first — what the detector used to do — file A's imbalance eats file B's call and
    // the helper is falsely reported as an orphan. This is the assertion that pins the fix.
    expect(findOrphanedHelpers([fileA, fileB].join('\n'), ['emitDeploymentCreated'])).toEqual([
      'emitDeploymentCreated',
    ]);

    // ...and the detector is not merely permissive: drop file B and it is a genuine orphan.
    expect(findOrphanedHelpers(cleanedCorpus([fileA]), ['emitDeploymentCreated'])).toEqual([
      'emitDeploymentCreated',
    ]);
  });

  // Second half of the containment, pinned separately: cleanedCorpus() also drops the quote
  // characters a per-file clean leaves behind. findOrphanedHelpers runs its own cleaning pass over
  // whatever corpus it is handed, so two files that each end up one backtick short would re-pair
  // with each other on that second pass and swallow everything between them — the same cross-file
  // bug, one pass later. Against the real gateway tree the four surviving backticks cost 24,917
  // characters on the second pass; here the swallowed span is the call site itself.
  it('drops leftover unbalanced quotes so the detector cannot re-pair them across files', () => {
    const strayA = 'const u = `${p}//***`;';
    const caller = 'await securityEventEmitter.emitDeploymentCreated({});';
    const strayC = 'const v = `${q}//###`;';

    expect(
      findOrphanedHelpers(cleanedCorpus([strayA, caller, strayC]), ['emitDeploymentCreated']),
    ).toEqual([]);

    // Without the drop — per-file cleaning alone — strayA and strayC pair up on the detector's own
    // cleaning pass and eat the caller between them.
    const withoutDrop = [strayA, caller, strayC]
      .map((src) => stripStrings(stripComments(src)))
      .join('\n');
    expect(findOrphanedHelpers(withoutDrop, ['emitDeploymentCreated'])).toEqual([
      'emitDeploymentCreated',
    ]);
  });

  // Regression guard: a helper mentioned only in a comment (e.g. a "TODO: call emitFoo() here")
  // must still be reported as an orphan. Drives the detector directly against a small in-memory
  // corpus rather than the real filesystem walk, so the property is explicit and fast.
  it('does not count a commented-out reference as a real caller', () => {
    const commentOnlyCorpus = [
      "// TODO: consider also calling securityEventEmitter.emitOrphanProbe(entry) here.",
      '/* emitOrphanProbe(entry) is not actually wired up yet */',
      "const url = 'https://example.com/emitOrphanProbe(entry)'; // not a call either",
    ].join('\n');

    expect(findOrphanedHelpers(commentOnlyCorpus, ['emitOrphanProbe'])).toEqual([
      'emitOrphanProbe',
    ]);

    const realCallCorpus = "await securityEventEmitter.emitOrphanProbe(entry);";
    expect(findOrphanedHelpers(realCallCorpus, ['emitOrphanProbe'])).toEqual([]);
  });

  // Regression guard: a helper referenced only inside a string literal (e.g. a doc string that
  // spells out the call shape for a human reader) is not a real caller. stripComments alone does
  // not catch this — the string content still contains `securityEventEmitter.emitFoo(`.
  it('does not count a string-literal-only reference as a real caller', () => {
    const stringOnlyCorpus =
      "const AUDIT_DOC = 'see securityEventEmitter.emitProbeOrphanB( for details';";
    expect(findOrphanedHelpers(stringOnlyCorpus, ['emitProbeOrphanB'])).toEqual([
      'emitProbeOrphanB',
    ]);

    const realCallCorpus = 'await securityEventEmitter.emitProbeOrphanB(entry);';
    expect(findOrphanedHelpers(realCallCorpus, ['emitProbeOrphanB'])).toEqual([]);
  });

  // Regression guard: the harvester regex must catch helpers that are non-async and/or have an
  // underscore in their name — both slipped past the old `/public async (emit[A-Za-z]+)\(/`.
  it('the harvester regex matches non-async and underscored helper names', () => {
    const emitterCorpus = [
      '  public emitProbeOrphanC(entry: unknown): void {}',
      '  public async emitProbe_OrphanD(entry: unknown): Promise<void> {}',
    ].join('\n');
    const helperNames = [...emitterCorpus.matchAll(/public\s+(?:async\s+)?(emit\w+)\s*\(/g)].map(
      (m) => m[1],
    );
    expect(helperNames).toEqual(['emitProbeOrphanC', 'emitProbe_OrphanD']);
  });
});
