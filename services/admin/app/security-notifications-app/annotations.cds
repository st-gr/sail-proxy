using AdminService from '../../src/srv/admin-service';

// ========================================
// Security Notifications - Fiori Elements V4 Annotations
// ========================================

annotate AdminService.MySecurityNotifications with @(
    // Default sorting: pinned first, then by event date descending, with grouping
    UI.PresentationVariant: {
        SortOrder: [
            { Property: pinned, Descending: true },
            { Property: eventDate, Descending: true }
        ],
        GroupBy: [pinned],
        Visualizations: ['@UI.LineItem'],
        RequestAtLeast: [
            pinned,
            eventDate,
            isSnoozed
        ]
    },
    
    // Default filter: hide snoozed notifications (show only active ones)
    UI.SelectionVariant: {
        SelectOptions: [{
            PropertyName: isSnoozed,
            Ranges: [{
                Sign: #I,
                Option: #EQ,
                Low: false
            }]
        }]
    },
    
    // Fallback side effects for manual triggering if needed
    Common.SideEffects #ManualRefresh : {
        SourceEntities: ['/$Self'],
        TargetProperties: ['snoozeUntil', 'dismissedAt', 'seenAt', 'pinned', 'modifiedAt']
    },
    
    // List Report - show key notification information
    UI.LineItem: [
        // Data fields
        { 
            $Type: 'UI.DataField', 
            Value: title, 
            Label: 'Title',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: severity, 
            Label: 'Severity',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: eventType, 
            Label: 'Event Type',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: eventDate, 
            Label: 'Event Date',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: seenAt, 
            Label: 'Seen',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: pinned, 
            Label: 'Pinned',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: isSnoozed, 
            Label: 'Snoozed',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: dismissedAt, 
            Label: 'Dismissed',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: snoozeUntil, 
            Label: 'Snoozed Until',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: createdAt, 
            Label: 'Created',
            ![@UI.Importance]: #Medium
        }
    ],
    
    // Selection Fields for Filtering
    UI.SelectionFields: [
        severity,
        eventType,
        eventDate,
        seenAt,
        dismissedAt,
        pinned,
        isSnoozed
    ],

    // Header actions (bound actions)
    UI.Identification: [
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.markNotificationSeen', 
            Label: 'Mark as Seen'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.markNotificationUnseen', 
            Label: 'Mark as Unseen'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.dismissNotification', 
            Label: 'Dismiss'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.snoozeNotification', 
            Label: 'Snooze'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.pinNotification', 
            Label: 'Pin'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.unpinNotification', 
            Label: 'Unpin'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.deleteSecurityNotification', 
            Label: 'Delete',
            Inline: false
        }
    ]
);

// Object Page - full notification information
annotate AdminService.MySecurityNotifications with @(
    // Header Information
    UI.HeaderInfo: {
        TypeName: 'Security Notification',
        TypeNamePlural: 'Security Notifications', 
        Title: { Value: title },
        Description: { Value: eventType },
        ImageUrl: icon
    },
    
    // Header facets - status and key information
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
                Value: severity, 
                Label: 'Severity'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventDate, 
                Label: 'Event Date'
            },
            { 
                $Type: 'UI.DataField', 
                Value: type, 
                Label: 'Type'
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: 'Notification Details',
            Target: '@UI.FieldGroup#Details'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#UserState',
            Label: 'User State'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#ActionInfo', 
            Label: 'Action Information'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Metadata', 
            Label: 'Record Information'
        }
    ],
    
    // Notification Details
    UI.FieldGroup#Details: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: title,
                Label: 'Title'
            },
            { 
                $Type: 'UI.DataField', 
                Value: message,
                Label: 'Message'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventType,
                Label: 'Event Type'
            },
            { 
                $Type: 'UI.DataField', 
                Value: severity,
                Label: 'Severity'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventDate,
                Label: 'Event Date'
            },
            { 
                $Type: 'UI.DataField', 
                Value: ownerEmail,
                Label: 'Owner Email'
            }
        ]
    },
    
    // User State Field Group
    UI.FieldGroup#UserState: {
        Data: [
            { 
                $Type: 'UI.DataField',
                Value: seenAt,
                Label: 'Seen At'
            },
            { 
                $Type: 'UI.DataField',
                Value: dismissedAt,
                Label: 'Dismissed At'
            },
            { 
                $Type: 'UI.DataField', 
                Value: snoozeUntil,
                Label: 'Snooze Until'
            },
            { 
                $Type: 'UI.DataField', 
                Value: pinned,
                Label: 'Pinned'
            }
        ]
    },
    
    // Action Information Field Group
    UI.FieldGroup#ActionInfo: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: actionable,
                Label: 'Actionable'
            },
            { 
                $Type: 'UI.DataField', 
                Value: actionText,
                Label: 'Action Text'
            },
            { 
                $Type: 'UI.DataField', 
                Value: actionUrl,
                Label: 'Action URL'
            }
        ]
    },
    
    // Metadata Field Group  
    UI.FieldGroup#Metadata: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: type,
                Label: 'Type'
            },
            { 
                $Type: 'UI.DataField', 
                Value: createdAt,
                Label: 'Created At'
            }
        ]
    }
);

// ========================================
// Field-Level Annotations
// ========================================

annotate AdminService.MySecurityNotifications with {
    // Core Identity Fields
    title @(
        Common.Label: 'Title',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    message @(
        Common.Label: 'Message',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: true
    );
    
    severity @(
        Common.Label: 'Severity',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    eventType @(
        Common.Label: 'Event Type',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    eventDate @(
        Common.Label: 'Event Date',
        Common.FieldControl: #ReadOnly
    );
    
    ownerEmail @(
        Common.Label: 'Owner Email',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );
    
    type @(
        Common.Label: 'Type',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    // User State Fields
    seenAt @(
        Common.Label: 'Seen At',
        Common.FieldControl: #ReadOnly
    );
    
    dismissedAt @(
        Common.Label: 'Dismissed At',
        Common.FieldControl: #ReadOnly
    );
    
    snoozeUntil @(
        Common.Label: 'Snooze Until',
        Common.FieldControl: #ReadOnly
    );
    
    pinned @(
        Common.Label: 'Pinned',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    isSnoozed @(
        Common.Label: 'Snoozed',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    // Action Information
    actionable @(
        Common.Label: 'Actionable',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    actionText @(
        Common.Label: 'Action Text',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    actionUrl @(
        Common.Label: 'Action URL',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false,
        UI.IsURL: true
    );
    
    icon @(
        Common.Label: 'Icon',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    // System Metadata - all read-only
    createdAt @(
        Common.Label: 'Created At',
        Common.FieldControl: #ReadOnly
    );
};