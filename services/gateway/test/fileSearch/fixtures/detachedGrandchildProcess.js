// Test fixture only — simulates a hostile "extractor" that spawns a
// detached grandchild inheriting its stdout fd, then exits itself
// immediately. If runExtractor waited on the immediate child's 'close'
// event to settle, this would hang forever: fd 1's pipe stays open for as
// long as the grandchild (now in its own process group, and so immune to a
// group-kill aimed at this immediate child) keeps it open.
const { spawn } = require('child_process');
const path = require('path');

const grandchild = spawn(
  process.execPath,
  [path.join(__dirname, 'grandchildHolder.js')],
  { stdio: ['ignore', 'inherit', 'ignore'], detached: true }
);
grandchild.unref();

process.exit(0);
