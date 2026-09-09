/**
 * The Save that comes back "successful" with the change still pending: submitBatch resolves when
 * the batch request itself worked, so a PATCH answered 400 inside the change set leaves its reason
 * in the message manager alone. This is the filter that gets it onto the MessageBox.
 */
import { serverErrors, serverErrorText, UiMessage } from '../webapp/model/saveMessages';

const CTX = "/QuotaProfiles(11111111-1111-1111-1111-111111111111)";

describe('serverErrors', () => {
  it('keeps an unbound error - the service names no field', () => {
    const messages: UiMessage[] = [{ message: 'tokensPerDay must not exceed tokensPerWeek', type: 'Error' }];
    expect(serverErrors(messages, CTX)).toEqual(messages);
  });

  it('keeps an error bound to the shown context, target or targets', () => {
    expect(serverErrors([
      { message: 'a', type: 'Error', target: `${CTX}/tokensPerDay` },
      { message: 'b', type: 'Error', targets: [`${CTX}/spendPerDay`] },
      { message: 'c', type: 'Error', target: CTX }
    ], CTX).map(m => m.message)).toEqual(['a', 'b', 'c']);
  });

  it('drops an error bound to another row, and any bound error when nothing is shown', () => {
    const other = [{ message: 'stale', type: 'Error', target: '/QuotaProfiles(22222222-2222-2222-2222-222222222222)/tokensPerDay' }];
    expect(serverErrors(other, CTX)).toEqual([]);
    expect(serverErrors(other, null)).toEqual([]);
    expect(serverErrors([{ message: 'unbound', type: 'Error' }], null).map(m => m.message)).toEqual(['unbound']);
  });

  it('drops warnings, information and empty texts', () => {
    expect(serverErrors([
      { message: 'w', type: 'Warning' }, { message: 'i', type: 'Information' },
      { message: '   ', type: 'Error' }, { type: 'Error' }
    ], CTX)).toEqual([]);
  });

  it('is empty for no messages at all - the catalogs mode, where nothing was reported', () => {
    expect(serverErrors([], CTX)).toEqual([]);
    expect(serverErrors(null, CTX)).toEqual([]);
    expect(serverErrors(undefined, undefined)).toEqual([]);
  });
});

describe('serverErrorText', () => {
  it('is one message per line, deduplicated', () => {
    expect(serverErrorText([
      { message: 'tokensPerDay must not exceed tokensPerWeek', type: 'Error' },
      { message: 'spendPerDay must not exceed spendPerWeek', type: 'Error', target: `${CTX}/spendPerDay` },
      { message: 'tokensPerDay must not exceed tokensPerWeek', type: 'Error', target: `${CTX}/tokensPerDay` }
    ], CTX)).toBe('tokensPerDay must not exceed tokensPerWeek\nspendPerDay must not exceed spendPerWeek');
  });

  it('is empty when the server said nothing, so the MessageBox keeps its own wording', () => {
    expect(serverErrorText([{ message: 'w', type: 'Warning' }], CTX)).toBe('');
    expect(serverErrorText(null, CTX)).toBe('');
  });
});
