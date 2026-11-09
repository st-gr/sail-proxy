import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredState, diff } from './plan.mjs';

const ids = { admin: { name: 'Mara Lindqvist', email: 'mara.lindqvist@example.com', role: 'admin' }, users: [
  { name: 'Tomás Oyelaran', email: 'tomas.oyelaran@example.com', role: 'user' },
  { name: 'Priya Natarajan', email: 'priya.natarajan@example.com', role: 'user' },
  { name: 'Jonas Ekberg', email: 'jonas.ekberg@example.com', role: 'user' } ] };

test('desired state: one key per person plus a disabled and an expired key, one credential, one profile, one policy, one price', () => {
  const d = desiredState(ids);
  assert.equal(d.keys.length, 6);
  assert.deepEqual(d.keys.map((k) => k.name), ['Mara Lindqvist laptop', 'Tomás Oyelaran laptop', 'Priya Natarajan laptop', 'Jonas Ekberg laptop', 'Old CI runner', 'Trial key']);
  assert.equal(d.keys[4].state, 'disabled'); assert.equal(d.keys[5].state, 'expired');
  assert.equal(d.aws.email, 'tomas.oyelaran@example.com');
  assert.equal(d.quotaProfile.name, 'Standard team');
  assert.equal(d.toolPolicy.name, 'Default developer policy');
  assert.equal(d.price.contains, 'image');
});

test('diff creates only what is missing, matched by name and email', () => {
  const d = desiredState(ids);
  const existing = { keys: [{ name: 'Mara Lindqvist laptop', email: 'mara.lindqvist@example.com' }], aws: [], quotaProfiles: [{ name: 'Standard team' }], toolPolicies: [], prices: [], priceModelId: 'gemini-3.1-flash-image' };
  const todo = diff(d, existing);
  assert.equal(todo.keys.length, 5);
  assert.deepEqual(todo.aws, d.aws);
  assert.equal(todo.quotaProfile, null);
  assert.deepEqual(todo.toolPolicy, d.toolPolicy);
  assert.equal(todo.price.modelId, 'gemini-3.1-flash-image');
});

test('diff treats a manual price for the resolved model and a named credential as existing', () => {
  const d = desiredState(ids);
  const existing = { keys: [], aws: [{ name: 'Bedrock client', email: 'tomas.oyelaran@example.com' }], quotaProfiles: [], toolPolicies: [], prices: [{ model: 'gemini-3.1-flash-image' }], priceModelId: 'gemini-3.1-flash-image' };
  const todo = diff(d, existing);
  assert.equal(todo.aws, null);
  assert.equal(todo.price, null);
  assert.notEqual(diff(d, { ...existing, priceModelId: 'other-image' }).price, null);
});

test('desired state has the "Platform team": a pool, a member profile (a default, not a cap), three members, the developer policy', () => {
  const t = desiredState(ids).team;
  assert.equal(t.name, 'Platform team');
  assert.equal(t.spendPerMonth, 1000);
  assert.equal(t.memberProfile.name, 'Team member default'); assert.equal(t.memberProfile.spendPerMonth, 200);
  assert.deepEqual(t.members, [{ email: 'tomas.oyelaran@example.com', role: 'admin' }, { email: 'priya.natarajan@example.com', role: 'member' }, { email: 'jonas.ekberg@example.com', role: 'member' }]);
  assert.equal(t.toolPolicy, 'Default developer policy');
});

test('diff creates the team only when no team of that name exists', () => {
  const d = desiredState(ids);
  const existing = { keys: [], aws: [], quotaProfiles: [], toolPolicies: [], prices: [], priceModelId: 'x', teams: [] };
  assert.deepEqual(diff(d, existing).team, d.team);
  assert.equal(diff(d, { ...existing, teams: [{ name: 'Platform team' }] }).team, null);
});
