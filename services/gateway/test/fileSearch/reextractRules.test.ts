// Which completed files a re-extract reads again (registry.ts readBetterNow) and which failed files it
// queues again (isSupportedFilename): pure rules, no database.
import { EXTRACTION_VERSION, isSupportedFilename, readAgain, readBetterNow } from '../../src/fileSearch/extractors/registry';
import { OcrMemo, ocrPendingOf } from '../../src/fileSearch/extractors/pdfOcr';
import { DOC_SWITCH_ENV, resetLegacyDocPathCache } from '../../src/fileSearch/extractors/legacyDoc';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('re-extract rules', () => {
  it('a PDF read before the version existed (NULL) or with version 0 is read better now', () => {
    for (const name of ['a.pdf', 'Report.PDF', ' scan.pdf ', 'archive.tar.pdf']) {
      expect([name, readBetterNow(name, null)]).toEqual([name, true]);
      expect([name, readBetterNow(name, 0)]).toEqual([name, true]);
    }
  });

  it('a PDF read with the current version is not; nor is any other format, whatever its version', () => {
    expect(readBetterNow('a.pdf', EXTRACTION_VERSION)).toBe(false);
    expect(readBetterNow('a.pdf', EXTRACTION_VERSION + 1)).toBe(false);
    for (const name of ['notes.md', 'deck.pptx', 'sheet.xlsx', 'doc.docx', 'pdf', 'a.pdf.txt', '']) {
      expect([name, readBetterNow(name, null)]).toEqual([name, false]);
    }
  });

  it('a version that is not a whole number counts as none', () => {
    expect(readBetterNow('a.pdf', 1.5 as any)).toBe(true);
    expect(readBetterNow('a.pdf', '1' as any)).toBe(true);
  });

  it('isSupportedFilename: PowerPoint and Excel are read now; a name without an extension or of another type is not', () => {
    for (const name of ['deck.pptx', 'SHEET.XLSX', 'a.pdf', 'notes.md']) expect([name, isSupportedFilename(name)]).toEqual([name, true]);
    for (const name of ['pptx', 'old.wpd', 'image.png', 'notes.', '']) expect([name, isSupportedFilename(name)]).toEqual([name, false]);
  });

  it('isSupportedFilename: a legacy .doc only where antiword is on PATH and the switch is not off', () => {
    const savedSwitch = process.env[DOC_SWITCH_ENV];
    const savedPath = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reextract-antiword-'));
    try {
      delete process.env[DOC_SWITCH_ENV];
      process.env.PATH = bin; // no antiword here, whatever the host has installed
      resetLegacyDocPathCache();
      expect(isSupportedFilename('old.doc')).toBe(false);

      fs.writeFileSync(path.join(bin, 'antiword'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      resetLegacyDocPathCache();
      expect(isSupportedFilename('old.doc')).toBe(true);

      process.env[DOC_SWITCH_ENV] = 'off';
      expect(isSupportedFilename('old.doc')).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedSwitch === undefined) delete process.env[DOC_SWITCH_ENV]; else process.env[DOC_SWITCH_ENV] = savedSwitch;
      resetLegacyDocPathCache();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('readAgain: also a file whose read left OCR pending, but only where OCR runs now', () => {
    expect(readAgain('scan.pdf', EXTRACTION_VERSION, true, true)).toBe(true);
    expect(readAgain('scan.pdf', EXTRACTION_VERSION, true, false)).toBe(false);
    expect(readAgain('scan.pdf', EXTRACTION_VERSION, false, true)).toBe(false);
    expect(readAgain('scan.pdf', EXTRACTION_VERSION, null, true)).toBe(false);
    expect(readAgain('scan.pdf', null, false, false)).toBe(true);
  });

  it('ocrPendingOf: pending only when pages without text met OCR that could not run; a capped or failed scan is not', () => {
    const off = new OcrMemo();
    off.noteUnavailable('switched off');
    for (let page = 1; page <= 3; page += 1) off.skipped('sha', page);
    expect(ocrPendingOf(off.totals())).toBe(true);

    // a 500-page scan: 200 pages read, the rest past the cap, one failed — OCR ran: never pending
    const capped = new OcrMemo();
    for (let page = 1; page <= 200; page += 1) capped.done('sha', page, 'text');
    for (let page = 201; page <= 500; page += 1) capped.skipped('sha', page, page === 201);
    expect(capped.totals().candidates).toBe(500);
    expect(ocrPendingOf(capped.totals())).toBe(false);

    const textOnly = new OcrMemo();
    textOnly.noteUnavailable('switched off'); // OCR off, but no page without text
    expect(ocrPendingOf(textOnly.totals())).toBe(false);
    expect(ocrPendingOf(undefined)).toBe(false);
  });
});
