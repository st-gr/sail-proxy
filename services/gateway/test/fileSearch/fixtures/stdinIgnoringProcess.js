// Test fixture only — never shipped, never invoked with untrusted input.
// Never reads stdin (the parent's write of a large input cannot complete and its
// stdin.end() never reaches EOF), ignores SIGTERM and stays alive: the shape of a
// tool waiting for an EOF that never comes. Only the runner's timeout and its
// SIGKILL escalation can end it.
process.on('SIGTERM', () => {
  /* deliberately ignored */
});
setInterval(() => {}, 1000);
