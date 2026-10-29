/**
 * Store visibility (spec 2026-10-14 §8): owner, all-users share, or a share with one of the
 * caller's teams. One function renders it; no source file spells its own copy.
 */
import fs from 'fs';
import path from 'path';
import * as recallSql from '../../src/fileSearch/recallSql';
import { annSearchedChunksKey } from '../../src/fileSearch/annPath';
import { callerTeamIds } from '../../src/utils/userBlock';

describe('storeAccessPredicateSql', () => {
  it('admits the owner, an all-users share and a team share, at the placeholder given', () => {
    expect(recallSql.storeAccessPredicateSql('$5')).toBe(
      '(vs.owner_email = $2 OR vs.is_shared = true OR EXISTS (SELECT 1 FROM vector_store_team_shares s WHERE s.store_id = vs.id AND s.team_id = ANY($5)))');
    expect(recallSql.storeAccessPredicateSql('$4', 'c')).toContain('c.owner_email = $2 OR c.is_shared = true');
  });

  it('the two-way constant is gone and no source file spells the predicate itself', () => {
    expect((recallSql as any).STORE_ACCESS_PREDICATE_SQL).toBeUndefined();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('recallSql.ts') && /owner_email = \$2 OR \w+\.is_shared/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.resolve(__dirname, '../../src'));
    expect(offenders).toEqual([]);
  });

  it('every chunk scope binds the team ids at the placeholder it is given', () => {
    const scope = recallSql.chunkScopeSql('', '$1', '$7');
    expect(scope.split(recallSql.storeAccessPredicateSql('$7')).length - 1).toBe(2);
    expect(scope).not.toContain('ANY($5)');
  });
});

describe('cache keys name the caller\'s teams (a count must not answer for another team set)', () => {
  it('annSearchedChunksKey differs by team set and ignores team order', () => {
    const a = annSearchedChunksKey(10, 'u@example.com', ['t1', 't2'], ['vs_1'], 'm');
    expect(annSearchedChunksKey(10, 'u@example.com', ['t2', 't1'], ['vs_1'], 'm')).toBe(a);
    expect(annSearchedChunksKey(10, 'u@example.com', [], ['vs_1'], 'm')).not.toBe(a);
    expect(annSearchedChunksKey(10, 'u@example.com', ['t1'], ['vs_1'], 'm')).not.toBe(a);
  });
});

describe('callerTeamIds', () => {
  const block = (teamIds?: unknown) => ({ email: 'u@example.com', status: 'active', roles: [], limits: {}, teamIds });

  it('reads the validated user block of an API key or a token', () => {
    expect(callerTeamIds({ apiKeyInfo: { user: block(['t1', 't2']) } })).toEqual(['t1', 't2']);
    expect(callerTeamIds({ unifiedAuth: { data: { user: block(['t3']) } } })).toEqual(['t3']);
  });

  it('absent team ids (an older admin, standalone) mean no teams', () => {
    expect(callerTeamIds({})).toEqual([]);
    expect(callerTeamIds({ apiKeyInfo: { user: block(undefined) } })).toEqual([]);
    expect(callerTeamIds(undefined)).toEqual([]);
  });

  it('a cockpit call uses the acting user\'s teams, never the service key\'s', () => {
    expect(callerTeamIds({ groundingActor: { email: 'u@example.com', role: 'user', teamIds: ['t9'] },
      unifiedAuth: { data: { user: block(['t1']) } } })).toEqual(['t9']);
    // An actor without team ids (an admin before the acting-teams header) has none.
    expect(callerTeamIds({ groundingActor: { email: 'u@example.com', role: 'user' },
      unifiedAuth: { data: { user: block(['t1']) } } })).toEqual([]);
  });

  it('keeps only string ids', () => {
    expect(callerTeamIds({ groundingActor: { email: 'u@example.com', role: 'user', teamIds: ['t1', 3, null] } })).toEqual(['t1']);
  });
});
