/**
 * Deployment polling mirrors cli-tools/sail-model-deploy.js: every 5 s, at most 300 s, stop on
 * RUNNING / DEAD / STOPPED. The timer is injected so the test runs instantly.
 */
import { pollUntilSettled, messageFor } from '../webapp/model/deploymentPoll';

const fakeWait = () => Promise.resolve();

describe('pollUntilSettled', () => {
  it('resolves running when the status reaches RUNNING', async () => {
    const statuses = ['PENDING', 'PENDING', 'RUNNING'];
    const r = await pollUntilSettled(async () => statuses.shift()!, { wait: fakeWait, intervalSeconds: 5, timeoutSeconds: 300 });
    expect(r).toEqual({ status: 'RUNNING', elapsedSeconds: 10, outcome: 'running' });
  });
  it('resolves failed on DEAD or STOPPED', async () => {
    const r = await pollUntilSettled(async () => 'DEAD', { wait: fakeWait, intervalSeconds: 5, timeoutSeconds: 300 });
    expect(r.outcome).toBe('failed'); expect(r.status).toBe('DEAD');
  });
  it('gives up after the timeout with the last status', async () => {
    const r = await pollUntilSettled(async () => 'PENDING', { wait: fakeWait, intervalSeconds: 5, timeoutSeconds: 15 });
    expect(r).toEqual({ status: 'PENDING', elapsedSeconds: 15, outcome: 'timeout' });
  });
  it('keeps polling through a transient read error', async () => {
    let n = 0;
    const r = await pollUntilSettled(async () => { n++; if (n === 1) throw new Error('boom'); return 'RUNNING'; }, { wait: fakeWait, intervalSeconds: 5, timeoutSeconds: 300 });
    expect(r.outcome).toBe('running');
  });
  it('messages use the CLI wording', () => {
    expect(messageFor({ status: 'RUNNING', elapsedSeconds: 10, outcome: 'running' })).toBe('Deployment is now RUNNING');
    expect(messageFor({ status: 'DEAD', elapsedSeconds: 10, outcome: 'failed' })).toBe('Deployment failed with status: DEAD');
    expect(messageFor({ status: 'PENDING', elapsedSeconds: 300, outcome: 'timeout' })).toBe('Timeout reached after 300 seconds. Last known status: PENDING');
  });
});
