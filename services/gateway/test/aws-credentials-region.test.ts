/**
 * The gateway's AWS credential region follows the SAP AI Core target in force, and both region
 * formats (the environment's "us-east-1" and the service key parser's "prod.us-east-1") name one AWS region.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { createAwsCredentials } from '../src/services/awsCredentialsService';
import { awsRegionFromSapRegion, environmentSapTarget, installSapTarget } from '../src/sap/sapTarget';

describe('awsRegionFromSapRegion', () => {
  it.each([
    ['us-east-1', 'us-east-1'],
    ['prod.us-east-1', 'us-east-1'],
    ['eu-central-1', 'eu-central-1'],
    ['prod.eu-central-1', 'eu-central-1'],
  ])('%s maps to %s', (sap, aws) => {
    expect(awsRegionFromSapRegion(sap)).toBe(aws);
  });
});

describe('createAwsCredentials region', () => {
  const saved = process.env.SAP_AI_REGION;
  afterEach(() => {
    if (saved === undefined) delete process.env.SAP_AI_REGION; else process.env.SAP_AI_REGION = saved;
  });

  it('follows the environment when no connection is installed', async () => {
    process.env.SAP_AI_REGION = 'us-west-2';
    expect((await createAwsCredentials('rg-user')).AWS_REGION).toBe('us-west-2');
  });

  it('follows the installed target', async () => {
    process.env.SAP_AI_REGION = 'us-east-1';
    installSapTarget({ ...environmentSapTarget(), region: 'prod.eu-central-1', source: 'connection', connectionId: 'c1' });
    expect((await createAwsCredentials('rg-user')).AWS_REGION).toBe('eu-central-1');
  });
});
