import { rebaseDeploymentUrl } from '../src/utils/sapDeploymentUrl';

const SAP = 'https://api.ai.example.test/v2/inference/deployments/d1';
const BASE = 'https://relay.example.test/k3y/api';

describe('rebaseDeploymentUrl', () => {
  it('leaves the URL alone without a base', () => {
    expect(rebaseDeploymentUrl(SAP, undefined)).toBe(SAP);
    expect(rebaseDeploymentUrl(SAP, '')).toBe(SAP);
  });
  it('moves an https deployment URL under the base, keeping path and query', () => {
    expect(rebaseDeploymentUrl(`${SAP}?a=1`, BASE)).toBe('https://relay.example.test/k3y/api/v2/inference/deployments/d1?a=1');
  });
  it('joins with exactly one slash whatever trailing slashes there are', () => {
    expect(rebaseDeploymentUrl(`${SAP}/`, `${BASE}/`)).toBe('https://relay.example.test/k3y/api/v2/inference/deployments/d1/');
  });
  it('keeps wss for a realtime deployment', () => {
    expect(rebaseDeploymentUrl('wss://api.ai.example.test/v2/inference/deployments/rt', BASE))
      .toBe('wss://relay.example.test/k3y/api/v2/inference/deployments/rt');
  });
  it('leaves a URL outside /v2/ and an unparsable value untouched', () => {
    expect(rebaseDeploymentUrl('https://api.ai.example.test/other/x', BASE)).toBe('https://api.ai.example.test/other/x');
    expect(rebaseDeploymentUrl('not a url', BASE)).toBe('not a url');
    expect(rebaseDeploymentUrl(undefined, BASE)).toBeUndefined();
  });
});
