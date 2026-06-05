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
            Label: 'Name',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: email, 
            Label: 'Owner Email',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: userId, 
            Label: 'User ID',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: accessKeyId, 
            Label: 'Access Key ID',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: region, 
            Label: 'Region',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: isActive, 
            Label: 'Active',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: lastUsed, 
            Label: 'Last Used',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: usageCount, 
            Label: 'Usage Count',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: expiresAt, 
            Label: 'Expires',
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
        TypeName: 'AWS Credentials',
        TypeNamePlural: 'AWS Credentials', 
        Title: { Value: name },
        Description: { Value: email },
        ImageUrl: 'sap-icon://cloud'
    },
    
    // Simple header facets - status and region summary
    UI.HeaderFacets: [
        { 
            $Type: 'UI.ReferenceFacet', 
            Label: 'Status',
            Target: '@UI.FieldGroup#HeaderSummary' 
        }
    ],
    UI.FieldGroup#HeaderSummary: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: isActive, 
                Label: 'Active'
            },
            { 
                $Type: 'UI.DataField', 
                Value: region, 
                Label: 'AWS Region'
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: 'General Information',
            Target: '@UI.FieldGroup#General'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#AWS',
            Label: 'AWS Configuration'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Security', 
            Label: 'Security & Usage'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Metadata', 
            Label: 'Record Information'
        }
    ],
    
    // General Information
    UI.FieldGroup#General: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: name,
                Label: 'Credential Name'
            },
            { 
                $Type: 'UI.DataField', 
                Value: email,
                Label: 'Owner Email'
            },
            { 
                $Type: 'UI.DataField', 
                Value: userId,
                Label: 'User ID'
            },
            { 
                $Type: 'UI.DataField', 
                Value: description,
                Label: 'Description'
            },
            { 
                $Type: 'UI.DataField', 
                Value: isActive,
                Label: 'Active'
            }
        ]
    },
    
    // AWS Configuration Field Group
    UI.FieldGroup#AWS: {
        Data: [
            { 
                $Type: 'UI.DataField',
                Value: accessKeyId,
                Label: 'Access Key ID'
            },
            { 
                $Type: 'UI.DataField',
                Value: secretAccessKey,
                Label: 'Secret Access Key'
            },
            { 
                $Type: 'UI.DataField', 
                Value: region,
                Label: 'AWS Region'
            },
            { 
                $Type: 'UI.DataField', 
                Value: expiresAt,
                Label: 'Expires At'
            }
        ]
    },
    
    // Security & Usage Information Field Group
    UI.FieldGroup#Security: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: lastUsed,
                Label: 'Last Used'
            },
            { 
                $Type: 'UI.DataField', 
                Value: usageCount,
                Label: 'Usage Count'
            },
            { 
                $Type: 'UI.DataField', 
                Value: createdBy,
                Label: 'Created By'
            }
        ]
    },
    
    // Metadata Field Group  
    UI.FieldGroup#Metadata: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: createdAt,
                Label: 'Created At'
            },
            { 
                $Type: 'UI.DataField', 
                Value: modifiedAt,
                Label: 'Modified At' 
            },
            { 
                $Type: 'UI.DataField', 
                Value: modifiedBy,
                Label: 'Modified By'
            }
        ]
    },
    
    // Header actions - bound action for rotate (following API Keys pattern)
    UI.Identification: [
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.rotateAwsCredentials', 
            Label: 'Rotate Credentials'
        }
    ]
);

// ========================================
// Field-Level Annotations
// ========================================

annotate AdminService.AwsCredentials with {
    // Core Identity Fields
    name @(
        Common.Label: 'Credential Name',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false
    );
    
    // Owner Email - mandatory field for notifications and user access
    email @(
        Common.Label: 'Owner Email',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );
    
    // User Identity - legacy field, kept for compatibility
    userId @(
        Common.Label: 'User ID',
        UI.MultiLineText: false
    );
    
    // Description
    description @(
        Common.Label: 'Description',
        UI.MultiLineText: true
    );
    
    // AWS Access Key ID - visible but never editable after creation
    accessKeyId @(
        Core.Computed: true,
        Common.Label: 'Access Key ID',
        UI.MultiLineText: false
    );
    
    // AWS Secret Access Key - visible but never editable after creation
    secretAccessKey @(
        Core.Computed: true,
        Common.Label: 'Secret Access Key',
        UI.MultiLineText: false
    );
    
    // AWS Region Configuration
    region @(
        Common.Label: 'AWS Region',
        UI.MultiLineText: false
    );
    
    sapAiRegion @(
        Common.Label: 'SAP AI Region',
        UI.MultiLineText: false,
        UI.Hidden: true
    );
    
    // Expiration - mandatory field
    expiresAt @(
        Common.Label: 'Expires At',
        Common.FieldControl: #Mandatory
    );
    
    // Status - field control handled in TypeScript handlers
    isActive @(
        Common.Label: 'Active',
        UI.TextArrangement: #TextOnly
    );
    
    // System Metadata - all read-only
    createdAt @(
        Common.Label: 'Created At',
        Common.FieldControl: #ReadOnly
    );
    
    modifiedAt @(
        Common.Label: 'Last Modified',
        Common.FieldControl: #ReadOnly
    );
    
    createdBy @(
        Common.Label: 'Created By',
        Common.FieldControl: #ReadOnly
    );
    
    modifiedBy @(
        Common.Label: 'Modified By', 
        Common.FieldControl: #ReadOnly
    );
    
    lastUsed @(
        Common.Label: 'Last Used',
        Common.FieldControl: #ReadOnly
    );
    
    usageCount @(
        Common.Label: 'Total Usage',
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