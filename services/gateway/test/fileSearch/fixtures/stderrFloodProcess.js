// Writes a long stderr message containing control characters (as a
// stand-in for a pandoc/pdftotext error that quotes a fragment of the
// document it failed to parse), then exits non-zero -- used by
// runners-stderr-truncation.test.ts to prove runExtractor truncates and
// sanitizes stderr before it ever reaches a thrown Error's message.
process.stderr.write('DOCUMENT_FRAGMENT_START\x00\x01\nEVIL_NEWLINE_INJECTED\n' + 'x'.repeat(5000) + 'DOCUMENT_FRAGMENT_END');
process.exit(7);
