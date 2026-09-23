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
    profile: prefix + 'quota profile'
  },
  // Mocked dev users (services/admin/package.json → cds.requires.auth.[development].users)
  users: { admin: 'admin@test.com', user: 'user@test.com', other: 'other@test.com' },
  // Quotas: the user fixture carries minimal limits so an accidental real request is refused
  // (spec §6), and the seed posts synthetic usage for it through processUsageEvents.
  quota: { tokensPerDay: 1000, spendPerDay: 0.01, seededTokens: 400, seededRequests: 2, profileName: 'Standard', keyRequestsPerMinute: 30 },
  // Security Notifications: one failed_auth event logged for the user's active key.
  securityEvent: { clientIP: '203.0.113.7', userAgent: 'ui-journeys/1.0', endpoint: '/v1/messages', requestId: prefix + 'request' }
};
