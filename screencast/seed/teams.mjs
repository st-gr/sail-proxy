// The demo team (video 05): a draft-enabled Teams row with a pool limit and the developer policy, its member
// profile in the 'member' slot, and the members added through the bound action (the first one as team admin).
import { must } from './access.mjs';

export async function seedTeam(client, team, log) {
  if (!team) return {};
  const { memberProfile, members, toolPolicy, ...fields } = team;
  const named = async (set, name, filter = '') => (must(await client.entity(set, `?$select=ID,name&$filter=name eq '${name}'${filter}`), set).value ?? [])[0]?.ID;
  const memberProfileId = (await named('QuotaProfiles', memberProfile.name))
    ?? must(await client.post('/odata/v4/admin/QuotaProfiles', memberProfile), 'QuotaProfiles member profile').ID;
  const toolPolicyId = await named('ToolPolicies', toolPolicy, ' and IsActiveEntity eq true');
  if (!toolPolicyId) throw new Error(`team: no active tool policy named ${toolPolicy}`);
  const id = must(await client.post('/odata/v4/admin/Teams', { ...fields, toolPolicy_ID: toolPolicyId }), 'Teams draft').ID;
  must(await client.boundAction(`Teams(ID=${id},IsActiveEntity=false)`, 'draftActivate', {}), 'Teams draftActivate');
  must(await client.action('assignTeamQuotaProfile', { teamId: id, profileId: memberProfileId, slot: 'member' }), 'assignTeamQuotaProfile');
  for (const m of members) must(await client.boundAction(`Teams(ID=${id},IsActiveEntity=true)`, 'addMember', m), `addMember ${m.role}`);
  log(`team ${fields.name} created with ${members.length} members`);
  return { teamId: id, memberProfileId };
}
