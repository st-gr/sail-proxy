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
            Label: 'Name',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: email, 
            Label: 'User Email',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: maskedKey, 
            Label: 'API Key',
            ![@UI.Importance]: #High
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
            Value: createdAt, 
            Label: 'Created',
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
        TypeName: 'API Key',
        TypeNamePlural: 'API Keys', 
        Title: { Value: name },
        Description: { Value: email },
        ImageUrl: 'sap-icon://key'
    },
    
    // Simple header facets - only status chip, no field duplication
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
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: 'Key Information',
            Target: '@UI.FieldGroup#General'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#Security',
            Label: 'Usage Details'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Metadata', 
            Label: 'Record Information'
        }
    ],
    
    // General Information - clean UI.DataField entries (field control on properties)
    UI.FieldGroup#General: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: name,
                Label: 'Key Name'
            },
            { 
                $Type: 'UI.DataField', 
                Value: email,
                Label: 'User Email'
            },
            { 
                $Type: 'UI.DataField', 
                Value: isActive,
                Label: 'Active'
            },
            { 
                $Type: 'UI.DataField',
                Value: key,
                Label: 'API Key (Full)'
            }
        ]
    },
    
    // Security Information Field Group
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
    
    // Header actions - bound action for rotate
    UI.Identification: [
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.rotateApiKey', 
            Label: 'Rotate API Key'
        }
    ]
);

// ========================================
// Field-Level Annotations
// ========================================

annotate AdminService.ApiKeys with {
    // Core Identity Fields
    name @(
        Common.Label: 'API Key Name',
        Common.FieldControl: #Mandatory,
        UI.MultiLineText: false
    );
    
    // User Identity (role-based editability) - field control handled in TypeScript handlers
    email @(
        Common.Label: 'User Email',
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );
    
    // API Key - full key - computed/immutable (read-only but visible)
    ![key] @(
        Core.Computed: true,
        Common.Label: 'API Key (Full)',
        UI.MultiLineText: false
    );
    
    // Masked API Key - for List Report display (computed/read-only)
    maskedKey @(
        Core.Computed: true,
        Common.Label: 'API Key',
        UI.MultiLineText: false
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

annotate AdminService.ApiKeys with actions {
    rotateApiKey @(
        Common.IsActionCritical: true,
        Common.SideEffects: { 
            TargetProperties: ['key', 'maskedKey', 'modifiedAt', 'modifiedBy'] 
        }
    );
};