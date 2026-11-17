import { credentialItems, keyListOutcome, rawCaptureForm, splitEmails, startedNotice } from '../webapp/model/rawCaptureForm';
import type { ApiResult, EntriesBody } from '../webapp/model/api';

const input = (over: Record<string, unknown> = {}) => ({ apiKeyIds: [] as string[], emails: '', minutes: '60', reason: 'Error analysis for a ticket', ...over });

describe('rawCaptureForm', () => {
  it('refuses a start without any key or address', () => {
    expect(rawCaptureForm(input())).toEqual({ ok: false, reason: 'no-target' });
    expect(rawCaptureForm(input({ emails: ' ,; \n' }))).toEqual({ ok: false, reason: 'no-target' });
  });

  it('refuses a start without a reason', () => {
    expect(rawCaptureForm(input({ apiKeyIds: ['k1'], reason: '   ' }))).toEqual({ ok: false, reason: 'no-reason' });
  });

  it('refuses a duration other than 15 minutes, 1 hour or 4 hours', () => {
    for (const minutes of ['30', '', 'keep', 1440, 0]) {
      expect(rawCaptureForm(input({ apiKeyIds: ['k1'], minutes }))).toEqual({ ok: false, reason: 'duration' });
    }
  });

  it('gives the parameters of startRawCapture: keys, addresses, minutes as a number, the reason trimmed', () => {
    expect(rawCaptureForm(input({ apiKeyIds: ['k1', 'k1', 'aws-1'], emails: 'jane.roe@example.org, john.doe@example.org', minutes: '15', reason: ' Ticket 42 ' }))).toEqual({
      ok: true,
      payload: { apiKeyIds: ['k1', 'aws-1'], emails: ['jane.roe@example.org', 'john.doe@example.org'], minutes: 15, reason: 'Ticket 42' }
    });
    expect(rawCaptureForm(input({ emails: 'jane.roe@example.org', minutes: 240 }))).toMatchObject({ ok: true, payload: { apiKeyIds: [], minutes: 240 } });
  });
});

describe('splitEmails', () => {
  it('splits at commas, semicolons, spaces and line breaks, once each', () => {
    expect(splitEmails('jane.roe@example.org;john.doe@example.org\n jane.roe@example.org ,')).toEqual(['jane.roe@example.org', 'john.doe@example.org']);
    expect(splitEmails('')).toEqual([]);
  });
});

describe('credentialItems', () => {
  it('lists the API keys and AWS credentials by name, with the owner\'s address, AWS marked', () => {
    const items = credentialItems(
      [{ ID: 'k2', name: 'Zeta', email: 'jane.roe@example.org' }, { ID: 'k1', name: null, maskedKey: 'abc…xyz', email: null }, { ID: null }],
      [{ ID: 'a1', name: 'Build', accessKeyId: 'not-shown', email: 'john.doe@example.org' }],
      'AWS'
    );
    expect(items).toEqual([
      { id: 'k1', text: 'abc…xyz', additionalText: '' },
      { id: 'a1', text: 'Build (AWS)', additionalText: 'john.doe@example.org' },
      { id: 'k2', text: 'Zeta', additionalText: 'jane.roe@example.org' }
    ]);
  });

  const NOW = new Date('2026-11-13T10:00:00.000Z');

  it('leaves out the admin\'s own gateway service key, and keys that are revoked, deleted or expired', () => {
    const items = credentialItems(
      [
        { ID: 'svc', name: 'Admin Service to Gateway', email: 'admin2gateway.service.key', isActive: true },
        { ID: 'off', name: 'Off', email: 'jane.roe@example.org', isActive: false },
        { ID: 'gone', name: 'Gone', email: 'jane.roe@example.org', deletedAt: '2026-11-01T00:00:00.000Z' },
        { ID: 'old', name: 'Old', email: 'jane.roe@example.org', expiresAt: '2026-11-13T09:59:59.000Z' },
        { ID: 'now', name: 'Ends now', email: 'jane.roe@example.org', expiresAt: '2026-11-13T10:00:00.000Z' },
        { ID: 'later', name: 'Later', email: 'jane.roe@example.org', isActive: true, expiresAt: '2026-12-01T00:00:00.000Z' },
        { ID: 'never', name: 'Never', email: 'jane.roe@example.org', neverExpires: true, expiresAt: '2026-01-01T00:00:00.000Z' }
      ],
      [
        { ID: 'a-off', name: 'Build off', email: 'john.doe@example.org', isActive: false },
        { ID: 'a-old', name: 'Build old', email: 'john.doe@example.org', expiresAt: '2026-11-12T00:00:00.000Z' },
        { ID: 'a-ok', name: 'Build', email: 'john.doe@example.org', expiresAt: null }
      ],
      'AWS', NOW
    );
    expect(items.map((item) => item.id)).toEqual(['a-ok', 'later', 'never']);
  });
});

const ok = (entries: any[]): ApiResult<EntriesBody> => ({ ok: true, status: 200, body: { entries, count: null, serverDate: null }, error: null });
const failed = (message: string): ApiResult<EntriesBody> => ({ ok: false, status: 500, body: null, error: { status: 500, code: 'http_500', message } });
const t = (key: string, args?: (string | number)[]) => (args && args.length ? `${key}(${args.join('|')})` : key);

describe('keyListOutcome', () => {
  it('lists both reads with no message when both answered', () => {
    const outcome = keyListOutcome(ok([{ ID: 'k1', name: 'Key' }]), ok([{ ID: 'a1', name: 'Build' }]), t, new Date());
    expect(outcome).toEqual({ items: [{ id: 'a1', text: 'Build (awsCredential)', additionalText: '' }, { id: 'k1', text: 'Key', additionalText: '' }], error: '' });
  });

  it('a failed AWS credentials read is said, the API keys are still listed', () => {
    const outcome = keyListOutcome(ok([{ ID: 'k1', name: 'Key' }]), failed('Server down.'), t, new Date());
    expect(outcome.items.map((item) => item.id)).toEqual(['k1']);
    expect(outcome.error).toBe('rawCaptureAwsUnread(Server down.)');
  });

  it('a failed API key read shows the service\'s message; both failing say both', () => {
    expect(keyListOutcome(failed('No keys.'), ok([]), t, new Date())).toEqual({ items: [], error: 'No keys.' });
    expect(keyListOutcome(failed('No keys.'), failed('No AWS.'), t, new Date()).error).toBe('No keys. rawCaptureAwsUnread(No AWS.)');
  });
});

describe('startedNotice', () => {
  const started = { ID: 's1', endsAt: '2026-11-13T11:00:00.000Z', credentialCount: 2, keyWarning: null };
  const time = (iso: string) => `at ${iso}`;

  it('a start without a key warning is a short note', () => {
    expect(startedNotice(started, t, time)).toEqual({ warning: false, text: 'rawCaptureStarted(2|at 2026-11-13T11:00:00.000Z)' });
  });

  it('one credential takes the singular wording', () => {
    expect(startedNotice({ ...started, credentialCount: 1 }, t, time))
      .toEqual({ warning: false, text: 'rawCaptureStartedOne(1|at 2026-11-13T11:00:00.000Z)' });
  });

  it('the service\'s key warning turns it into a warning that shows it below the note', () => {
    expect(startedNotice({ ...started, keyWarning: 'The seal key is weak.' }, t, time))
      .toEqual({ warning: true, text: 'rawCaptureStarted(2|at 2026-11-13T11:00:00.000Z)\n\nThe seal key is weak.' });
  });
});
