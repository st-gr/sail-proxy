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
        'Model Library', 'Entitlements & Quotas', 'Configuration Management', 'SAP Capacity Unit Prices', 'Users & Quotas'],
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
    securityNotifications: { seesClientIp: true },
    quota: { cardVisible: true }
  },
  user: {
    credentials: 'user@test.com:user',
    isAdmin: false,
    shell: {
      visibleNav: ['Home', 'API Keys', 'AWS Credentials', 'Usage', 'Security Notifications',
        'Model Library', 'Entitlements & Quotas', 'Configuration Management'],
      hiddenNav: ['SAP Capacity Unit Prices', 'Users & Quotas'],
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
    securityNotifications: { seesClientIp: true },
    quota: { cardVisible: true }
  }
};
