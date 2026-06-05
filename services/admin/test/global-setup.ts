import { setupTestEnvironment } from './test-utils';

export default async function globalSetup() {
  console.log('Setting up test environment...');
  await setupTestEnvironment();
}