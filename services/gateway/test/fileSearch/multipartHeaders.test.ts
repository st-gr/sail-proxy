/**
 * parsePartHeaders: RFC 7578 / RFC 5987 conformance for the hand-rolled
 * multipart part-header parser on the file-upload path.
 *
 * Covers the two forms the original parser dropped silently — an unquoted
 * `name` token (which `curl -F` sends) and `filename*` (which every browser
 * sends for a non-Latin-1 name) — plus the fail-closed behaviour of the
 * RFC 5987 decoder, which must never emit a NUL and must never throw on
 * malformed percent-encoding.
 *
 * filesController's module-level dependencies are mocked away: this suite
 * exercises a pure string function and must not require a database, a blob
 * backend, or config.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
  }),
}));
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => false,
  getPool: () => null,
}));
jest.mock('../../src/fileSearch/blob/blobStore', () => ({
  sha256Of: jest.fn(),
  UnsupportedBlobBackendError: class extends Error {},
  retainBlob: jest.fn(),
  releaseBlob: jest.fn(),
  getBackend: jest.fn(),
}));
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({}),
}));

import { parsePartHeaders } from '../../src/controllers/filesController';

const NUL = String.fromCharCode(0);

describe('parsePartHeaders — RFC 7578 `name` forms', () => {
  it('accepts an unquoted name token', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name=file\r\ncontent-type: text/plain',
    );
    expect(part?.name).toBe('file');
    expect(part?.contentType).toBe('text/plain');
  });

  it('accepts an unquoted name token that is the last parameter of the header', () => {
    const part = parsePartHeaders('content-disposition: form-data; name=purpose');
    expect(part?.name).toBe('purpose');
  });

  it('still accepts the quoted name form', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="a.txt"',
    );
    expect(part?.name).toBe('file');
    expect(part?.filename).toBe('a.txt');
  });

  it('prefers the quoted name when a quoted value contains a semicolon', () => {
    // The unquoted alternative must never win over the quoted one, or a
    // quoted value would be truncated at its first delimiter-looking char.
    const part = parsePartHeaders('content-disposition: form-data; name="fi;le"');
    expect(part?.name).toBe('fi;le');
  });

  it('returns null when the part carries no name at all', () => {
    const part = parsePartHeaders('content-disposition: form-data; filename="a.txt"');
    expect(part).toBeNull();
  });
});

describe('parsePartHeaders — RFC 5987 `filename*`', () => {
  it('decodes RFC 5987 filename* and prefers it over a Latin-1 filename', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="Rechnung.pdf"; ' +
        "filename*=UTF-8''Rechnung%20f%C3%BCr%20M%C3%BCller.pdf",
    );
    expect(part?.filename).toBe('Rechnung für Müller.pdf');
  });

  it('decodes a filename* sent without any quoted filename alongside it', () => {
    const part = parsePartHeaders(
      "content-disposition: form-data; name=\"file\"; filename*=UTF-8''na%C3%AFve.txt",
    );
    expect(part?.filename).toBe('naïve.txt');
  });

  it('accepts a filename* carrying a language tag', () => {
    const part = parsePartHeaders(
      "content-disposition: form-data; name=\"file\"; filename*=UTF-8'de'M%C3%BCller.pdf",
    );
    expect(part?.filename).toBe('Müller.pdf');
  });

  it('falls back to the quoted filename when filename* is absent', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="plain.txt"',
    );
    expect(part?.filename).toBe('plain.txt');
  });
});

describe('parsePartHeaders — RFC 5987 decoder fails closed', () => {
  it('ignores a filename* with an unsupported charset rather than throwing', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="fallback.txt"; ' +
        "filename*=ISO-8859-1''caf%E9.txt",
    );
    expect(part?.filename).toBe('fallback.txt');
  });

  it('ignores a filename* with no charset delimiters rather than throwing', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="fallback.txt"; ' +
        'filename*=nodelimiters.txt',
    );
    expect(part?.filename).toBe('fallback.txt');
  });

  it('ignores a filename* with malformed percent-encoding rather than throwing', () => {
    // decodeURIComponent('%ZZ') throws URIError; an unhandled throw here would
    // turn a malformed caller header into a 500.
    let part: ReturnType<typeof parsePartHeaders> = null;
    expect(() => {
      part = parsePartHeaders(
        'content-disposition: form-data; name="file"; filename="fallback.txt"; ' +
          "filename*=UTF-8''bad%ZZname.txt",
      );
    }).not.toThrow();
    expect(part!.filename).toBe('fallback.txt');
  });

  it('ignores a filename* with a truncated percent escape rather than throwing', () => {
    let part: ReturnType<typeof parsePartHeaders> = null;
    expect(() => {
      part = parsePartHeaders(
        'content-disposition: form-data; name="file"; filename="fallback.txt"; ' +
          "filename*=UTF-8''trailing%",
      );
    }).not.toThrow();
    expect(part!.filename).toBe('fallback.txt');
  });

  it('ignores a filename* whose percent-encoding is not valid UTF-8 rather than throwing', () => {
    let part: ReturnType<typeof parsePartHeaders> = null;
    expect(() => {
      part = parsePartHeaders(
        'content-disposition: form-data; name="file"; filename="fallback.txt"; ' +
          "filename*=UTF-8''caf%E9.txt",
      );
    }).not.toThrow();
    expect(part!.filename).toBe('fallback.txt');
  });

  it('does not let a percent-decoded filename smuggle a NUL', () => {
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; ' + "filename*=UTF-8''bad%00name.txt",
    );
    expect(part?.filename ?? '').not.toContain(NUL);
    expect(part?.filename).toBeUndefined();
  });

  it('leaves the quoted filename standing when filename* decodes to a NUL-bearing value', () => {
    // A NUL reaching Postgres as raw text throws 22021. nulByteGuard cannot
    // catch this one: the byte arrives percent-encoded and is only
    // materialised by the decoder.
    const part = parsePartHeaders(
      'content-disposition: form-data; name="file"; filename="safe.txt"; ' +
        "filename*=UTF-8''bad%00name.txt",
    );
    expect(part?.filename).toBe('safe.txt');
    expect(part?.filename).not.toContain(NUL);
  });
});
