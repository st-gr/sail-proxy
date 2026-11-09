// services/admin/app/teams-app/annotations.cds
using AdminService from '../../src/srv/admin-service';

// ========================================
// Teams - Fiori Elements V4 Annotations (spec 2026-10-14 §9)
// ========================================
annotate AdminService.Teams with @(
    UI.LineItem: [
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: '{i18n>users.resetQuota}', Inline: false },
        { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: description, Label: '{i18n>common.description}', ![@UI.Importance]: #Low },
        { $Type: 'UI.DataField', Value: memberCount, Label: '{i18n>teams.members}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: '{i18n>users.spendThisMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: '{i18n>users.spendLimitMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: '{i18n>users.tokensThisMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: '{i18n>users.tokenLimitMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}', ![@UI.Importance]: #Medium }
    ],
    UI.SelectionFields: [ name ],
    UI.PresentationVariant: { SortOrder: [ { Property: name, Descending: false } ], Visualizations: ['@UI.LineItem'] },
    UI.HeaderInfo: { TypeName: '{i18n>teams.team}', TypeNamePlural: '{i18n>teams.teams}', Title: { Value: name }, Description: { Value: description } },
    UI.HeaderFacets: [ { $Type: 'UI.ReferenceFacet', Label: '{i18n>teams.members}', Target: '@UI.FieldGroup#HeaderMembers' } ],
    UI.FieldGroup#HeaderMembers: { Data: [ { $Type: 'UI.DataField', Value: memberCount, Label: '{i18n>teams.members}' } ] },
    UI.Identification: [ { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: '{i18n>users.resetQuota}' } ],
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: '{i18n>teams.general}', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.CollectionFacet', ID: 'Pool', Label: '{i18n>teams.pool}', Facets: [
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.requests}', Target: '@UI.FieldGroup#PoolRequests' },
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.tokens}', Target: '@UI.FieldGroup#PoolTokens' },
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.spend}', Target: '@UI.FieldGroup#PoolSpend' }
        ] },
        { $Type: 'UI.ReferenceFacet', ID: 'Entitlement', Label: '{i18n>users.entitlement}', Target: '@UI.FieldGroup#Entitlement' },
        { $Type: 'UI.ReferenceFacet', ID: 'Usage', Label: '{i18n>users.usage}', Target: '@UI.FieldGroup#Usage' },
        { $Type: 'UI.ReferenceFacet', ID: 'Members', Label: '{i18n>teams.members}', Target: 'members/@UI.LineItem#ForTeam' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.record}', Target: '@UI.FieldGroup#Record' }
    ],
    UI.FieldGroup#General: { Data: [
        { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
        { $Type: 'UI.DataField', Value: description, Label: '{i18n>common.description}' }
    ] },
    UI.FieldGroup#PoolRequests: { Data: [
        { $Type: 'UI.DataField', Value: requestsPerMinute, Label: '{i18n>common.requestsPerMinute}' },
        { $Type: 'UI.DataField', Value: requestsPerMinuteDefaultText, Label: '{i18n>users.default}' }
    ] },
    UI.FieldGroup#PoolTokens: { Data: [
        { $Type: 'UI.DataField', Value: tokensPerDay, Label: '{i18n>users.tokensPerDay}' }, { $Type: 'UI.DataField', Value: tokensPerDayDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: tokensPerWeek, Label: '{i18n>users.tokensPerWeek}' }, { $Type: 'UI.DataField', Value: tokensPerWeekDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: tokensPerMonth, Label: '{i18n>users.tokensPerMonth}' }, { $Type: 'UI.DataField', Value: tokensPerMonthDefaultText, Label: '{i18n>users.default}' }
    ] },
    UI.FieldGroup#PoolSpend: { Data: [
        { $Type: 'UI.DataField', Value: spendPerDay, Label: '{i18n>users.spendPerDay}' }, { $Type: 'UI.DataField', Value: spendPerDayDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: spendPerWeek, Label: '{i18n>users.spendPerWeek}' }, { $Type: 'UI.DataField', Value: spendPerWeekDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: spendPerMonth, Label: '{i18n>users.spendPerMonth}' }, { $Type: 'UI.DataField', Value: spendPerMonthDefaultText, Label: '{i18n>users.default}' }
    ] },
    UI.FieldGroup#Entitlement: { Data: [
        { $Type: 'UI.DataField', Value: quotaProfile_ID, Label: '{i18n>teams.quotaProfile}' },
        { $Type: 'UI.DataField', Value: memberQuotaProfile_ID, Label: '{i18n>teams.memberQuotaProfile}' },
        { $Type: 'UI.DataField', Value: entitlementCatalog_ID, Label: '{i18n>users.entitlementCatalog}' },
        { $Type: 'UI.DataField', Value: toolPolicy_ID, Label: '{i18n>common.toolPolicy}' }
    ] },
    UI.DataPoint#SpendDay:    { Value: usedSpendDay,    TargetValue: effectiveSpendPerDay,    Criticality: criticalitySpendDay,    Title: '{i18n>users.spendToday}' },
    UI.DataPoint#SpendWeek:   { Value: usedSpendWeek,   TargetValue: effectiveSpendPerWeek,   Criticality: criticalitySpendWeek,   Title: '{i18n>users.spendThisWeek}' },
    UI.DataPoint#SpendMonth:  { Value: usedSpendMonth,  TargetValue: effectiveSpendPerMonth,  Criticality: criticalitySpendMonth,  Title: '{i18n>users.spendThisMonth}' },
    UI.DataPoint#TokensDay:   { Value: usedTokensDay,   TargetValue: effectiveTokensPerDay,   Criticality: criticalityTokensDay,   Title: '{i18n>users.tokensToday}' },
    UI.DataPoint#TokensWeek:  { Value: usedTokensWeek,  TargetValue: effectiveTokensPerWeek,  Criticality: criticalityTokensWeek,  Title: '{i18n>users.tokensThisWeek}' },
    UI.DataPoint#TokensMonth: { Value: usedTokensMonth, TargetValue: effectiveTokensPerMonth, Criticality: criticalityTokensMonth, Title: '{i18n>users.tokensThisMonth}' },
    UI.Chart#SpendDay:    { ChartType: #Bullet, Title: '{i18n>users.spendToday}',      Measures: [usedSpendDay],    MeasureAttributes: [{ Measure: usedSpendDay,    Role: #Axis1, DataPoint: '@UI.DataPoint#SpendDay' }] },
    UI.Chart#SpendWeek:   { ChartType: #Bullet, Title: '{i18n>users.spendThisWeek}',  Measures: [usedSpendWeek],   MeasureAttributes: [{ Measure: usedSpendWeek,   Role: #Axis1, DataPoint: '@UI.DataPoint#SpendWeek' }] },
    UI.Chart#SpendMonth:  { ChartType: #Bullet, Title: '{i18n>users.spendThisMonth}', Measures: [usedSpendMonth],  MeasureAttributes: [{ Measure: usedSpendMonth,  Role: #Axis1, DataPoint: '@UI.DataPoint#SpendMonth' }] },
    UI.Chart#TokensDay:   { ChartType: #Bullet, Title: '{i18n>users.tokensToday}',     Measures: [usedTokensDay],   MeasureAttributes: [{ Measure: usedTokensDay,   Role: #Axis1, DataPoint: '@UI.DataPoint#TokensDay' }] },
    UI.Chart#TokensWeek:  { ChartType: #Bullet, Title: '{i18n>users.tokensThisWeek}', Measures: [usedTokensWeek],  MeasureAttributes: [{ Measure: usedTokensWeek,  Role: #Axis1, DataPoint: '@UI.DataPoint#TokensWeek' }] },
    UI.Chart#TokensMonth: { ChartType: #Bullet, Title: '{i18n>users.tokensThisMonth}', Measures: [usedTokensMonth], MeasureAttributes: [{ Measure: usedTokensMonth, Role: #Axis1, DataPoint: '@UI.DataPoint#TokensMonth' }] },
    UI.FieldGroup#Usage: { Data: [
        { $Type: 'UI.DataField', Value: usedRequestsMinute, Label: '{i18n>users.requestsThisMinute}' },
        { $Type: 'UI.DataField', Value: effectiveRequestsPerMinute, Label: '{i18n>users.limitRequestsPerMinute}' },
        { $Type: 'UI.DataField', Value: usedSpendDay, Label: '{i18n>users.spendToday}' }, { $Type: 'UI.DataField', Value: effectiveSpendPerDay, Label: '{i18n>users.limitSpendPerDay}' },
        { $Type: 'UI.DataField', Value: usedSpendWeek, Label: '{i18n>users.spendThisWeek}' }, { $Type: 'UI.DataField', Value: effectiveSpendPerWeek, Label: '{i18n>users.limitSpendPerWeek}' },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: '{i18n>users.spendThisMonth}' }, { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: '{i18n>users.limitSpendPerMonth}' },
        { $Type: 'UI.DataField', Value: usedTokensDay, Label: '{i18n>users.tokensToday}' }, { $Type: 'UI.DataField', Value: effectiveTokensPerDay, Label: '{i18n>users.limitTokensPerDay}' },
        { $Type: 'UI.DataField', Value: usedTokensWeek, Label: '{i18n>users.tokensThisWeek}' }, { $Type: 'UI.DataField', Value: effectiveTokensPerWeek, Label: '{i18n>users.limitTokensPerWeek}' },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: '{i18n>users.tokensThisMonth}' }, { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: '{i18n>users.limitTokensPerMonth}' },
        { $Type: 'UI.DataField', Value: resetsAtDay, Label: '{i18n>users.dayResetsAt}' }, { $Type: 'UI.DataField', Value: resetsAtWeek, Label: '{i18n>users.weekResetsAt}' },
        { $Type: 'UI.DataField', Value: resetsAtMonth, Label: '{i18n>users.monthResetsAt}' }, { $Type: 'UI.DataField', Value: quotaResetAt, Label: '{i18n>users.quotaResetAt}' }
    ] },
    UI.FieldGroup#Record: { Data: [
        { $Type: 'UI.DataField', Value: createdAt, Label: '{i18n>common.createdAt}' }, { $Type: 'UI.DataField', Value: createdBy, Label: '{i18n>common.createdBy}' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}' }, { $Type: 'UI.DataField', Value: modifiedBy, Label: '{i18n>common.modifiedBy}' }
    ] }
);

// Team admins read their teams and manage members, nothing else (spec §7): Create and Delete
// follow the TeamPermissions singleton, Reset Quota the row's canResetQuota.
annotate AdminService.Teams with @(
    UI.CreateHidden: { $edmJson: { $Path: '/AdminService.EntityContainer/TeamPermissions/createHidden' } },
    UI.DeleteHidden: { $edmJson: { $Path: '/AdminService.EntityContainer/TeamPermissions/deleteHidden' } },
    UI.UpdateHidden: { $edmJson: { $Not: { $Path: 'canEdit' } } }
);

annotate AdminService.Teams with actions {
    resetQuota @(
        Core.OperationAvailable : canResetQuota,
        Common.SideEffects : { TargetProperties: ['quotaResetAt', 'usedTokensDay', 'usedTokensWeek', 'usedTokensMonth', 'usedSpendDay', 'usedSpendWeek', 'usedSpendMonth'] }
    );
};

annotate AdminService.Teams with {
    name @(Common.Label: '{i18n>common.name}', Common.FieldControl: #Mandatory);
    description @(Common.Label: '{i18n>common.description}');
    memberCount @(Common.Label: '{i18n>teams.members}', Common.FieldControl: #ReadOnly);
    quotaResetAt @(Common.Label: '{i18n>users.quotaResetAt}', Common.FieldControl: #ReadOnly);
    requestsPerMinute @(Common.Label: '{i18n>common.requestsPerMinute}', Common.QuickInfo: '{i18n>teams.poolRequestsPerMinuteInfo}');
    spendPerDay @(Common.Label: '{i18n>users.spendPerDay}', Common.QuickInfo: '{i18n>teams.poolSpendInfo}');
    spendPerWeek @(Common.Label: '{i18n>users.spendPerWeek}', Common.QuickInfo: '{i18n>teams.poolSpendInfo}');
    spendPerMonth @(Common.Label: '{i18n>users.spendPerMonth}', Common.QuickInfo: '{i18n>teams.poolSpendInfo}');
    tokensPerDay @(Common.Label: '{i18n>users.tokensPerDay}', Common.QuickInfo: '{i18n>teams.poolTokensInfo}');
    tokensPerWeek @(Common.Label: '{i18n>users.tokensPerWeek}', Common.QuickInfo: '{i18n>teams.poolTokensInfo}');
    tokensPerMonth @(Common.Label: '{i18n>users.tokensPerMonth}', Common.QuickInfo: '{i18n>teams.poolTokensInfo}');
    requestsPerMinuteDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    spendPerDayDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    spendPerWeekDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    spendPerMonthDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    tokensPerDayDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    tokensPerWeekDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    tokensPerMonthDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.poolDefaultInfo}');
    // The four associations are editable HERE (the Teams page is the one write path for a team's configuration): value helps over the admin entities.
    quotaProfile @(Common.Label: '{i18n>teams.quotaProfile}', Common.QuickInfo: '{i18n>teams.quotaProfileInfo}', Common.Text: quotaProfile.name, Common.TextArrangement: #TextOnly,
        Common.ValueList: { CollectionPath: 'QuotaProfiles', Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: quotaProfile_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'description' } ] });
    memberQuotaProfile @(Common.Label: '{i18n>teams.memberQuotaProfile}', Common.QuickInfo: '{i18n>teams.memberQuotaProfileInfo}', Common.Text: memberQuotaProfile.name, Common.TextArrangement: #TextOnly,
        Common.ValueList: { CollectionPath: 'QuotaProfiles', Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: memberQuotaProfile_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' } ] });
    entitlementCatalog @(Common.Label: '{i18n>users.entitlementCatalog}', Common.QuickInfo: '{i18n>teams.entitlementCatalogInfo}', Common.Text: entitlementCatalog.name, Common.TextArrangement: #TextOnly,
        Common.ValueList: { CollectionPath: 'ModelCatalogs', Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: entitlementCatalog_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ownerEmail' } ] });
    toolPolicy @(Common.Label: '{i18n>common.toolPolicy}', Common.QuickInfo: '{i18n>teams.toolPolicyInfo}', Common.Text: toolPolicy.name, Common.TextArrangement: #TextOnly,
        Common.ValueList: { CollectionPath: 'ToolPolicies', Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: toolPolicy_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'mode' } ] });
    usedRequestsMinute @(Common.Label: '{i18n>users.requestsThisMinute}', Common.FieldControl: #ReadOnly);
    sapCostCurrency @(Common.Label: '{i18n>common.currency}', Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerDayCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerWeekCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerMonthCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    usedSpendDay @(Measures.ISOCurrency: sapCostCurrency, Common.Label: '{i18n>users.spendToday}', Common.FieldControl: #ReadOnly);
    usedSpendWeek @(Measures.ISOCurrency: sapCostCurrency, Common.FieldControl: #ReadOnly);
    usedSpendMonth @(Measures.ISOCurrency: sapCostCurrency, Common.Label: '{i18n>users.spendThisMonth}', Common.FieldControl: #ReadOnly);
    usedTokensDay @(Common.Label: '{i18n>users.tokensToday}', Common.FieldControl: #ReadOnly);
    usedTokensWeek @(Common.FieldControl: #ReadOnly);
    usedTokensMonth @(Common.Label: '{i18n>users.tokensThisMonth}', Common.FieldControl: #ReadOnly);
    effectiveRequestsPerMinute @(Common.FieldControl: #ReadOnly);
    effectiveSpendPerDay @(Measures.ISOCurrency: effectiveSpendPerDayCurrency, Common.FieldControl: #ReadOnly);
    effectiveSpendPerWeek @(Measures.ISOCurrency: effectiveSpendPerWeekCurrency, Common.FieldControl: #ReadOnly);
    effectiveSpendPerMonth @(Measures.ISOCurrency: effectiveSpendPerMonthCurrency, Common.Label: '{i18n>users.spendLimitMonth}', Common.FieldControl: #ReadOnly);
    effectiveTokensPerDay @(Common.FieldControl: #ReadOnly);
    effectiveTokensPerWeek @(Common.FieldControl: #ReadOnly);
    effectiveTokensPerMonth @(Common.Label: '{i18n>users.tokenLimitMonth}', Common.FieldControl: #ReadOnly);
    resetsAtDay @(Common.FieldControl: #ReadOnly); resetsAtWeek @(Common.FieldControl: #ReadOnly); resetsAtMonth @(Common.FieldControl: #ReadOnly);
    canEdit @(UI.Hidden: true); canManageMembers @(UI.Hidden: true); canResetQuota @(UI.Hidden: true);
};

annotate AdminService.TeamMembers with @(
    UI.LineItem#ForTeam: [
        { $Type: 'UI.DataField', Value: email, Label: '{i18n>users.email}' },
        { $Type: 'UI.DataField', Value: user.displayName, Label: '{i18n>users.displayName}' },
        { $Type: 'UI.DataField', Value: role, Label: '{i18n>teams.role}' },
        { $Type: 'UI.DataField', Value: isPrimary, Label: '{i18n>teams.primary}' },
        { $Type: 'UI.DataField', Value: user.status, Label: '{i18n>common.status}' },
        { $Type: 'UI.DataField', Value: user.lastSeenAt, Label: '{i18n>common.lastSeen}' }
    ],
    UI.PresentationVariant#ForTeam: { SortOrder: [ { Property: email, Descending: false } ], Visualizations: ['@UI.LineItem#ForTeam'] }
);
annotate AdminService.TeamMembers with {
    email @(Common.Label: '{i18n>users.email}'); role @(Common.Label: '{i18n>teams.role}'); isPrimary @(Common.Label: '{i18n>teams.primary}');
};
// The member table of a team in edit mode reaches these through `user`, i.e. the ACTIVE user, which
// cannot be patched (501 on Save). Read-only on an active user, editable in the user's own draft
// (users-app) as before.
annotate AdminService.Users with {
    displayName @Common.FieldControl: { $edmJson: { $If: [ { $Path: 'IsActiveEntity' }, 1, 3 ] } };
    status @Common.FieldControl: { $edmJson: { $If: [ { $Path: 'IsActiveEntity' }, 1, 3 ] } };
};
