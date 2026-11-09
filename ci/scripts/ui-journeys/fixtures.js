'use strict';

// Deterministic fixture names: seed.js creates them, journeys select rows by them,
// and the purge only ever touches rows whose name starts with `prefix`.
const prefix = 'UI Fixture — ';

module.exports = {
  prefix,
  names: {
    userActiveKey: prefix + 'user active key',
    userNeverExpiresKey: prefix + 'user never-expires key',
    adminKey: prefix + 'admin key',
    otherUserKey: prefix + 'other user key',
    userAwsCredential: prefix + 'user AWS credential',
    otherUserAwsCredential: prefix + 'other user AWS credential',
    // Model Library: teamCatalog is seeded and assigned to the user; userCatalog and
    // adminCatalog are the catalogs CatalogsJourney creates itself (the library purge drops
    // every non-default catalog before each run, so a journey always starts from "default only").
    teamCatalog: prefix + 'team catalog',
    userCatalog: prefix + 'user catalog',
    adminCatalog: prefix + 'admin catalog',
    exclusionReason: prefix + 'excluded for the journey',
    // Quota profiles: ProfilesJourney creates and deletes this one itself; the purge drops any a
    // failed run left behind. The three starter profiles are the product's own and stay.
    profile: prefix + 'quota profile',
    // Grounding: seed.js creates one store per role through /api/grounding and purges, per role,
    // every store it owns whose name starts with `prefix` and every file whose name starts with "ui-fixture-".
    groundingStore: prefix + 'store',
    groundingFile: 'ui-fixture-note.txt',
    // The admin's store shared with all users, holding one ingested file: the user role's journeys
    // find it read-only in their list and search it.
    groundingSharedStore: prefix + 'shared store',
    groundingSharedFile: 'ui-fixture-shared-handbook.txt',
    // The admin's own empty store that the admin journey shares and stops sharing. No other role has
    // a store of this name, so a share left behind by a failed run cannot be mistaken for another
    // role's store; the next seed's purge unshares and deletes it.
    groundingShareStore: prefix + 'admin share store',
    team: prefix + 'team',
    // Connections: the title of the seeded connection (its name must match ^[a-z][a-z0-9-]{1,30}$, so the prefix lives in the title)
    connection: prefix + 'connection',
    sapConnection: prefix + 'SAP AI Core connection'
  },
  // Mocked dev users (services/admin/package.json → cds.requires.auth.[development].users)
  users: { admin: 'admin@test.com', user: 'user@test.com', other: 'other@test.com' },
  // Quotas: the user fixture carries minimal limits so an accidental real request is refused
  // (spec §6), and the seed posts synthetic usage for it through processUsageEvents.
  quota: { tokensPerDay: 1000, spendPerDay: 0.01, seededTokens: 400, seededRequests: 2, profileName: 'Standard', keyRequestsPerMinute: 30 },
  // Teams: seed.js creates one team, adds the admin and `user` as team admins and `other` as a member, and sets a pool limit;
  // the Teams journeys (admin role) read it. The purge removes every team whose name starts with `prefix`.
  team: { tokensPerDay: 5000, memberEmail: 'other@test.com', leadEmail: 'user@test.com' },
  // Connections: seed.js creates one OpenAI connection (no credential) with one model, through the draft and addModel;
  // the purge removes every connection whose title starts with `prefix`. providerTypeText is the English text of
  // the type (services/admin/_i18n connections.providerType.openai) the list shows.
  connection: { name: 'uifix', providerType: 'openai', providerTypeText: 'OpenAI', model: 'gpt-4o-mini' },
  // Connections: seed.js also creates one SAP AI Core connection (non-productive) and stores this invented service
  // key on it, never tests or activates it. Its hosts are under .invalid (RFC 2606), so nothing can ever reach them;
  // region is what the parser takes from AI_API_URL.
  sapConnection: {
    name: 'uifix-sap', providerType: 'sap-ai-core', providerTypeText: 'SAP AI Core', productive: false, resourceGroup: 'default', region: 'prod.eu-central-1',
    serviceKey: {
      clientid: 'sb-ui-fixture!b1|aicore!b1', clientsecret: 'ui-fixture-not-a-secret',
      url: 'https://uifixture-zone.authentication.example.invalid', identityzone: 'uifixture-zone', identityzoneid: '00000000-0000-4000-8000-000000000001',
      serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.example.invalid' }
    }
  },
  // Security Notifications: one failed_auth event logged for the user's active key.
  securityEvent: { clientIP: '203.0.113.7', userAgent: 'ui-journeys/1.0', endpoint: '/v1/messages', requestId: prefix + 'request' }
};
