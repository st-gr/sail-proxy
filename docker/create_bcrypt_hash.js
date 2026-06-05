const bcrypt = require('bcrypt');
const readline = require('readline');
const { Writable } = require('stream');

async function hashPassword(password) {
  // Dex uses a cost of 10 by default, so we'll match that.
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(password, saltRounds);
  return hashedPassword;
}

async function main() {
  const mutableStdout = new Writable({
    write: function(chunk, encoding, callback) {
      if (!this.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true
  });

  mutableStdout.muted = false;
  rl.question('Enter password: ', async (password) => {
    rl.close();
    const hashedPassword = await hashPassword(password);
    console.log(`\n# bcrypt hash for use in dex.config.yaml`);
    console.log(`hash: "${hashedPassword}"`);
  });
  mutableStdout.muted = true;
}

main();
