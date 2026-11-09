'use strict';

// Single source of truth for role-dependent UI expectations.
// ci/scripts/ui-journeys/run.js injects the selected entry (without the password,
// plus email and fixture names) into each OPA page as ?role=<name>&expect=<base64url JSON>;
// the journeys only ever compare against that object. Adding coverage means
// editing this file (and, for a new kind of check, one journey).
module.exports = {
  admin: {
    credentials: 'admin@test.com:admin',
    isAdmin: true,
    shell: {
      visibleNav: ['Home', 'API Keys', 'AWS Credentials', 'Usage', 'Security Notifications',
        'Model Library', 'Entitlements & Quotas', 'Vector Stores', 'Files', 'Jobs', 'Administration', 'Configuration Management', 'SAP Capacity Unit Prices', 'Teams', 'Users & Quotas', 'Connections', 'Plugins'],
      hiddenNav: [],
      userRoleLabel: 'Admin user'
    },
    apiKeys: {
      seesOtherUsersRows: true,
      editable: { isActive: true, expiresAt: true, neverExpires: true },
      canCreate: true, canRotate: true, presetDays: 90
    },
    awsCredentials: {
      seesOtherUsersRows: true,
      editable: { isActive: true, expiresAt: true, neverExpires: true },
      canCreate: true, canRotate: true, presetDays: 90
    },
    library: {
      seesAllModels: true, canEditPrice: true, canDeploy: true, canManageDefault: true, canAssign: true
    },
    users: { canManage: true },
    teams: { canManage: true, inPopover: true },
    connections: { canManage: true },
    securityNotifications: { seesClientIp: true },
    quota: { cardVisible: true }
  },
  user: {
    credentials: 'user@test.com:user',
    isAdmin: false,
    shell: {
      visibleNav: ['Home', 'API Keys', 'AWS Credentials', 'Usage', 'Security Notifications',
        'Model Library', 'Entitlements & Quotas', 'Vector Stores', 'Files', 'Jobs', 'Configuration Management', 'Teams'],
      hiddenNav: ['Administration', 'SAP Capacity Unit Prices', 'Users & Quotas', 'Connections', 'Plugins'],
      userRoleLabel: 'User'
    },
    apiKeys: {
      seesOtherUsersRows: false,
      editable: { isActive: false, expiresAt: false, neverExpires: false },
      canCreate: true, canRotate: true, presetDays: 90
    },
    awsCredentials: {
      seesOtherUsersRows: false,
      editable: { isActive: false, expiresAt: false, neverExpires: false },
      canCreate: true, canRotate: true, presetDays: 90
    },
    library: {
      seesAllModels: false, canEditPrice: false, canDeploy: false, canManageDefault: false, canAssign: false
    },
    users: { canManage: false },
    teams: { canManage: false, inPopover: true },
    connections: { canManage: false },
    securityNotifications: { seesClientIp: true },
    quota: { cardVisible: true }
  }
};
