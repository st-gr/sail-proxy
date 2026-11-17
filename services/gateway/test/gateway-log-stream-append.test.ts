import { describe, it, expect, jest } from '@jest/globals';
import { SecurityEventEmitter } from '../src/services/securityEventEmitter';

const newEmitter = () => new SecurityEventEmitter({ valkeyEnabled: true, memoryQueueSize: 10, batchSize: 10, flushInterval: 60000 });

describe('appendGatewayLogBatch', () => {
  it('appends the batch as one stream entry, capped at 300 batches (at most 60,000 log entries)', async () => {
    const xadd = jest.fn(async () => '1-0');
    const emitter = newEmitter();
    emitter.setValkeyClient({ status: 'ready', xadd });
    const batch = [{ t: '2026-11-11T10:00:00.000Z', seq: 1, level: 'INFO', component: 'x', message: 'hello' }];
    await emitter.appendGatewayLogBatch(batch);
    expect(xadd).toHaveBeenCalledTimes(1);
    expect(xadd).toHaveBeenCalledWith('gateway-log', 'MAXLEN', '~', '300', '*', 'batch', JSON.stringify(batch));
  });

  it('rejects when there is no client, or the client is not ready', async () => {
    const emitter = newEmitter();
    await expect(emitter.appendGatewayLogBatch([])).rejects.toThrow('no Valkey client');
    const xadd = jest.fn();
    emitter.setValkeyClient({ status: 'connecting', xadd });
    await expect(emitter.appendGatewayLogBatch([])).rejects.toThrow('no Valkey client');
    expect(xadd).not.toHaveBeenCalled();
  });
});
