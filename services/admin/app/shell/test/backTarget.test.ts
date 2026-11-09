import { backTargetRoute } from '../webapp/model/backTarget';

describe('backTargetRoute', () => {
  it('a store opened from Jobs goes back to the stores list whatever entry loaded the component', () => {
    expect(backTargetRoute('groundingStoreDetail', 'groundingJobs')).toBe('groundingStores');
    expect(backTargetRoute('groundingStoreDetail', 'groundingFiles')).toBe('groundingStores');
    expect(backTargetRoute('groundingStoreDetail', 'groundingStores')).toBe('groundingStores');
    expect(backTargetRoute('groundingStoreDetail', 'groundingAdmin')).toBe('groundingStores');
  });
  it('a job goes back to the jobs list when Administration loaded the component', () => {
    expect(backTargetRoute('groundingJobDetail', 'groundingAdmin')).toBe('groundingJobs');
  });
  it('a job goes back to the jobs list whatever entry loaded the component', () => {
    expect(backTargetRoute('groundingJobDetail', 'groundingStores')).toBe('groundingJobs');
    expect(backTargetRoute('groundingJobDetail', 'groundingJobs')).toBe('groundingJobs');
  });
  it('other apps still decide by the app key', () => {
    expect(backTargetRoute('detail', 'modelLibrary')).toBe('library');
    expect(backTargetRoute('ApiKeysObjectPage', 'apiKeys')).toBe('ApiKeysList');
  });
  it('connections returns to ConnectionsList', () => {
    expect(backTargetRoute('ConnectionsObjectPage', 'connections')).toBe('ConnectionsList');
  });
  it('plugins returns to its one screen', () => {
    expect(backTargetRoute('anything', 'plugins')).toBe('pluginsList');
  });
  it('no target for an unknown app key', () => {
    expect(backTargetRoute('detail', 'nope')).toBeUndefined();
  });
});
