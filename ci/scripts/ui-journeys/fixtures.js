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
    otherUserAwsCredential: prefix + 'other user AWS credential'
  },
  // Mocked dev users (services/admin/package.json → cds.requires.auth.[development].users)
  users: { admin: 'admin@test.com', user: 'user@test.com', other: 'other@test.com' }
};
