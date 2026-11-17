import { rawCaptureNotice } from '../webapp/model/rawCaptureNotice';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const session = (over: Record<string, unknown> = {}) => ({
  ID: 's1', endsAt: '2026-11-13T11:00:00.000Z', startedBy: 'jane.roe@example.org', keyCount: 2, addressCount: 1, ...over
});

describe('rawCaptureNotice', () => {
  it('is hidden while no session runs', () => {
    expect(rawCaptureNotice([], NOW)).toEqual({ visible: false, text: '' });
    expect(rawCaptureNotice(null, NOW)).toEqual({ visible: false, text: '' });
  });

  it('is hidden when the only session has ended by now (it ended between two polls)', () => {
    expect(rawCaptureNotice([session({ endsAt: '2026-11-13T09:59:59.000Z' })], NOW).visible).toBe(false);
  });

  it('one session: the keys and addresses, who started it and when it ends', () => {
    expect(rawCaptureNotice([session()], NOW, undefined, (iso) => `<${iso}>`)).toEqual({
      visible: true,
      text: 'A raw capture is running (API keys: 2, e-mail addresses: 1), started by jane.roe@example.org. It ends at <2026-11-13T11:00:00.000Z>.'
    });
  });

  it('two sessions: the counts added up, who started them (earliest end first), and the earliest end', () => {
    const notice = rawCaptureNotice([
      session({ ID: 's2', endsAt: '2026-11-13T14:00:00.000Z', startedBy: 'john.doe@example.org', keyCount: 0, addressCount: 3 }),
      session({ ID: 's1', endsAt: '2026-11-13T10:15:00.000Z' }),
      session({ ID: 's3', endsAt: '2026-11-13T12:00:00.000Z' })
    ], NOW, undefined, (iso) => `<${iso}>`);
    expect(notice).toEqual({
      visible: true,
      text: '3 raw captures are running (API keys: 4, e-mail addresses: 5), started by jane.roe@example.org, john.doe@example.org. The first ends at <2026-11-13T10:15:00.000Z>.'
    });
  });

  it('uses the injected translator', () => {
    const t = (key: string, args?: (string | number)[]) => `${key}:${(args ?? []).join('|')}`;
    expect(rawCaptureNotice([session()], NOW, t, (iso) => iso).text).toBe('rawCapture.one:2|1|jane.roe@example.org|2026-11-13T11:00:00.000Z');
  });
});
