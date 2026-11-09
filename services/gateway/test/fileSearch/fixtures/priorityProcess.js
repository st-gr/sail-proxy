// Test fixture only — prints this process's own scheduling priority (nice
// value) once stdin closes, so runners-extensions.test.ts can prove the
// lowPriority option really lowers the child's priority.
const os = require('os');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(String(os.getPriority()));
  process.exit(0);
});
