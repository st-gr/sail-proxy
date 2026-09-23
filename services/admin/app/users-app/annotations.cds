using AdminService from '../../src/srv/admin-service';

// ========================================
// Users & Quotas - Fiori Elements V4 Annotations (spec §5)
// ========================================

annotate AdminService.Users with @(
    UI.LineItem: [
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.deactivate', Label: 'Deactivate', Inline: false },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.reactivate', Label: 'Reactivate', Inline: false },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: 'Reset Quota', Inline: false },
        { $Type: 'UI.DataField', Value: email, Label: 'E-Mail', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: displayName, Label: 'Display Name', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: status, Label: 'Status', ![@UI.Importance]: #High, Criticality: statusCriticality },
        { $Type: 'UI.DataField', Value: rolesSnapshot, Label: 'Roles', ![@UI.Importance]: #Low },
        { $Type: 'UI.DataField', Value: usedRequestsMinute, Label: 'Requests This Minute', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: usedSpendDay, Label: 'Spend Today', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: 'Spend This Month', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: 'Spend Limit (Month)', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: 'Tokens This Month', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: 'Token Limit (Month)', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: 'Last Seen', ![@UI.Importance]: #High }
    ],
    UI.SelectionFields: [ status, email ],
    UI.PresentationVariant: {
        SortOrder: [ { Property: lastSeenAt, Descending: true } ],
        Visualizations: ['@UI.LineItem']
    },
    UI.HeaderInfo: {
        TypeName: 'User', TypeNamePlural: 'Users',
        Title: { Value: email }, Description: { Value: displayName }
    },
    UI.HeaderFacets: [
        { $Type: 'UI.ReferenceFacet', Label: 'Status', Target: '@UI.FieldGroup#HeaderStatus' }
    ],
    UI.FieldGroup#HeaderStatus: { Data: [
        { $Type: 'UI.DataField', Value: status, Label: 'Status', Criticality: statusCriticality },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: 'Last Seen' }
    ] },
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.deactivate', Label: 'Deactivate' },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.reactivate', Label: 'Reactivate' },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.resetQuota', Label: 'Reset Quota' }
    ],
    UI.Facets: [
        // Seven limits in one flat list read as seven unrelated fields. They are three groups: how
        // often, how much, how expensive - and within tokens and spend the three windows belong
        // together, because they are checked against each other (day <= week <= month). One
        // CollectionFacet keeps them on the same "Constraints" section; each sub-group is its own
        // form container inside it.
        { $Type: 'UI.CollectionFacet', ID: 'Constraints', Label: 'Constraints', Facets: [
            { $Type: 'UI.ReferenceFacet', Label: 'Requests', Target: '@UI.FieldGroup#ConstraintsRequests' },
            { $Type: 'UI.ReferenceFacet', Label: 'Tokens', Target: '@UI.FieldGroup#ConstraintsTokens' },
            { $Type: 'UI.ReferenceFacet', Label: 'Spend', Target: '@UI.FieldGroup#ConstraintsSpend' }
        ] },
        { $Type: 'UI.ReferenceFacet', ID: 'Usage', Label: 'Usage', Target: '@UI.FieldGroup#Usage' },
        { $Type: 'UI.ReferenceFacet', Label: 'API Keys', Target: 'apiKeys/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: 'AWS Credentials', Target: 'awsCredentials/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: 'Entitlement', Target: '@UI.FieldGroup#Entitlement' },
        { $Type: 'UI.ReferenceFacet', ID: 'ToolsUsed', Label: 'Tools used', Target: 'toolUsageDaily/@UI.LineItem#ForUser' },
        { $Type: 'UI.ReferenceFacet', Label: 'Record', Target: '@UI.FieldGroup#Record' }
    ],
    UI.FieldGroup#ConstraintsRequests: { Data: [
        { $Type: 'UI.DataField', Value: requestsPerMinute, Label: 'Requests per Minute' },
        { $Type: 'UI.DataField', Value: requestsPerMinuteDefaultText, Label: 'Default' }
    ] },
    UI.FieldGroup#ConstraintsTokens: { Data: [
        { $Type: 'UI.DataField', Value: tokensPerDay, Label: 'Tokens per Day' },
        { $Type: 'UI.DataField', Value: tokensPerDayDefaultText, Label: 'Default' },
        { $Type: 'UI.DataField', Value: tokensPerWeek, Label: 'Tokens per Week' },
        { $Type: 'UI.DataField', Value: tokensPerWeekDefaultText, Label: 'Default' },
        { $Type: 'UI.DataField', Value: tokensPerMonth, Label: 'Tokens per Month' },
        { $Type: 'UI.DataField', Value: tokensPerMonthDefaultText, Label: 'Default' }
    ] },
    UI.FieldGroup#ConstraintsSpend: { Data: [
        { $Type: 'UI.DataField', Value: spendPerDay, Label: 'Spend per Day' },
        { $Type: 'UI.DataField', Value: spendPerDayDefaultText, Label: 'Default' },
        { $Type: 'UI.DataField', Value: spendPerWeek, Label: 'Spend per Week' },
        { $Type: 'UI.DataField', Value: spendPerWeekDefaultText, Label: 'Default' },
        { $Type: 'UI.DataField', Value: spendPerMonth, Label: 'Spend per Month' },
        { $Type: 'UI.DataField', Value: spendPerMonthDefaultText, Label: 'Default' }
    ] },
    // Bullet microcharts per budget window, rendered by the "Usage charts" custom section
    // (webapp/ext/fragment/UsageCharts.fragment.xml): used = bar, effective limit = target, colour
    // from the server-computed criticality (same 75/90 rule as the shell's quota card). They are
    // not field-group entries: Fiori Elements templates a UI.Chart only in a header facet or a
    // table column, so a DataFieldForAnnotation in a form renders nothing.
    UI.DataPoint#SpendDay:    { Value: usedSpendDay,    TargetValue: effectiveSpendPerDay,    Criticality: criticalitySpendDay,    Title: 'Spend Today' },
    UI.DataPoint#SpendWeek:   { Value: usedSpendWeek,   TargetValue: effectiveSpendPerWeek,   Criticality: criticalitySpendWeek,   Title: 'Spend This Week' },
    UI.DataPoint#SpendMonth:  { Value: usedSpendMonth,  TargetValue: effectiveSpendPerMonth,  Criticality: criticalitySpendMonth,  Title: 'Spend This Month' },
    UI.DataPoint#TokensDay:   { Value: usedTokensDay,   TargetValue: effectiveTokensPerDay,   Criticality: criticalityTokensDay,   Title: 'Tokens Today' },
    UI.DataPoint#TokensWeek:  { Value: usedTokensWeek,  TargetValue: effectiveTokensPerWeek,  Criticality: criticalityTokensWeek,  Title: 'Tokens This Week' },
    UI.DataPoint#TokensMonth: { Value: usedTokensMonth, TargetValue: effectiveTokensPerMonth, Criticality: criticalityTokensMonth, Title: 'Tokens This Month' },
    UI.Chart#SpendDay:    { ChartType: #Bullet, Title: 'Spend Today',      Measures: [usedSpendDay],    MeasureAttributes: [{ Measure: usedSpendDay,    Role: #Axis1, DataPoint: '@UI.DataPoint#SpendDay' }] },
    UI.Chart#SpendWeek:   { ChartType: #Bullet, Title: 'Spend This Week',  Measures: [usedSpendWeek],   MeasureAttributes: [{ Measure: usedSpendWeek,   Role: #Axis1, DataPoint: '@UI.DataPoint#SpendWeek' }] },
    UI.Chart#SpendMonth:  { ChartType: #Bullet, Title: 'Spend This Month', Measures: [usedSpendMonth],  MeasureAttributes: [{ Measure: usedSpendMonth,  Role: #Axis1, DataPoint: '@UI.DataPoint#SpendMonth' }] },
    UI.Chart#TokensDay:   { ChartType: #Bullet, Title: 'Tokens Today',     Measures: [usedTokensDay],   MeasureAttributes: [{ Measure: usedTokensDay,   Role: #Axis1, DataPoint: '@UI.DataPoint#TokensDay' }] },
    UI.Chart#TokensWeek:  { ChartType: #Bullet, Title: 'Tokens This Week', Measures: [usedTokensWeek],  MeasureAttributes: [{ Measure: usedTokensWeek,  Role: #Axis1, DataPoint: '@UI.DataPoint#TokensWeek' }] },
    UI.Chart#TokensMonth: { ChartType: #Bullet, Title: 'Tokens This Month', Measures: [usedTokensMonth], MeasureAttributes: [{ Measure: usedTokensMonth, Role: #Axis1, DataPoint: '@UI.DataPoint#TokensMonth' }] },
    UI.FieldGroup#Usage: { Data: [
        { $Type: 'UI.DataField', Value: usedRequestsMinute, Label: 'Requests This Minute' },
        { $Type: 'UI.DataField', Value: effectiveRequestsPerMinute, Label: 'Limit (Requests per Minute)' },
        { $Type: 'UI.DataField', Value: usedSpendDay, Label: 'Spend Today' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerDay, Label: 'Limit (Spend per Day)' },
        { $Type: 'UI.DataField', Value: usedSpendWeek, Label: 'Spend This Week' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerWeek, Label: 'Limit (Spend per Week)' },
        { $Type: 'UI.DataField', Value: usedSpendMonth, Label: 'Spend This Month' },
        { $Type: 'UI.DataField', Value: effectiveSpendPerMonth, Label: 'Limit (Spend per Month)' },
        { $Type: 'UI.DataField', Value: usedTokensDay, Label: 'Tokens Today' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerDay, Label: 'Limit (Tokens per Day)' },
        { $Type: 'UI.DataField', Value: usedTokensWeek, Label: 'Tokens This Week' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerWeek, Label: 'Limit (Tokens per Week)' },
        { $Type: 'UI.DataField', Value: usedTokensMonth, Label: 'Tokens This Month' },
        { $Type: 'UI.DataField', Value: effectiveTokensPerMonth, Label: 'Limit (Tokens per Month)' },
        { $Type: 'UI.DataField', Value: resetsAtDay, Label: 'Day Resets At' },
        { $Type: 'UI.DataField', Value: resetsAtWeek, Label: 'Week Resets At' },
        { $Type: 'UI.DataField', Value: resetsAtMonth, Label: 'Month Resets At' },
        { $Type: 'UI.DataField', Value: quotaResetAt, Label: 'Quota Reset At' }
    ] },
    UI.FieldGroup#Entitlement: { Data: [
        { $Type: 'UI.DataField', Value: quotaProfile_ID, Label: 'Quota Profile' },
        { $Type: 'UI.DataField', Value: entitlementCatalog_ID, Label: 'Entitlement Catalog' },
        { $Type: 'UI.DataField', Value: toolPolicy_ID, Label: 'Tool Policy' }
    ] },
    UI.FieldGroup#Record: { Data: [
        { $Type: 'UI.DataField', Value: firstSeenAt, Label: 'First Seen' },
        { $Type: 'UI.DataField', Value: lastSeenAt, Label: 'Last Seen' },
        { $Type: 'UI.DataField', Value: statusChangedAt, Label: 'Status Changed At' },
        { $Type: 'UI.DataField', Value: statusChangedBy, Label: 'Status Changed By' },
        { $Type: 'UI.DataField', Value: statusReason, Label: 'Status Reason' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified At' },
        { $Type: 'UI.DataField', Value: modifiedBy, Label: 'Modified By' }
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
    email @(Common.Label: 'E-Mail', Common.FieldControl: #ReadOnly, Communication.IsEmailAddress: true);
    displayName @(Common.Label: 'Display Name');
    status @(Common.Label: 'Status');
    rolesSnapshot @(Common.Label: 'Roles', Common.FieldControl: #ReadOnly);
    firstSeenAt @(Common.Label: 'First Seen', Common.FieldControl: #ReadOnly);
    lastSeenAt @(Common.Label: 'Last Seen', Common.FieldControl: #ReadOnly);
    statusChangedAt @(Common.FieldControl: #ReadOnly);
    statusChangedBy @(Common.FieldControl: #ReadOnly);
    statusReason @(Common.FieldControl: #ReadOnly);
    quotaResetAt @(Common.Label: 'Quota Reset At', Common.FieldControl: #ReadOnly);
    requestsPerMinute @(Common.Label: 'Requests per Minute', Common.QuickInfo: 'Empty = the assigned quota profile''s value, else the platform default; the effective value is shown under Usage.');
    // The editable limits stay plain decimals: a currency-typed input would need the currency to
    // parse what is typed, and an empty limit has none. The QuickInfo names the currency.
    spendPerDay @(Common.Label: 'Spend per Day', Common.QuickInfo: 'SAP cost per calendar day (UTC) in the currency of the SAP capacity unit price. Empty = the assigned quota profile''s value, else the platform default.');
    spendPerWeek @(Common.Label: 'Spend per Week', Common.QuickInfo: 'SAP cost per ISO week (Monday 00:00 UTC). Empty = the assigned quota profile''s value, else the platform default.');
    spendPerMonth @(Common.Label: 'Spend per Month', Common.QuickInfo: 'SAP cost per calendar month (UTC). Empty = the assigned quota profile''s value, else the platform default.');
    tokensPerDay @(Common.Label: 'Tokens per Day', Common.QuickInfo: 'Input, output and cache-write tokens per calendar day (UTC); cache reads are not counted. Empty = the assigned quota profile''s value, else the platform default.');
    tokensPerWeek @(Common.Label: 'Tokens per Week', Common.QuickInfo: 'Input, output and cache-write tokens per ISO week; cache reads are not counted. Empty = the assigned quota profile''s value, else the platform default.');
    tokensPerMonth @(Common.Label: 'Tokens per Month', Common.QuickInfo: 'Input, output and cache-write tokens per calendar month; cache reads are not counted. Empty = the assigned quota profile''s value, else the platform default.');
    requestsPerMinuteDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    spendPerDayDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    spendPerWeekDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    spendPerMonthDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    tokensPerDayDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    tokensPerWeekDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    tokensPerMonthDefaultText @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'What applies while the field above is empty, and where it comes from: the assigned quota profile or the platform default.');
    quotaProfile @(
        Common.Label: 'Quota Profile',
        Common.FieldControl: #ReadOnly,
        Common.Text: quotaProfile.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: 'The quota profile assigned in Entitlements & Quotas (Models > Entitlements & Quotas > Quota profiles > Assignments). Empty = the platform defaults apply.'
    );
    entitlementCatalog @(
        Common.Label: 'Entitlement Catalog',
        Common.FieldControl: #ReadOnly,
        Common.Text: entitlementCatalog.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: 'The catalog assigned in Entitlements & Quotas (Models > Entitlements & Quotas > Assignments). Empty = the default catalog.'
    );
    toolPolicy @(
        Common.Label: 'Tool Policy',
        Common.FieldControl: #ReadOnly,
        Common.Text: toolPolicy.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: 'The tool policy assigned in Tool Policies (Assign User). Empty = the default policy.'
    );
    usedRequestsMinute @(Common.Label: 'Requests This Minute', Common.FieldControl: #ReadOnly);
    // The currency of the spend figures and effective limits (the SAP capacity-unit price's
    // currency). Not fields of their own on the page: each shows beside the amount it measures,
    // and rounds it to the currency's decimals. The effective limits use a copy that is empty
    // when the limit is empty, so an unlimited window shows nothing rather than a bare "USD".
    sapCostCurrency @(Common.Label: 'Currency', Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerDayCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerWeekCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    effectiveSpendPerMonthCurrency @(Common.FieldControl: #ReadOnly, UI.Hidden: true);
    usedSpendDay @(Measures.ISOCurrency: sapCostCurrency, Common.Label: 'Spend Today', Common.FieldControl: #ReadOnly);
    usedSpendWeek @(Measures.ISOCurrency: sapCostCurrency, Common.FieldControl: #ReadOnly);
    usedSpendMonth @(Measures.ISOCurrency: sapCostCurrency, Common.Label: 'Spend This Month', Common.FieldControl: #ReadOnly);
    usedTokensDay @(Common.Label: 'Tokens Today', Common.FieldControl: #ReadOnly);
    usedTokensWeek @(Common.FieldControl: #ReadOnly);
    usedTokensMonth @(Common.Label: 'Tokens This Month', Common.FieldControl: #ReadOnly);
    effectiveRequestsPerMinute @(Common.FieldControl: #ReadOnly);
    effectiveSpendPerDay @(Measures.ISOCurrency: effectiveSpendPerDayCurrency, Common.FieldControl: #ReadOnly);
    effectiveSpendPerWeek @(Measures.ISOCurrency: effectiveSpendPerWeekCurrency, Common.FieldControl: #ReadOnly);
    effectiveSpendPerMonth @(Measures.ISOCurrency: effectiveSpendPerMonthCurrency, Common.Label: 'Spend Limit (Month)', Common.FieldControl: #ReadOnly);
    effectiveTokensPerDay @(Common.FieldControl: #ReadOnly);
    effectiveTokensPerWeek @(Common.FieldControl: #ReadOnly);
    effectiveTokensPerMonth @(Common.Label: 'Token Limit (Month)', Common.FieldControl: #ReadOnly);
    resetsAtDay @(Common.FieldControl: #ReadOnly);
    resetsAtWeek @(Common.FieldControl: #ReadOnly);
    resetsAtMonth @(Common.FieldControl: #ReadOnly);
};

// The two credential tables on the object page reuse the entities' own columns.
annotate AdminService.ApiKeys with @(UI.LineItem #ForUser: [
    { $Type: 'UI.DataField', Value: name, Label: 'Name' },
    { $Type: 'UI.DataField', Value: maskedKey, Label: 'Key' },
    { $Type: 'UI.DataField', Value: isActive, Label: 'Active' },
    { $Type: 'UI.DataField', Value: lockedByUserDeactivation, Label: 'Locked by Deactivation' },
    { $Type: 'UI.DataField', Value: expiresAt, Label: 'Expires At' },
    { $Type: 'UI.DataField', Value: lastUsed, Label: 'Last Used' }
]);
annotate AdminService.AwsCredentials with @(UI.LineItem #ForUser: [
    { $Type: 'UI.DataField', Value: name, Label: 'Name' },
    { $Type: 'UI.DataField', Value: accessKeyId, Label: 'Access Key ID' },
    { $Type: 'UI.DataField', Value: isActive, Label: 'Active' },
    { $Type: 'UI.DataField', Value: lockedByUserDeactivation, Label: 'Locked by Deactivation' },
    { $Type: 'UI.DataField', Value: expiresAt, Label: 'Expires At' },
    { $Type: 'UI.DataField', Value: lastUsed, Label: 'Last Used' }
]);

annotate AdminService.ToolUsageDaily with @(
    UI.LineItem#ForUser: [
        { $Type: 'UI.DataField', Value: day, Label: 'Day' },
        { $Type: 'UI.DataField', Value: identity, Label: 'Tool' },
        { $Type: 'UI.DataField', Value: facet, Label: 'Facet' },
        { $Type: 'UI.DataField', Value: requests, Label: 'Requests' },
        { $Type: 'UI.DataField', Value: allowed, Label: 'Allowed' },
        { $Type: 'UI.DataField', Value: monitored, Label: 'Monitored' },
        { $Type: 'UI.DataField', Value: stripped, Label: 'Stripped' },
        { $Type: 'UI.DataField', Value: rejected, Label: 'Rejected' },
        { $Type: 'UI.DataField', Value: unlisted, Label: 'Unlisted' }
    ],
    UI.PresentationVariant#ForUser: { SortOrder: [ { Property: day, Descending: true } ], Visualizations: ['@UI.LineItem#ForUser'] }
);
