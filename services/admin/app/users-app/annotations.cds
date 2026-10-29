using AdminService from '../../src/srv/admin-service';

// ========================================
// Users & Quotas - Fiori Elements V4 Annotations (spec §5)
// ========================================

annotate AdminService.Users with @(
    UI.LineItem: [
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.deactivate', Label: '{i18n>users.deactivate}', Inline: false },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.reactivate', Label: '{i18n>users.reactivate}', Inline: false },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: '{i18n>users.resetQuota}', Inline: false },
        { $Type: 'UI.DataField', Value: email, Label: '{i18n>users.email}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: displayName, Label: '{i18n>users.displayName}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: status, Label: '{i18n>common.status}', ![@UI.Importance]: #High, Criticality: statusCriticality },
        { $Type: 'UI.DataField', Value: rolesSnapshot, Label: '{i18n>users.roles}', ![@UI.Importance]: #Low },
        { $Type: 'UI.DataField', Value: usedRequestsMinute, Label: '{i18n>users.requestsThisMinute}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: usedSpendDay, Label: '{i18n>users.spendToday}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: '{i18n>users.spendThisMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: '{i18n>users.spendLimitMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: '{i18n>users.tokensThisMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: '{i18n>users.tokenLimitMonth}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: '{i18n>common.lastSeen}', ![@UI.Importance]: #High }
    ],
    UI.SelectionFields: [ status, email ],
    UI.PresentationVariant: {
        SortOrder: [ { Property: lastSeenAt, Descending: true } ],
        Visualizations: ['@UI.LineItem']
    },
    UI.HeaderInfo: {
        TypeName: '{i18n>users.user}', TypeNamePlural: '{i18n>common.users}',
        Title: { Value: email }, Description: { Value: displayName }
    },
    UI.HeaderFacets: [
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.status}', Target: '@UI.FieldGroup#HeaderStatus' }
    ],
    UI.FieldGroup#HeaderStatus: { Data: [
        { $Type: 'UI.DataField', Value: status, Label: '{i18n>common.status}', Criticality: statusCriticality },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: '{i18n>common.lastSeen}' }
    ] },
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.deactivate', Label: '{i18n>users.deactivate}' },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.reactivate', Label: '{i18n>users.reactivate}' },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: '{i18n>users.resetQuota}' }
    ],
    UI.Facets: [
        // Seven limits in one flat list read as seven unrelated fields. They are three groups: how
        // often, how much, how expensive - and within tokens and spend the three windows belong
        // together, because they are checked against each other (day <= week <= month). One
        // CollectionFacet keeps them on the same "Constraints" section; each sub-group is its own
        // form container inside it.
        { $Type: 'UI.CollectionFacet', ID: 'Constraints', Label: '{i18n>users.constraints}', Facets: [
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.requests}', Target: '@UI.FieldGroup#ConstraintsRequests' },
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.tokens}', Target: '@UI.FieldGroup#ConstraintsTokens' },
            { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.spend}', Target: '@UI.FieldGroup#ConstraintsSpend' }
        ] },
        { $Type: 'UI.ReferenceFacet', ID: 'Usage', Label: '{i18n>users.usage}', Target: '@UI.FieldGroup#Usage' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.apiKeys}', Target: 'apiKeys/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.awsCredentials}', Target: 'awsCredentials/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', ID: 'Teams', Label: '{i18n>teams.teams}', Target: 'memberships/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.entitlement}', Target: '@UI.FieldGroup#Entitlement' },
        { $Type: 'UI.ReferenceFacet', ID: 'ToolsUsed', Label: '{i18n>users.toolsUsed}', Target: 'toolUsageDaily/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>users.record}', Target: '@UI.FieldGroup#Record' }
    ],
    UI.FieldGroup#ConstraintsRequests: { Data: [
        { $Type: 'UI.DataField', Value: requestsPerMinute, Label: '{i18n>common.requestsPerMinute}' },
        { $Type: 'UI.DataField', Value: requestsPerMinuteDefaultText, Label: '{i18n>users.default}' }
    ] },
    UI.FieldGroup#ConstraintsTokens: { Data: [
        { $Type: 'UI.DataField', Value: tokensPerDay, Label: '{i18n>users.tokensPerDay}' },
        { $Type: 'UI.DataField', Value: tokensPerDayDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: tokensPerWeek, Label: '{i18n>users.tokensPerWeek}' },
        { $Type: 'UI.DataField', Value: tokensPerWeekDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: tokensPerMonth, Label: '{i18n>users.tokensPerMonth}' },
        { $Type: 'UI.DataField', Value: tokensPerMonthDefaultText, Label: '{i18n>users.default}' }
    ] },
    UI.FieldGroup#ConstraintsSpend: { Data: [
        { $Type: 'UI.DataField', Value: spendPerDay, Label: '{i18n>users.spendPerDay}' },
        { $Type: 'UI.DataField', Value: spendPerDayDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: spendPerWeek, Label: '{i18n>users.spendPerWeek}' },
        { $Type: 'UI.DataField', Value: spendPerWeekDefaultText, Label: '{i18n>users.default}' },
        { $Type: 'UI.DataField', Value: spendPerMonth, Label: '{i18n>users.spendPerMonth}' },
        { $Type: 'UI.DataField', Value: spendPerMonthDefaultText, Label: '{i18n>users.default}' }
    ] },
    // Bullet microcharts per budget window, rendered by the "Usage charts" custom section
    // (webapp/ext/fragment/UsageCharts.fragment.xml): used = bar, effective limit = target, colour
    // from the server-computed criticality (same 75/90 rule as the shell's quota card). They are
    // not field-group entries: Fiori Elements templates a UI.Chart only in a header facet or a
    // table column, so a DataFieldForAnnotation in a form renders nothing.
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
        { $Type: 'UI.DataField', Value: usedSpendDay, Label: '{i18n>users.spendToday}' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerDay, Label: '{i18n>users.limitSpendPerDay}' },
        { $Type: 'UI.DataField', Value: usedSpendWeek, Label: '{i18n>users.spendThisWeek}' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerWeek, Label: '{i18n>users.limitSpendPerWeek}' },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: '{i18n>users.spendThisMonth}' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: '{i18n>users.limitSpendPerMonth}' },
        { $Type: 'UI.DataField', Value: usedTokensDay, Label: '{i18n>users.tokensToday}' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerDay, Label: '{i18n>users.limitTokensPerDay}' },
        { $Type: 'UI.DataField', Value: usedTokensWeek, Label: '{i18n>users.tokensThisWeek}' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerWeek, Label: '{i18n>users.limitTokensPerWeek}' },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: '{i18n>users.tokensThisMonth}' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: '{i18n>users.limitTokensPerMonth}' },
        { $Type: 'UI.DataField', Value: resetsAtDay, Label: '{i18n>users.dayResetsAt}' },
        { $Type: 'UI.DataField', Value: resetsAtWeek, Label: '{i18n>users.weekResetsAt}' },
        { $Type: 'UI.DataField', Value: resetsAtMonth, Label: '{i18n>users.monthResetsAt}' },
        { $Type: 'UI.DataField', Value: quotaResetAt, Label: '{i18n>users.quotaResetAt}' }
    ] },
    UI.FieldGroup#Entitlement: { Data: [
        { $Type: 'UI.DataField', Value: quotaProfile_ID, Label: '{i18n>users.quotaProfile}' },
        { $Type: 'UI.DataField', Value: entitlementCatalog_ID, Label: '{i18n>users.entitlementCatalog}' },
        { $Type: 'UI.DataField', Value: toolPolicy_ID, Label: '{i18n>common.toolPolicy}' }
    ] },
    UI.FieldGroup#Record: { Data: [
        { $Type: 'UI.DataField', Value: firstSeenAt, Label: '{i18n>users.firstSeen}' },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: '{i18n>common.lastSeen}' },
        { $Type: 'UI.DataField', Value: statusChangedAt, Label: '{i18n>users.statusChangedAt}' },
        { $Type: 'UI.DataField', Value: statusChangedBy, Label: '{i18n>users.statusChangedBy}' },
        { $Type: 'UI.DataField', Value: statusReason, Label: '{i18n>users.statusReason}' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}' },
        { $Type: 'UI.DataField', Value: modifiedBy, Label: '{i18n>common.modifiedBy}' }
    ] }
);

annotate AdminService.Users with actions {
    deactivate @(
        Core.OperationAvailable : canDeactivate,
        Common.SideEffects : { TargetProperties: ['status', 'statusCriticality', 'canDeactivate', 'canReactivate', 'statusChangedAt', 'statusChangedBy', 'statusReason'], TargetEntities: [apiKeys, awsCredentials] }
    );
    reactivate @(
        Core.OperationAvailable : canReactivate,
        Common.SideEffects : { TargetProperties: ['status', 'statusCriticality', 'canDeactivate', 'canReactivate', 'statusChangedAt', 'statusChangedBy', 'statusReason'], TargetEntities: [apiKeys, awsCredentials] }
    );
    resetQuota @Common.SideEffects : { TargetProperties: ['quotaResetAt', 'usedTokensDay', 'usedTokensWeek', 'usedTokensMonth', 'usedSpendDay', 'usedSpendWeek', 'usedSpendMonth'] };
};

annotate AdminService.Users with {
    email @(Common.Label: '{i18n>users.email}', Common.FieldControl: #ReadOnly, Communication.IsEmailAddress: true);
    displayName @(Common.Label: '{i18n>users.displayName}');
    status @(Common.Label: '{i18n>common.status}');
    rolesSnapshot @(Common.Label: '{i18n>users.roles}', Common.FieldControl: #ReadOnly);
    firstSeenAt @(Common.Label: '{i18n>users.firstSeen}', Common.FieldControl: #ReadOnly);
    lastSeenAt @(Common.Label: '{i18n>common.lastSeen}', Common.FieldControl: #ReadOnly);
    statusChangedAt @(Common.FieldControl: #ReadOnly);
    statusChangedBy @(Common.FieldControl: #ReadOnly);
    statusReason @(Common.FieldControl: #ReadOnly);
    quotaResetAt @(Common.Label: '{i18n>users.quotaResetAt}', Common.FieldControl: #ReadOnly);
    requestsPerMinute @(Common.Label: '{i18n>common.requestsPerMinute}', Common.QuickInfo: '{i18n>users.requestsPerMinuteInfo}');
    // The editable limits stay plain decimals: a currency-typed input would need the currency to
    // parse what is typed, and an empty limit has none. The QuickInfo names the currency.
    spendPerDay @(Common.Label: '{i18n>users.spendPerDay}', Common.QuickInfo: '{i18n>users.spendPerDayInfo}');
    spendPerWeek @(Common.Label: '{i18n>users.spendPerWeek}', Common.QuickInfo: '{i18n>users.spendPerWeekInfo}');
    spendPerMonth @(Common.Label: '{i18n>users.spendPerMonth}', Common.QuickInfo: '{i18n>users.spendPerMonthInfo}');
    tokensPerDay @(Common.Label: '{i18n>users.tokensPerDay}', Common.QuickInfo: '{i18n>users.tokensPerDayInfo}');
    tokensPerWeek @(Common.Label: '{i18n>users.tokensPerWeek}', Common.QuickInfo: '{i18n>users.tokensPerWeekInfo}');
    tokensPerMonth @(Common.Label: '{i18n>users.tokensPerMonth}', Common.QuickInfo: '{i18n>users.tokensPerMonthInfo}');
    requestsPerMinuteDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    spendPerDayDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    spendPerWeekDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    spendPerMonthDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    tokensPerDayDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    tokensPerWeekDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    tokensPerMonthDefaultText @(Common.Label: '{i18n>users.default}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>users.defaultInfo}');
    quotaProfile @(
        Common.Label: '{i18n>users.quotaProfile}',
        Common.FieldControl: #ReadOnly,
        Common.Text: quotaProfile.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: '{i18n>users.quotaProfileInfo}'
    );
    entitlementCatalog @(
        Common.Label: '{i18n>users.entitlementCatalog}',
        Common.FieldControl: #ReadOnly,
        Common.Text: entitlementCatalog.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: '{i18n>users.entitlementCatalogInfo}'
    );
    toolPolicy @(
        Common.Label: '{i18n>common.toolPolicy}',
        Common.FieldControl: #ReadOnly,
        Common.Text: toolPolicy.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: '{i18n>users.toolPolicyInfo}'
    );
    usedRequestsMinute @(Common.Label: '{i18n>users.requestsThisMinute}', Common.FieldControl: #ReadOnly);
    // The currency of the spend figures and effective limits (the SAP capacity-unit price's
    // currency). Not fields of their own on the page: each shows beside the amount it measures,
    // and rounds it to the currency's decimals. The effective limits use a copy that is empty
    // when the limit is empty, so an unlimited window shows nothing rather than a bare "USD".
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
    resetsAtDay @(Common.FieldControl: #ReadOnly);
    resetsAtWeek @(Common.FieldControl: #ReadOnly);
    resetsAtMonth @(Common.FieldControl: #ReadOnly);
};

// The two credential tables on the object page reuse the entities' own columns.
annotate AdminService.ApiKeys with @(UI.LineItem #ForUser: [
    { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
    { $Type: 'UI.DataField', Value: maskedKey, Label: '{i18n>common.key}' },
    { $Type: 'UI.DataField', Value: isActive, Label: '{i18n>common.active}' },
    { $Type: 'UI.DataField', Value: lockedByUserDeactivation, Label: '{i18n>common.lockedByDeactivation}' },
    { $Type: 'UI.DataField', Value: expiresAt, Label: '{i18n>common.expiresAt}' },
    { $Type: 'UI.DataField', Value: lastUsed, Label: '{i18n>common.lastUsed}' }
]);
annotate AdminService.AwsCredentials with @(UI.LineItem #ForUser: [
    { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
    { $Type: 'UI.DataField', Value: accessKeyId, Label: '{i18n>common.accessKeyId}' },
    { $Type: 'UI.DataField', Value: isActive, Label: '{i18n>common.active}' },
    { $Type: 'UI.DataField', Value: lockedByUserDeactivation, Label: '{i18n>common.lockedByDeactivation}' },
    { $Type: 'UI.DataField', Value: expiresAt, Label: '{i18n>common.expiresAt}' },
    { $Type: 'UI.DataField', Value: lastUsed, Label: '{i18n>common.lastUsed}' }
]);

annotate AdminService.ToolUsageDaily with @(
    UI.LineItem#ForUser: [
        { $Type: 'UI.DataField', Value: day, Label: '{i18n>users.day}' },
        { $Type: 'UI.DataField', Value: identity, Label: '{i18n>common.tool}' },
        { $Type: 'UI.DataField', Value: facet, Label: '{i18n>common.facet}' },
        { $Type: 'UI.DataField', Value: requests, Label: '{i18n>common.requests}' },
        { $Type: 'UI.DataField', Value: allowed, Label: '{i18n>common.allowed}' },
        { $Type: 'UI.DataField', Value: monitored, Label: '{i18n>common.monitored}' },
        { $Type: 'UI.DataField', Value: stripped, Label: '{i18n>common.stripped}' },
        { $Type: 'UI.DataField', Value: rejected, Label: '{i18n>common.rejected}' },
        { $Type: 'UI.DataField', Value: unlisted, Label: '{i18n>common.unlisted}' }
    ],
    UI.PresentationVariant#ForUser: { SortOrder: [ { Property: day, Descending: true } ], Visualizations: ['@UI.LineItem#ForUser'] }
);

annotate AdminService.TeamMembers with @(UI.LineItem #ForUser: [
    { $Type: 'UI.DataField', Value: team.name, Label: '{i18n>teams.team}' },
    { $Type: 'UI.DataField', Value: role, Label: '{i18n>teams.role}' },
    { $Type: 'UI.DataField', Value: isPrimary, Label: '{i18n>teams.primary}' }
]);
