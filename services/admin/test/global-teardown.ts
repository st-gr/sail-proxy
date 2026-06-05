import { teardownTestEnvironment } from './test-utils';

export default async function globalTeardown() {
  console.log('Cleaning up test environment...');
  await teardownTestEnvironment();
}