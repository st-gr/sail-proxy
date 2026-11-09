using AdminService from '../../src/srv/admin-service';

// ========================================
// API Keys - Fiori Elements V4 Annotations Following Blueprint
// ========================================

annotate AdminService.ApiKeys with @(
    // List Report - only show masked key for security
    UI.LineItem: [
        { 
            $Type: 'UI.DataField', 
            Value: name, 
            Label: '{i18n>common.name}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: email, 
            Label: '{i18n>apiKeys.userEmail}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: maskedKey, 
            Label: '{i18n>apiKeys.apiKey}',
            ![@UI.Importance]: #High
        },
        {
            $Type: 'UI.DataField',
            Value: isActive,
            Label: '{i18n>common.active}',
            ![@UI.Importance]: #High
        },
        {
            $Type: 'UI.DataField',
            Value: expiresAt,
            Label: '{i18n>common.expiresAt}',
            ![@UI.Importance]: #Medium
        },
        {
            $Type: 'UI.DataField',
            Value: neverExpires,
            Label: '{i18n>common.neverExpires}',
            ![@UI.Importance]: #Medium
        },
        {
            $Type: 'UI.DataField',
            Value: lastUsed,
            Label: '{i18n>common.lastUsed}',
            ![@UI.Importance]: #Low
        },
        {
            $Type: 'UI.DataField',
            Value: createdAt,
            Label: '{i18n>common.created}',
            ![@UI.Importance]: #Low
        }
    ],
    
    // Selection Fields for Filtering
    UI.SelectionFields: [
        name,
        email,
        isActive
    ]
);

// Object Page - full key in field groups, proper field control
annotate AdminService.ApiKeys with @(
    // Header Information
    UI.HeaderInfo: {
        TypeName: '{i18n>apiKeys.apiKey}',
        TypeNamePlural: '{i18n>common.apiKeys}', 
        Title: { Value: name },
        Description: { Value: email },
        ImageUrl: 'sap-icon://key'
    },
    
    // Simple header facets - only status chip, no field duplication
    UI.HeaderFacets: [
        { 
            $Type: 'UI.ReferenceFacet', 
            Label: '{i18n>common.status}',
            Target: '@UI.FieldGroup#HeaderSummary' 
        }
    ],
    UI.FieldGroup#HeaderSummary: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: isActive, 
                Label: '{i18n>common.active}'
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: '{i18n>apiKeys.keyInformation}',
            Target: '@UI.FieldGroup#General'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#Security',
            Label: '{i18n>apiKeys.usageDetails}'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Label: '{i18n>common.rateLimits}',
            Target: '@UI.FieldGroup#RateLimits'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Metadata', 
            Label: '{i18n>common.recordInformation}'
        }
    ],
    
    // General Information - clean UI.DataField entries (field control on properties)
    UI.FieldGroup#General: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: name,
                Label: '{i18n>apiKeys.keyName}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: email,
                Label: '{i18n>apiKeys.userEmail}'
            },
            {
                $Type: 'UI.DataField',
                Value: isActive,
                Label: '{i18n>common.active}'
            },
            {
                $Type: 'UI.DataField',
                Value: expiresAt,
                Label: '{i18n>common.expiresAt}',
                ![@UI.Importance]: #Medium
            },
            {
                $Type: 'UI.DataField',
                Value: neverExpires,
                Label: '{i18n>common.neverExpires}',
                ![@UI.Importance]: #Medium
            },
            {
                $Type: 'UI.DataField',
                Value: key,
                Label: '{i18n>apiKeys.apiKeyFull}'
            },
            { $Type: 'UI.DataField', Value: effectiveTeamName, Label: '{i18n>teams.effectiveTeam}' },
            { $Type: 'UI.DataField', Value: followsPrimaryTeam, Label: '{i18n>teams.followsPrimaryTeam}' }
        ]
    },
    
    // Security Information Field Group
    UI.FieldGroup#Security: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: lastUsed,
                Label: '{i18n>common.lastUsed}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: usageCount,
                Label: '{i18n>common.usageCount}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: createdBy,
                Label: '{i18n>common.createdBy}'
            }
        ]
    },

    // Rate Limits Field Group (spec §4) - read-only, changed only through setRateLimits
    UI.FieldGroup#RateLimits: { Data: [
        { $Type: 'UI.DataField', Value: requestsPerMinute, Label: '{i18n>common.requestsPerMinute}' },
        { $Type: 'UI.DataField', Value: requestsPerHour, Label: '{i18n>common.requestsPerHour}' },
        { $Type: 'UI.DataField', Value: requestsPerDay, Label: '{i18n>common.requestsPerDay}' },
        { $Type: 'UI.DataField', Value: ownerRequestsPerMinuteText, Label: '{i18n>common.ownerLimitPerMinute}' },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.setRateLimits', Label: '{i18n>common.setRateLimits}' }
    ] },
    
    // Metadata Field Group  
    UI.FieldGroup#Metadata: {
        Data: [
            {
                $Type: 'UI.DataField',
                Value: toolPolicy_ID,
                Label: '{i18n>common.toolPolicy}'
            },
            {
                $Type: 'UI.DataField',
                Value: createdAt,
                Label: '{i18n>common.createdAt}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: modifiedAt,
                Label: '{i18n>common.modifiedAt}' 
            },
            { 
                $Type: 'UI.DataField', 
                Value: modifiedBy,
                Label: '{i18n>common.modifiedBy}'
            }
        ]
    },
    
    // Header actions - bound action for rotate
    UI.Identification: [
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.rotateApiKey', 
            Label: '{i18n>apiKeys.rotateApiKey}'
        },
        {
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.setRateLimits',
            Label: '{i18n>common.setRateLimits}'
        }
    ]
);

// ========================================
// Field-Level Annotations
// ========================================

annotate AdminService.ApiKeys with {
    // Core Identity Fields
    name @(
        Common.Label: '{i18n>apiKeys.name}',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false
    );
    
    // User Identity (role-based editability) - field control handled in TypeScript handlers
    email @(
        Common.Label: '{i18n>apiKeys.userEmail}',
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );
    
    // API Key - full key - computed/immutable (read-only but visible)
    ![key] @(
        Core.Computed: true,
        Common.Label: '{i18n>apiKeys.apiKeyFull}',
        UI.MultiLineText: false
    );
    
    // Masked API Key - for List Report display (computed/read-only)
    maskedKey @(
        Core.Computed: true,
        Common.Label: '{i18n>apiKeys.apiKey}',
        UI.MultiLineText: false
    );
    
    // Status - field control handled in TypeScript handlers
    isActive @(
        Common.Label: '{i18n>common.active}',
        UI.TextArrangement: #TextOnly,
        Common.FieldControl: isActiveFC
    );

    expiresAt @(
        Common.Label: '{i18n>common.expiresAt}',
        Common.FieldControl: expiresAtFC
    );

    // Never expires - administrators only (FieldControl 1 renders the checkbox read-only
    // for everyone else). When set, the key ignores Expires At entirely.
    neverExpires @(
        Common.Label: '{i18n>common.neverExpires}',
        Common.FieldControl: neverExpiresFC
    );

    lockedByUserDeactivation @(Common.Label: '{i18n>common.lockedByDeactivation}', Common.FieldControl: #ReadOnly);

    // Per-credential rate limits (spec §4), enforced by the gateway alongside the user-level limit.
    requestsPerMinute @(Common.Label: '{i18n>common.requestsPerMinute}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerMinuteInfo}');
    requestsPerHour @(Common.Label: '{i18n>common.requestsPerHour}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerPeriodInfo}');
    requestsPerDay @(Common.Label: '{i18n>common.requestsPerDay}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerPeriodInfo}');
    effectiveTeamName @(Common.Label: '{i18n>teams.effectiveTeam}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.effectiveTeamInfo}');
    followsPrimaryTeam @(Common.Label: '{i18n>teams.followsPrimaryTeam}', Common.FieldControl: #ReadOnly);
    ownerRequestsPerMinuteText @(Common.Label: '{i18n>common.ownerLimitPerMinute}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>apiKeys.ownerLimitPerMinuteInfo}');

    toolPolicy @(
        Common.Label: '{i18n>common.toolPolicy}',
        Common.FieldControl: #ReadOnly,
        Common.Text: toolPolicy.name, Common.TextArrangement: #TextOnly,
        Common.QuickInfo: '{i18n>apiKeys.toolPolicyInfo}'
    );

    // System Metadata - all read-only
    createdAt @(
        Common.Label: '{i18n>common.createdAt}',
        Common.FieldControl: #ReadOnly
    );
    
    modifiedAt @(
        Common.Label: '{i18n>common.lastModified}',
        Common.FieldControl: #ReadOnly
    );
    
    createdBy @(
        Common.Label: '{i18n>common.createdBy}',
        Common.FieldControl: #ReadOnly
    );
    
    modifiedBy @(
        Common.Label: '{i18n>common.modifiedBy}', 
        Common.FieldControl: #ReadOnly
    );
    
    lastUsed @(
        Common.Label: '{i18n>common.lastUsed}',
        Common.FieldControl: #ReadOnly
    );
    
    usageCount @(
        Common.Label: '{i18n>common.totalUsage}',
        Common.FieldControl: #ReadOnly
    );
};


// ========================================
// Action Annotations
// ========================================

annotate AdminService.ApiKeys with actions {
    rotateApiKey @(
        Common.IsActionCritical: true,
        Common.SideEffects: {
            TargetProperties: ['key', 'maskedKey', 'modifiedAt', 'modifiedBy']
        }
    );
};

// ========================================
// Side Effects Annotations
// ========================================

annotate AdminService.ApiKeys with @(
    Common.SideEffects #NeverExpiresToggle: {
        SourceProperties: [neverExpires],
        TargetProperties: ['expiresAt', 'expiresAtFC']
    }
);