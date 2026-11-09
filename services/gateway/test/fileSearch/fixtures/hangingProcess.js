// Test fixture only — never shipped, never invoked with untrusted input.
// Ignores SIGTERM so runners.test.ts can drive runExtractor's timeout logic
// into its SIGKILL escalation path and prove it actually terminates the
// process rather than leaving a zombie behind.
process.on('SIGTERM', () => {
  /* deliberately ignored */
});
process.stdin.resume(); // drain stdin so the parent's write/end doesn't block
setInterval(() => {}, 1000); // stay alive indefinitely until SIGKILL
