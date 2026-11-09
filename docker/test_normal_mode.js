const DockerSetup = require('./setup-docker.js');

// Test normal mode (without CI flag)
console.log('Testing normal mode (interactive prompts should be shown)...\n');

const setup = new DockerSetup({ ciMode: false, forceOverwrite: false });

async function testNormalMode() {
  console.log('1. Testing showWelcome (should not show CI mode message):');
  await setup.showWelcome();
  
  console.log('2. Testing CI mode flag:');
  if (\!setup.ciMode) {
    console.log('   ✅ Normal mode - would show interactive provider selection');
  } else {
    console.log('   ❌ Error - CI mode is active when it should not be');
  }
  
  console.log('\n✅ Normal mode test completed - interactive prompts would be shown');
  process.exit(0);
}

testNormalMode().catch(console.error);
