// Test fixture only — dumps this process's own environment to stdout once
// stdin closes, so runners.test.ts can prove the child never inherits the
// gateway's environment (credentials, etc.) when spawned with env: {}.
let chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(process.env));
  process.exit(0);
});
