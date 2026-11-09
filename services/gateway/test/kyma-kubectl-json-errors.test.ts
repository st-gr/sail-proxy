/**
 * A kubectl answer that is not JSON must not leak its text: V8's JSON.parse error quotes a snippet
 * of the input, and the input can be a Secret's base64 data.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { readResourceData } = require('../../../kyma/scripts/kubectl-read.js');
const { readLiveValues } = require('../../../kyma/scripts/live-values.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const MARKER = 'SECRET-MARKER-c2VjcmV0';
const garbage = `{"data": {"k": "${MARKER}"  oops`;

describe('malformed kubectl output', () => {
  it('readResourceData reports a generic message without the output', () => {
    const run = () => garbage;
    let message = '';
    try {
      readResourceData(run, 'secret', 'admin-env', 'ns');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('unreadable JSON from kubectl get secret admin-env');
    expect(message).not.toContain(MARKER);
  });

  it('readLiveValues (deployment read) reports a generic message without the output', async () => {
    let message = '';
    try {
      await readLiveValues(() => garbage, 'ns', { adminEnv: {}, rendered: false });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/unreadable JSON from kubectl get \w+ \S+/);
    expect(message).not.toContain(MARKER);
  });
});
