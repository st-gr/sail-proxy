import { loadTeams } from '../webapp/model/teams';
import { errorOf } from '../webapp/model/api';
import { errorMessage, teamErrorMessage } from '../webapp/model/errors';

describe('loadTeams (spec 2026-10-14 §8)', () => {
  it('a member can share with the teams they administer only', async () => {
    const fetchJson = jest.fn(async () => ({ value: [{ teamId: 't1', name: 'Alpha', role: 'admin' }, { teamId: 't2', name: 'Beta', role: 'member' }] }));
    expect(await loadTeams(false, fetchJson)).toEqual([{ id: 't1', name: 'Alpha', canShare: true }, { id: 't2', name: 'Beta', canShare: false }]);
    expect(fetchJson).toHaveBeenCalledWith('/odata/v4/admin/myTeams()');
  });
  it('a platform admin can share with every team', async () => {
    const fetchJson = jest.fn(async (_url: string) => ({ value: [{ ID: 't1', name: 'Alpha' }] }));
    expect(await loadTeams(true, fetchJson)).toEqual([{ id: 't1', name: 'Alpha', canShare: true }]);
    expect(fetchJson.mock.calls[0][0]).toMatch(/^\/odata\/v4\/admin\/Teams\?/);
  });
  it('a failed read yields no teams', async () => {
    expect(await loadTeams(false, async () => { throw new Error('down'); })).toEqual([]);
  });
});

describe('team share errors', () => {
  it('maps the gateway shape by code to the cockpit text', () => {
    const error = errorOf(403, { error: { code: 'team_admin_required', message: 'Gateway English.' } });
    expect(errorMessage(error)).toBe('Only an administrator of that team can change its shares.');
    expect(teamErrorMessage(error, 'requestFailed')).toBe('Only an administrator of that team can change its shares.');
  });
  it('maps the admin layer flat shape by code', () => {
    const error = errorOf(404, { error: 'team_not_found', message: 'Translated by the admin.' });
    expect(teamErrorMessage(error, 'requestFailed')).toBe('The team no longer exists.');
  });
  it('maps invalid_team_id to the invalid request text', () => {
    const error = errorOf(400, { error: { code: 'invalid_team_id', message: 'English.' } });
    expect(teamErrorMessage(error, 'requestFailed')).toBe('The server did not accept a value of the request, such as a filter. Check it and try again.');
  });
  it('an unknown code falls back to the generic text, never the gateway English', () => {
    const error = errorOf(500, { error: { code: 'something_new', message: 'Gateway English.' } });
    expect(teamErrorMessage(error, 'requestFailed')).toBe('requestFailed');
  });
});
