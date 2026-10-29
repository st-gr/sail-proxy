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
            Label: '{i18n>securityNotifications.title}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: severity, 
            Label: '{i18n>securityNotifications.severity}',
            ![@UI.Importance]: #High
        },
        {
            $Type: 'UI.DataField',
            Value: eventType,
            Label: '{i18n>securityNotifications.eventType}',
            ![@UI.Importance]: #High
        },
        {
            $Type: 'UI.DataField',
            Value: clientIP,
            Label: '{i18n>securityNotifications.clientIp}',
            ![@UI.Importance]: #High
        },
        {
            $Type: 'UI.DataField',
            Value: eventDate,
            Label: '{i18n>securityNotifications.eventDate}',
            ![@UI.Importance]: #High
        },
        { 
            $Type: 'UI.DataField', 
            Value: seenAt, 
            Label: '{i18n>securityNotifications.seen}',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: pinned, 
            Label: '{i18n>securityNotifications.pinned}',
            ![@UI.Importance]: #Medium
        },
        { 
            $Type: 'UI.DataField', 
            Value: isSnoozed, 
            Label: '{i18n>securityNotifications.snoozed}',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: dismissedAt, 
            Label: '{i18n>securityNotifications.dismissed}',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: snoozeUntil, 
            Label: '{i18n>securityNotifications.snoozedUntil}',
            ![@UI.Importance]: #Low
        },
        { 
            $Type: 'UI.DataField', 
            Value: createdAt, 
            Label: '{i18n>common.created}',
            ![@UI.Importance]: #Medium
        }
    ],
    
    // Selection Fields for Filtering
    UI.SelectionFields: [
        severity,
        eventType,
        clientIP,
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
            Label: '{i18n>securityNotifications.markAsSeen}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.markNotificationUnseen', 
            Label: '{i18n>securityNotifications.markAsUnseen}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.dismissNotification', 
            Label: '{i18n>securityNotifications.dismiss}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.snoozeNotification', 
            Label: '{i18n>securityNotifications.snooze}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.pinNotification', 
            Label: '{i18n>securityNotifications.pin}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.unpinNotification', 
            Label: '{i18n>securityNotifications.unpin}'
        },
        { 
            $Type: 'UI.DataFieldForAction',
            Action: 'AdminService.deleteSecurityNotification', 
            Label: '{i18n>securityNotifications.delete}',
            Inline: false
        }
    ]
);

// Object Page - full notification information
annotate AdminService.MySecurityNotifications with @(
    // Header Information
    UI.HeaderInfo: {
        TypeName: '{i18n>securityNotifications.securityNotification}',
        TypeNamePlural: '{i18n>securityNotifications.securityNotifications}', 
        Title: { Value: title },
        Description: { Value: eventType },
        ImageUrl: icon
    },
    
    // Header facets - status and key information
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
                Value: severity, 
                Label: '{i18n>securityNotifications.severity}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventDate, 
                Label: '{i18n>securityNotifications.eventDate}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: type, 
                Label: '{i18n>securityNotifications.type}'
            }
        ]
    },
    
    // Main content facets
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            Label: '{i18n>securityNotifications.notificationDetails}',
            Target: '@UI.FieldGroup#Details'
        },
        {
            $Type: 'UI.ReferenceFacet', 
            Target: '@UI.FieldGroup#UserState',
            Label: '{i18n>securityNotifications.userState}'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#ActionInfo', 
            Label: '{i18n>securityNotifications.actionInformation}'
        },
        {
            $Type: 'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Metadata', 
            Label: '{i18n>common.recordInformation}'
        }
    ],
    
    // Notification Details
    UI.FieldGroup#Details: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: title,
                Label: '{i18n>securityNotifications.title}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: message,
                Label: '{i18n>securityNotifications.message}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventType,
                Label: '{i18n>securityNotifications.eventType}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: severity,
                Label: '{i18n>securityNotifications.severity}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: eventDate,
                Label: '{i18n>securityNotifications.eventDate}'
            },
            {
                $Type: 'UI.DataField',
                Value: ownerEmail,
                Label: '{i18n>common.ownerEmail}'
            },
            {
                $Type: 'UI.DataField',
                Value: clientIP,
                Label: '{i18n>securityNotifications.clientIp}'
            },
            {
                $Type: 'UI.DataField',
                Value: userAgent,
                Label: '{i18n>securityNotifications.userAgent}'
            },
            {
                $Type: 'UI.DataField',
                Value: endpoint,
                Label: '{i18n>securityNotifications.endpoint}'
            },
            {
                $Type: 'UI.DataField',
                Value: requestId,
                Label: '{i18n>securityNotifications.requestId}'
            }
        ]
    },
    
    // User State Field Group
    UI.FieldGroup#UserState: {
        Data: [
            { 
                $Type: 'UI.DataField',
                Value: seenAt,
                Label: '{i18n>securityNotifications.seenAt}'
            },
            { 
                $Type: 'UI.DataField',
                Value: dismissedAt,
                Label: '{i18n>securityNotifications.dismissedAt}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: snoozeUntil,
                Label: '{i18n>securityNotifications.snoozeUntil}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: pinned,
                Label: '{i18n>securityNotifications.pinned}'
            }
        ]
    },
    
    // Action Information Field Group
    UI.FieldGroup#ActionInfo: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: actionable,
                Label: '{i18n>securityNotifications.actionable}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: actionText,
                Label: '{i18n>securityNotifications.actionText}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: actionUrl,
                Label: '{i18n>securityNotifications.actionUrl}'
            }
        ]
    },
    
    // Metadata Field Group  
    UI.FieldGroup#Metadata: {
        Data: [
            { 
                $Type: 'UI.DataField', 
                Value: type,
                Label: '{i18n>securityNotifications.type}'
            },
            { 
                $Type: 'UI.DataField', 
                Value: createdAt,
                Label: '{i18n>common.createdAt}'
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
        Common.Label: '{i18n>securityNotifications.title}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    message @(
        Common.Label: '{i18n>securityNotifications.message}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: true
    );
    
    severity @(
        Common.Label: '{i18n>securityNotifications.severity}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    eventType @(
        Common.Label: '{i18n>securityNotifications.eventType}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    eventDate @(
        Common.Label: '{i18n>securityNotifications.eventDate}',
        Common.FieldControl: #ReadOnly
    );
    
    ownerEmail @(
        Common.Label: '{i18n>common.ownerEmail}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false,
        Communication.IsEmailAddress: true
    );

    clientIP @(
        Common.Label: '{i18n>securityNotifications.clientIp}',
        Common.QuickInfo: '{i18n>securityNotifications.clientIpInfo}',
        Common.FieldControl: #ReadOnly
    );
    userAgent @(
        Common.Label: '{i18n>securityNotifications.userAgent}',
        Common.FieldControl: #ReadOnly
    );
    endpoint @(
        Common.Label: '{i18n>securityNotifications.endpoint}',
        Common.FieldControl: #ReadOnly
    );
    requestId @(
        Common.Label: '{i18n>securityNotifications.requestId}',
        Common.FieldControl: #ReadOnly
    );

    type @(
        Common.Label: '{i18n>securityNotifications.type}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    // User State Fields
    seenAt @(
        Common.Label: '{i18n>securityNotifications.seenAt}',
        Common.FieldControl: #ReadOnly
    );
    
    dismissedAt @(
        Common.Label: '{i18n>securityNotifications.dismissedAt}',
        Common.FieldControl: #ReadOnly
    );
    
    snoozeUntil @(
        Common.Label: '{i18n>securityNotifications.snoozeUntil}',
        Common.FieldControl: #ReadOnly
    );
    
    pinned @(
        Common.Label: '{i18n>securityNotifications.pinned}',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    isSnoozed @(
        Common.Label: '{i18n>securityNotifications.snoozed}',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    // Action Information
    actionable @(
        Common.Label: '{i18n>securityNotifications.actionable}',
        Common.FieldControl: #ReadOnly,
        UI.TextArrangement: #TextOnly
    );
    
    actionText @(
        Common.Label: '{i18n>securityNotifications.actionText}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    actionUrl @(
        Common.Label: '{i18n>securityNotifications.actionUrl}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false,
        UI.IsURL: true
    );
    
    icon @(
        Common.Label: '{i18n>securityNotifications.icon}',
        Common.FieldControl: #ReadOnly,
        UI.MultiLineText: false
    );
    
    // System Metadata - all read-only
    createdAt @(
        Common.Label: '{i18n>common.createdAt}',
        Common.FieldControl: #ReadOnly
    );
};