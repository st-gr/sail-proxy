import { describe, it, expect } from '@jest/globals';
import { resolveDeployedTwin } from '../src/utils/deployedTwin';

const catalogue: Record<string, any> = {
  'gpt-realtime': { id: 'gpt-realtime', routable: false },
  'gpt-realtime--deployed': { id: 'gpt-realtime--deployed', deploymentUrl: 'wss://realtime.example/v2/inference/deployments/d1' },
  'gemini-3.5-flash': { id: 'gemini-3.5-flash' },
  'gemini-3.5-flash--deployed': { id: 'gemini-3.5-flash--deployed', deploymentUrl: 'https://x/v2/inference/deployments/d2' },
  'gemini-2.5-pro': { id: 'gemini-2.5-pro' },
};
const get = async (id: string) => catalogue[id] ?? null;

describe('resolveDeployedTwin', () => {
  it('resolves a bare model to its --deployed twin', async () => {
    await expect(resolveDeployedTwin('gpt-realtime', get)).resolves.toEqual({
      id: 'gpt-realtime--deployed', baseModel: 'gpt-realtime', deploymentUrl: 'wss://realtime.example/v2/inference/deployments/d1',
    });
  });
  it('resolves an explicit --deployed id directly, with the base model stripped', async () => {
    await expect(resolveDeployedTwin('gemini-3.5-flash--deployed', get)).resolves.toEqual({
      id: 'gemini-3.5-flash--deployed', baseModel: 'gemini-3.5-flash', deploymentUrl: 'https://x/v2/inference/deployments/d2',
    });
  });
  it('returns null when neither the model nor its twin carries a deploymentUrl', async () => {
    await expect(resolveDeployedTwin('gemini-2.5-pro', get)).resolves.toBeNull();
    await expect(resolveDeployedTwin('nope', get)).resolves.toBeNull();
  });
  it('asks the catalogue for the bare id first and the twin only when needed', async () => {
    const asked: string[] = [];
    const spy = async (id: string) => { asked.push(id); return get(id); };
    await resolveDeployedTwin('gemini-3.5-flash--deployed', spy);
    expect(asked).toEqual(['gemini-3.5-flash--deployed']);
    asked.length = 0;
    await resolveDeployedTwin('gpt-realtime', spy);
    expect(asked).toEqual(['gpt-realtime', 'gpt-realtime--deployed']);
  });
});
