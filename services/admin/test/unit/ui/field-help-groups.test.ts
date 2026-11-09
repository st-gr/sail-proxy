/**
 * The Field Help dialog groups fields whose help text is identical (teams polish, item 2). The
 * builder is copied into every app with a Field Help button; the copies must stay byte-identical.
 */
import * as fs from 'fs';
import * as path from 'path';
import { groupFieldHelp } from '../../../app/teams-app/webapp/ext/fieldHelpGroups';

const APP = path.resolve(__dirname, '../../../app');
const COPIES = ['teams-app', 'users-app', 'sap-rates-app'].map((app) => path.join(APP, app, 'webapp/ext/fieldHelpGroups.ts'));

describe('groupFieldHelp', () => {
  const limits = [
    { key: 'requestsPerMinute', label: 'Requests per Minute', text: 'rpm help' },
    { key: 'requestsPerMinuteDefaultText', label: 'Default', text: 'default help' },
    { key: 'spendPerDay', label: 'Spend per Day', text: 'spend help' },
    { key: 'spendPerDayDefaultText', label: 'Default', text: 'default help' },
    { key: 'spendPerWeek', label: 'Spend per Week', text: 'spend help' },
    { key: 'spendPerWeekDefaultText', label: 'Default', text: 'default help' },
    { key: 'name', label: 'Name' },
    { key: 'quotaProfile', label: 'Pool Profile', text: 'pool help' }
  ];

  it('names the fields that share a help text together, once, in the order they first appear', () => {
    expect(groupFieldHelp(limits)).toEqual([
      { title: 'Requests per Minute', text: 'rpm help' },
      { title: 'Default (Requests per Minute, Spend per Day, Spend per Week)', text: 'default help' },
      { title: 'Spend per Day, Spend per Week', text: 'spend help' },
      { title: 'Pool Profile', text: 'pool help' }
    ]);
  });

  it('keeps one entry per field when every text differs, and skips fields without help', () => {
    expect(groupFieldHelp([{ key: 'a', label: 'A', text: 'x' }, { key: 'b', label: 'B', text: 'y' }, { key: 'c', label: 'C', text: '' }]))
      .toEqual([{ title: 'A', text: 'x' }, { title: 'B', text: 'y' }]);
  });

  it('a label used once is not qualified, a repeated label without a base field is named once', () => {
    expect(groupFieldHelp([{ key: 'tokensPerDayDefaultText', label: 'Default', text: 'd' }, { key: 'tokensPerDay', label: 'Tokens per Day' }]))
      .toEqual([{ title: 'Default', text: 'd' }]);
    expect(groupFieldHelp([{ key: 'x', label: 'Same', text: 't' }, { key: 'y', label: 'Same', text: 't' }]))
      .toEqual([{ title: 'Same', text: 't' }]);
  });

  it('every app carries the same copy of the builder', () => {
    const [first, ...rest] = COPIES.map((f) => fs.readFileSync(f, 'utf8'));
    for (const copy of rest) expect(copy).toBe(first);
  });
});
