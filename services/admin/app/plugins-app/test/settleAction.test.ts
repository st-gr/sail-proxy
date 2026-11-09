import { settleAction } from '../webapp/model/settleAction';
import type { ApiResult } from '../webapp/model/api';

// After an upload, enable, disable or removal the list is read again. A success used to be
// announced first, so for the seconds the list took the table still showed the old state
// ("No plugin has been uploaded yet" under "Plugin acme 1.0.0 is stored").
function recorder() {
  const events: string[] = [];
  return {
    events,
    ui: {
      reload: async () => {
        await new Promise((r) => setTimeout(r, 5));
        events.push('reload');
      },
      error: (m: string) => events.push(`error:${m}`),
      warning: (m: string) => events.push(`warning:${m}`),
      success: (m: string, dialog: boolean) => events.push(`${dialog ? 'dialog' : 'toast'}:${m}`),
    },
  };
}

const ok = (body: unknown = {}): ApiResult => ({ ok: true, status: 200, body, error: null });
const failed: ApiResult = { ok: false, status: 409, body: null, error: { status: 409, code: 'CONFLICT', message: 'Taken.' } };

describe('settleAction', () => {
  it('announces a success only once the list shows it', async () => {
    const { events, ui } = recorder();
    await settleAction(ok(), 'Plugin acme 1.0.0 is stored and disabled.', ui, 'Failed.');
    expect(events).toEqual(['reload', 'toast:Plugin acme 1.0.0 is stored and disabled.']);
  });

  it('shows a success with warnings once the list shows it', async () => {
    const { events, ui } = recorder();
    await settleAction(ok({ warnings: [{ message: 'Hook not found.' }] }), 'Enabled.', ui, 'Failed.');
    expect(events).toEqual(['reload', 'warning:Enabled.\n\nHook not found.']);
  });

  it('uses a dialog when asked, after the list', async () => {
    const { events, ui } = recorder();
    await settleAction(ok(), 'Added.', ui, 'Failed.', true);
    expect(events).toEqual(['reload', 'dialog:Added.']);
  });

  it('shows a refusal at once and reads the list after it', async () => {
    const { events, ui } = recorder();
    await settleAction(failed, 'never shown', ui, 'Failed.');
    expect(events).toEqual(['error:Taken.', 'reload']);
  });

  it('falls back to the general message when a refusal carries none', async () => {
    const { events, ui } = recorder();
    await settleAction({ ok: false, status: 0, body: null, error: null }, 'never shown', ui, 'Failed.');
    expect(events[0]).toBe('error:Failed.');
  });
});
