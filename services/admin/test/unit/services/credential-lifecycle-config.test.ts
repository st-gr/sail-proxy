/**
 * credentialLifecycle reads api_config.json through utils/apiConfigFile (cwd/config, cwd, source
 * path), not a __dirname path that points into dist/ once compiled (the Docker ENOENT, carried
 * Part A finding).
 */
jest.mock('../../../src/utils/apiConfigFile', () => ({
  readApiConfigBlock: jest.fn(() => ({ platform: { security: { credentialExpirationDays: 30 } } }))
}));
import { readApiConfigBlock } from '../../../src/utils/apiConfigFile';
import * as lifecycle from '../../../src/services/credentialLifecycle';

it('takes credentialExpirationDays from the shared api_config reader', () => {
  expect(lifecycle.credentialExpirationDays()).toBe(30);
  expect(readApiConfigBlock).toHaveBeenCalled();
});
