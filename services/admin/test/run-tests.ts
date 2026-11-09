import { execSync } from 'child_process';
import { join } from 'path';

async function runTests() {
  const testSuites = [
    {
      name: 'Unit Tests - Entities',
      pattern: 'test/unit/entities/**/*.test.ts',
      timeout: 30000
    },
    {
      name: 'Unit Tests - Services',
      pattern: 'test/unit/services/**/*.test.ts',
      timeout: 45000
    },
    {
      name: 'Integration Tests - API',
      pattern: 'test/integration/api/**/*.test.ts',
      timeout: 60000
    },
    {
      name: 'Integration Tests - Workflows',
      pattern: 'test/integration/workflows/**/*.test.ts',
      timeout: 90000
    },
    {
      name: 'Security Tests',
      pattern: 'test/security/**/*.test.ts',
      timeout: 45000
    }
  ];

  console.log('🚀 Starting SAP CAP Admin Service Test Suite\n');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTime = 0;

  for (const suite of testSuites) {
    console.log(`📋 Running ${suite.name}...`);
    const startTime = Date.now();

    try {
      const result = execSync(
        `npx jest --config=jest.config.js --testPathPattern="${suite.pattern}" --testTimeout=${suite.timeout} --verbose`,
        { 
          cwd: process.cwd(),
          stdio: 'inherit',
          encoding: 'utf8'
        }
      );

      const endTime = Date.now();
      const duration = endTime - startTime;
      totalTime += duration;

      console.log(`✅ ${suite.name} completed in ${duration}ms\n`);
      totalPassed++;
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;
      totalTime += duration;

      console.log(`❌ ${suite.name} failed in ${duration}ms\n`);
      totalFailed++;
    }
  }

  // Run coverage report
  console.log('📊 Generating coverage report...');
  try {
    execSync('npx jest --config=jest.config.js --coverage --testPathPattern="test/**/*.test.ts"', {
      cwd: process.cwd(),
      stdio: 'inherit'
    });
    console.log('✅ Coverage report generated\n');
  } catch (error) {
    console.log('❌ Failed to generate coverage report\n');
  }

  // Summary
  console.log('📈 Test Summary:');
  console.log(`  Total Suites: ${testSuites.length}`);
  console.log(`  Passed: ${totalPassed}`);
  console.log(`  Failed: ${totalFailed}`);
  console.log(`  Total Time: ${totalTime}ms`);
  
  if (totalFailed > 0) {
    console.log('\n❌ Some test suites failed');
    process.exit(1);
  } else {
    console.log('\n✅ All test suites passed!');
    process.exit(0);
  }
}

// Run individual test suite if specified
const suite = process.argv[2];
if (suite) {
  console.log(`🎯 Running specific test suite: ${suite}`);
  
  const patterns = {
    'entities': 'test/unit/entities/**/*.test.ts',
    'services': 'test/unit/services/**/*.test.ts',
    'api': 'test/integration/api/**/*.test.ts',
    'workflows': 'test/integration/workflows/**/*.test.ts',
    'security': 'test/security/**/*.test.ts',
    'all': 'test/**/*.test.ts'
  };

  const pattern = patterns[suite as keyof typeof patterns];
  if (!pattern) {
    console.log(`❌ Unknown test suite: ${suite}`);
    console.log(`Available suites: ${Object.keys(patterns).join(', ')}`);
    process.exit(1);
  }

  try {
    execSync(`npx jest --config=jest.config.js --testPathPattern="${pattern}" --verbose`, {
      cwd: process.cwd(),
      stdio: 'inherit'
    });
    console.log(`✅ ${suite} tests completed`);
  } catch (error) {
    console.log(`❌ ${suite} tests failed`);
    process.exit(1);
  }
} else {
  runTests();
}