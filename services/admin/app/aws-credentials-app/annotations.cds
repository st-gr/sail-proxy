using AdminService from '../../src/srv/admin-service';

// ========================================
// AWS Credentials - Fiori Elements V4 Annotations Following Blueprint
// ========================================

annotate AdminService.AwsCredentials with @(
    // List Report - only show access key ID for security
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
            Label: '{i18n>common.ownerEmail}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: userId, 
            Label: '{i18n>awsCredentials.userId}',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: accessKeyId, 
            Label: '{i18n>common.accessKeyId}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: region, 
            Label: '{i18n>common.region}',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: isActive, 
            Label: '{i18n>common.active}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: lastUsed, 
            Label: '{i18n>common.lastUsed}',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: usageCount, 
            Label: '{i18n>common.usageCount}',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: expiresAt, 
            Label: '{i18n>awsCredentials.expires}',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: neverExpires, 
            Label: '{i18n>common.neverExpires}',
            ![@UI.Importance]: #Medium
        }
    ],
    
    // Selection Fields for Filtering
    UI.SelectionFields: [
        name,
        email,
        region,
        isActive
    ]
);

// Object Page - full credential information with proper field control
annotate AdminService.AwsCredentials with @(
    // Header Information
    UI.HeaderInfo: {
        TypeName: '{i18n>common.awsCredentials}',
        TypeNamePlural: '{i18n>common.awsCredentials}', 
        Title: { Value: name },
        Description: { Value: email },
        ImageUrl: 'sap-icon://cloud'
    },
    
    // Simple header facets - status and region summary
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
            },
            { 
                $Type: 'UI.DataField', 
                Value: region, 
                Label: '{i18n>awsCredentials.awsRegion}'
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: '{i18n>awsCredentials.generalInformation}',
            Target: '@UI.FieldGroup#General'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#AWS',
            Label: '{i18n>awsCredentials.awsConfiguration}'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Security', 
            Label: '{i18n>awsCredentials.securityUsage}'
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
    
    // General Information
    UI.FieldGroup#General: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: name,
                Label: '{i18n>awsCredentials.credentialName}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: email,
                Label: '{i18n>common.ownerEmail}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: userId,
                Label: '{i18n>awsCredentials.userId}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: description,
                Label: '{i18n>common.description}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: isActive,
                Label: '{i18n>common.active}'
            },
            { $Type: 'UI.DataField', Value: effectiveTeamName, Label: '{i18n>teams.effectiveTeam}' },
            { $Type: 'UI.DataField', Value: followsPrimaryTeam, Label: '{i18n>teams.followsPrimaryTeam}' }
        ]
    },
    
    // AWS Configuration Field Group
    UI.FieldGroup#AWS: {
        Data: [
            { 
                $Type: 'UI.DataField',
                Value: accessKeyId,
                Label: '{i18n>common.accessKeyId}'
            },
            { 
                $Type: 'UI.DataField',
                Value: secretAccessKey,
                Label: '{i18n>awsCredentials.secretAccessKey}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: region,
                Label: '{i18n>awsCredentials.awsRegion}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: expiresAt,
                Label: '{i18n>common.expiresAt}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: neverExpires,
                Label: '{i18n>common.neverExpires}'
            }
        ]
    },
    
    // Security & Usage Information Field Group
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
    
    // Header actions - bound action for rotate (following API Keys pattern)
    UI.Identification: [
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.rotateAwsCredentials', 
            Label: '{i18n>awsCredentials.rotateCredentials}'
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

annotate AdminService.AwsCredentials with {
    // Core Identity Fields
    name @(
        Common.Label: '{i18n>awsCredentials.credentialName}',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false
    );
    
    // Owner Email - mandatory field for notifications and user access
    email @(
        Common.Label: '{i18n>common.ownerEmail}',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );
    
    // User Identity - legacy field, kept for compatibility
    userId @(
        Common.Label: '{i18n>awsCredentials.userId}',
        UI.MultiLineText: false
    );
    
    effectiveTeamName @(Common.Label: '{i18n>teams.effectiveTeam}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>teams.effectiveTeamInfo}');
    followsPrimaryTeam @(Common.Label: '{i18n>teams.followsPrimaryTeam}', Common.FieldControl: #ReadOnly);

    // Description
    description @(
        Common.Label: '{i18n>common.description}',
        UI.MultiLineText: true
    );
    
    // AWS Access Key ID - visible but never editable after creation
    accessKeyId @(
        Core.Computed: true,
        Common.Label: '{i18n>common.accessKeyId}',
        UI.MultiLineText: false
    );
    
    // AWS Secret Access Key - visible but never editable after creation
    secretAccessKey @(
        Core.Computed: true,
        Common.Label: '{i18n>awsCredentials.secretAccessKey}',
        UI.MultiLineText: false
    );
    
    // AWS Region Configuration
    region @(
        Common.Label: '{i18n>awsCredentials.awsRegion}',
        UI.MultiLineText: false
    );
    
    sapAiRegion @(
        Common.Label: '{i18n>awsCredentials.sapAiRegion}',
        UI.MultiLineText: false,
        UI.Hidden: true
    );
    
    // Expiration - admin-only editable field
    expiresAt @(
        Common.Label: '{i18n>common.expiresAt}',
        Common.FieldControl: expiresAtFC
    );

    // Never expires - administrators only (FieldControl 1 renders the checkbox read-only
    // for everyone else). When set, the credential ignores Expires At entirely.
    neverExpires @(
        Common.Label: '{i18n>common.neverExpires}',
        Common.FieldControl: neverExpiresFC
    );

    lockedByUserDeactivation @(Common.Label: '{i18n>common.lockedByDeactivation}', Common.FieldControl: #ReadOnly);

    // Per-credential rate limits (spec §4), enforced by the gateway alongside the user-level limit.
    requestsPerMinute @(Common.Label: '{i18n>common.requestsPerMinute}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerMinuteInfo}');
    requestsPerHour @(Common.Label: '{i18n>common.requestsPerHour}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerPeriodInfo}');
    requestsPerDay @(Common.Label: '{i18n>common.requestsPerDay}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>common.requestsPerPeriodInfo}');
    ownerRequestsPerMinuteText @(Common.Label: '{i18n>common.ownerLimitPerMinute}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>awsCredentials.ownerLimitPerMinuteInfo}');

    // Status - field control handled in TypeScript handlers
    isActive @(
        Common.Label: '{i18n>common.active}',
        UI.TextArrangement: #TextOnly,
        Common.FieldControl: isActiveFC
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

annotate AdminService.AwsCredentials with actions {
    rotateAwsCredentials @(
        Common.IsActionCritical: true,
        Common.SideEffects: {
            TargetProperties: ['accessKeyId', 'secretAccessKey', 'modifiedAt', 'modifiedBy']
        }
    );
};

// ========================================
// Side Effects Annotations
// ========================================

annotate AdminService.AwsCredentials with @(
    Common.SideEffects #NeverExpiresToggle: {
        SourceProperties: [neverExpires],
        TargetProperties: ['expiresAt', 'expiresAtFC']
    }
);