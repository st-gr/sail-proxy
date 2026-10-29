using AdminService from '../../src/srv/admin-service';

annotate AdminService.ToolPolicies with @(
    UI.HeaderInfo: { TypeName: '{i18n>common.toolPolicy}', TypeNamePlural: '{i18n>toolPolicies.toolPolicies}', Title: { Value: name }, Description: { Value: description } },
    UI.SelectionFields: [ mode ],
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
        { $Type: 'UI.DataField', Value: mode, Label: '{i18n>toolPolicies.mode}' },
        { $Type: 'UI.DataField', Value: isDefault, Label: '{i18n>toolPolicies.isDefault}' },
        { $Type: 'UI.DataField', Value: assignedUsers, Label: '{i18n>toolPolicies.assignedUsers}' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}' }
    ],
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: '{i18n>toolPolicies.general}', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Allows', Label: '{i18n>toolPolicies.allow}', Target: 'allows/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Denies', Label: '{i18n>toolPolicies.deny}', Target: 'denies/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Sensitive', Label: '{i18n>toolPolicies.sensitiveTools}', Target: 'sensitive/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Untrusted', Label: '{i18n>toolPolicies.untrustedSources}', Target: 'untrusted/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'AssignedUsers', Label: '{i18n>toolPolicies.assignedUsers}', Target: 'assignedUsersList/@UI.LineItem#ForPolicy' },
        { $Type: 'UI.ReferenceFacet', ID: 'AssignedKeys', Label: '{i18n>toolPolicies.assignedApiKeys}', Target: 'assignedKeys/@UI.LineItem#ForPolicy' },
        { $Type: 'UI.ReferenceFacet', ID: 'AssignedTeams', Label: '{i18n>toolPolicies.assignedTeams}', Target: 'assignedTeams/@UI.LineItem#ForPolicy' }
    ],
    UI.FieldGroup#General: { Data: [
        { $Type: 'UI.DataField', Value: name },
        { $Type: 'UI.DataField', Value: description },
        { $Type: 'UI.DataField', Value: mode },
        { $Type: 'UI.DataField', Value: isDefault }
    ] },
    // Assignment is not a creation, and it is not a deletion either: a user and an API key exist
    // independently of the policy, and the four bound actions below are the only way to point one
    // at a policy. Fiori Elements, though, offers Create and Delete on a table over an association
    // whenever the TARGET entity set permits them - Users carries
    // Capabilities.InsertRestrictions.Insertable: false and therefore showed nothing, while ApiKeys
    // does not and grew a Create button whose POST onto the draft's navigation could only fail with
    // "Active entities cannot be modified via draft request". A NavigationRestrictions record binds
    // the restriction to the navigation instead of the target, so the API Keys application keeps its
    // own Create and Delete.
    Capabilities.NavigationRestrictions: { RestrictedProperties: [
        {
            NavigationProperty: assignedUsersList,
            InsertRestrictions: { Insertable: false },
            DeleteRestrictions: { Deletable: false },
            UpdateRestrictions: { Updatable: false }
        },
        {
            NavigationProperty: assignedKeys,
            InsertRestrictions: { Insertable: false },
            DeleteRestrictions: { Deletable: false },
            UpdateRestrictions: { Updatable: false }
        },
        // Teams are assigned on the Teams page, so the facet is read-only.
        {
            NavigationProperty: assignedTeams,
            InsertRestrictions: { Insertable: false },
            DeleteRestrictions: { Deletable: false },
            UpdateRestrictions: { Updatable: false }
        }
    ] }
    // The four assignment actions are NOT listed in UI.Identification: a page-header button says
    // nothing about which of the two tables it changes, and its action-parameter dialog asks for an
    // email or a key id as free text. They sit in the toolbar of the table they act on instead,
    // registered in manifest.json and handled by ext/controller/AssignmentActions.js.
) {
    name @(Common.Label: '{i18n>common.name}');
    description @(Common.Label: '{i18n>common.description}');
    isDefault @(Common.Label: '{i18n>toolPolicies.isDefault}', Common.FieldControl: #ReadOnly, Common.QuickInfo: '{i18n>toolPolicies.isDefaultInfo}');
    mode @(Common.Label: '{i18n>toolPolicies.mode}', Common.QuickInfo: '{i18n>toolPolicies.modeInfo}',
        Common.ValueListWithFixedValues, Common.ValueList: { CollectionPath: 'ToolPolicyModes', Parameters: [ { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: mode, ValueListProperty: 'code' } ] });
    assignedUsers @(Common.Label: '{i18n>toolPolicies.assignedUsers}', Common.FieldControl: #ReadOnly);
};

annotate AdminService.ToolPolicyAllows with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: '{i18n>toolPolicies.pattern}' },
    { $Type: 'UI.DataField', Value: note, Label: '{i18n>toolPolicies.note}' }
]) { pattern @(
        Common.Label: '{i18n>toolPolicies.pattern}',
        Common.QuickInfo: '{i18n>toolPolicies.patternInfoAllow}',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: '{i18n>toolPolicies.recordedTools}',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: '{i18n>toolPolicies.note}'); };

annotate AdminService.ToolPolicyDenies with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: '{i18n>toolPolicies.pattern}' },
    { $Type: 'UI.DataField', Value: note, Label: '{i18n>toolPolicies.note}' }
]) { pattern @(
        Common.Label: '{i18n>toolPolicies.pattern}',
        Common.QuickInfo: '{i18n>toolPolicies.patternInfoDeny}',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: '{i18n>toolPolicies.recordedTools}',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: '{i18n>toolPolicies.note}'); };

annotate AdminService.ToolPolicySensitive with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: '{i18n>toolPolicies.pattern}' },
    { $Type: 'UI.DataField', Value: note, Label: '{i18n>toolPolicies.note}' }
]) { pattern @(
        Common.Label: '{i18n>toolPolicies.pattern}',
        Common.QuickInfo: '{i18n>toolPolicies.sensitiveInfo}',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: '{i18n>toolPolicies.recordedTools}',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: '{i18n>toolPolicies.note}'); };

annotate AdminService.ToolPolicyUntrusted with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: '{i18n>toolPolicies.pattern}' },
    { $Type: 'UI.DataField', Value: note, Label: '{i18n>toolPolicies.note}' }
]) { pattern @(
        Common.Label: '{i18n>toolPolicies.pattern}',
        Common.QuickInfo: '{i18n>toolPolicies.untrustedInfo}',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: '{i18n>toolPolicies.recordedTools}',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: '{i18n>toolPolicies.note}'); };

annotate AdminService.Users with @(UI.LineItem#ForPolicy: [
    { $Type: 'UI.DataField', Value: email, Label: '{i18n>toolPolicies.email}' },
    { $Type: 'UI.DataField', Value: displayName, Label: '{i18n>common.name}' },
    { $Type: 'UI.DataField', Value: status, Label: '{i18n>common.status}' }
]);
annotate AdminService.ApiKeys with @(UI.LineItem#ForPolicy: [
    { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.key}' },
    { $Type: 'UI.DataField', Value: email, Label: '{i18n>toolPolicies.owner}' },
    { $Type: 'UI.DataField', Value: isActive, Label: '{i18n>common.active}' }
]);
// An expand does not run the Teams after-READ, so no virtual columns here.
annotate AdminService.Teams with @(UI.LineItem#ForPolicy: [
    { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
    { $Type: 'UI.DataField', Value: description, Label: '{i18n>common.description}' }
]);

annotate AdminService.ToolInventory with @(
    UI.HeaderInfo: { TypeName: '{i18n>common.tool}', TypeNamePlural: '{i18n>toolPolicies.toolInventory}' },
    UI.SelectionFields: [ day, identity, facet, agents ],
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: identity, Label: '{i18n>common.tool}' },
        { $Type: 'UI.DataField', Value: facet, Label: '{i18n>common.facet}' },
        { $Type: 'UI.DataField', Value: agents, Label: '{i18n>toolPolicies.requestedBy}' },
        { $Type: 'UI.DataField', Value: users, Label: '{i18n>common.users}' },
        { $Type: 'UI.DataField', Value: requests, Label: '{i18n>common.requests}' },
        { $Type: 'UI.DataField', Value: allowed, Label: '{i18n>common.allowed}' },
        { $Type: 'UI.DataField', Value: monitored, Label: '{i18n>common.monitored}' },
        { $Type: 'UI.DataField', Value: stripped, Label: '{i18n>common.stripped}' },
        { $Type: 'UI.DataField', Value: rejected, Label: '{i18n>common.rejected}' },
        { $Type: 'UI.DataField', Value: unlisted, Label: '{i18n>common.unlisted}' },
        { $Type: 'UI.DataField', Value: detected, Label: '{i18n>toolPolicies.detected}' },
        { $Type: 'UI.DataField', Value: trustChained, Label: '{i18n>toolPolicies.trustChain}' },
        { $Type: 'UI.DataField', Value: lastSeen, Label: '{i18n>common.lastSeen}' }
    ]
) {
  day @(Common.Label: '{i18n>toolPolicies.period}', Common.QuickInfo: '{i18n>toolPolicies.periodInfo}');
  identity @(Common.Label: '{i18n>common.tool}', Common.QuickInfo: '{i18n>toolPolicies.toolFilterInfo}',
    Common.ValueList: {
      $Type: 'Common.ValueListType',
      CollectionPath: 'ToolIdentities',
      Label: '{i18n>toolPolicies.recordedTools}',
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: identity, ValueListProperty: 'identity' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
      ]
    });
  // One property carries the column AND its filter. A filter-only `agent` property beside it put a
  // second "Requested By" into the table's Group By dropdown, where only the column's entry grouped
  // anything - the filter-only one holds no value in any row.
  detected @(Common.Label: '{i18n>toolPolicies.detected}', Common.QuickInfo: '{i18n>toolPolicies.detectedInfo}');
  agents @(Common.Label: '{i18n>toolPolicies.requestedBy}',
    Common.QuickInfo: '{i18n>toolPolicies.requestedByInfo}',
    Common.ValueList: {
      $Type: 'Common.ValueListType',
      CollectionPath: 'ToolAgents',
      Label: '{i18n>toolPolicies.recordedClientPrograms}',
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: agents, ValueListProperty: 'agent' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'tools' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
      ]
    });
  facet @(
    Common.Label: '{i18n>common.facet}',
    Common.QuickInfo: '{i18n>toolPolicies.facetInfo}',
    Common.ValueListWithFixedValues,
    Common.ValueList: { CollectionPath: 'ToolFacets', Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: facet, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'text' }
    ] }
  );
};

annotate AdminService.ToolFacets with { code @(Common.Label: '{i18n>common.facet}'); text @(Common.Label: '{i18n>common.description}'); };

annotate AdminService.ToolPolicies actions {
    assignUser(email @(Common.Label: '{i18n>toolPolicies.userEmail}'));
    unassignUser(email @(Common.Label: '{i18n>toolPolicies.userEmail}'));
    assignApiKey(keyId @(Common.Label: '{i18n>toolPolicies.apiKey}', Common.ValueList: { CollectionPath: 'ApiKeys', Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: keyId, ValueListProperty: 'ID' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'email' }
    ] }));
    unassignApiKey(keyId @(Common.Label: '{i18n>toolPolicies.apiKey}'));
}

annotate AdminService.ToolIdentities with {
    identity @(Common.Label: '{i18n>common.tool}');
    users    @(Common.Label: '{i18n>common.users}');
    requests @(Common.Label: '{i18n>common.requests}');
    lastSeen @(Common.Label: '{i18n>common.lastSeen}');
};

annotate AdminService.ToolAgents with {
  agent    @(Common.Label: '{i18n>toolPolicies.requestedBy}');
  tools    @(Common.Label: '{i18n>toolPolicies.tools}');
  requests @(Common.Label: '{i18n>common.requests}');
  lastSeen @(Common.Label: '{i18n>common.lastSeen}');
};
