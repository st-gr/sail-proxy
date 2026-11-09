// What the demo stack should contain (pure): derived from identities.json so the data is invented by construction.
export function desiredState(ids) {
  const people = [ids.admin, ...ids.users];
  const keys = people.map((p) => ({ name: `${p.name} laptop`, email: p.email, state: 'active' }));
  keys.push({ name: 'Old CI runner', email: ids.users[2].email, state: 'disabled' });
  keys.push({ name: 'Trial key', email: ids.users[1].email, state: 'expired' });
  return {
    keys,
    aws: { email: ids.users[0].email, name: 'Bedrock client', description: 'SigV4 credential for the Bedrock-compatible client' },
    quotaProfile: { name: 'Standard team', description: 'Default limits for the developer team', requestsPerMinute: 60, spendPerDay: 5, assignTo: ids.users[0].email },
    // Patterns follow the admin's syntax: function:name, hosted:type[/name] or mcp:server[/tool].
    toolPolicy: { name: 'Default developer policy', description: 'Monitors tool use of the developer team', mode: 'monitor',
      allows: ['hosted:web_search', 'hosted:file_search', 'function:read_file'], denies: ['mcp:filesystem/delete'], assignTo: ids.users[1].email },
    // A selector, not an id: the seed resolves the model from the Model Library (prefer, else the first match).
    price: { contains: 'image', prefer: 'gemini-3.1-flash-image', inputCost: 0.0005, outputCost: 0.0015, imageOutputCost: 0.03 },
    // The pool is one shared budget; the member profile is a per-member default, not a cap.
    team: { name: 'Platform team', description: 'Builds and runs the internal developer platform', spendPerMonth: 1000,
      memberProfile: { name: 'Team member default', description: 'Default limits for team members without their own', spendPerMonth: 200 },
      members: ids.users.map((u, i) => ({ email: u.email, role: i === 0 ? 'admin' : 'member' })), toolPolicy: 'Default developer policy' }
  };
}

/**
 * The subset of the desired state that does not exist yet. Keys and the credential match by name and
 * e-mail, profile and policy by name, the price by the model id the seed resolved (existing.priceModelId).
 */
export function diff(desired, existing) {
  const same = (a, b) => a.name === b.name && a.email === b.email;
  const named = (list, rec) => list.some((e) => e.name === rec.name);
  const priced = existing.prices.some((p) => p.model === existing.priceModelId);
  return {
    keys: desired.keys.filter((k) => !existing.keys.some((e) => same(e, k))),
    aws: (existing.aws ?? []).some((e) => same(e, desired.aws)) ? null : desired.aws,
    quotaProfile: named(existing.quotaProfiles, desired.quotaProfile) ? null : desired.quotaProfile,
    toolPolicy: named(existing.toolPolicies, desired.toolPolicy) ? null : desired.toolPolicy,
    price: priced ? null : { ...desired.price, modelId: existing.priceModelId },
    team: (existing.teams ?? []).some((t) => t.name === desired.team.name) ? null : desired.team
  };
}
