// Test fixture only — a stand-in for a decompression-bomb-style tool that
// keeps writing to stdout far past any reasonable extracted-text size, so
// runners.test.ts can prove the output cap actually stops it well before
// the process's own timeout would.
process.stdin.resume();
const chunk = 'x'.repeat(65536);
const interval = setInterval(() => {
  process.stdout.write(chunk);
}, 1);
process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
