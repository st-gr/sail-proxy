import { copyText } from '../webapp/model/clipboard';

describe('copyText', () => {
  it('copies and answers with the text key of the message to show', async () => {
    const written: string[] = [];
    expect(await copyText({ writeText: async (t: string) => { written.push(t); } }, 'req-1')).toBe('requestIdCopied');
    expect(written).toEqual(['req-1']);
  });

  it('says copying is not available without a clipboard or when it refuses', async () => {
    expect(await copyText(undefined, 'req-1')).toBe('copyUnavailable');
    expect(await copyText({ writeText: async () => { throw new Error('denied'); } }, 'req-1')).toBe('copyUnavailable');
  });
});
