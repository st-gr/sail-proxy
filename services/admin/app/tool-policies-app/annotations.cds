using AdminService from '../../src/srv/admin-service';

annotate AdminService.ToolPolicies with @(
    UI.HeaderInfo: { TypeName: 'Tool Policy', TypeNamePlural: 'Tool Policies', Title: { Value: name }, Description: { Value: description } },
    UI.SelectionFields: [ mode ],
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: name, Label: 'Name' },
        { $Type: 'UI.DataField', Value: mode, Label: 'Mode' },
        { $Type: 'UI.DataField', Value: isDefault, Label: 'Default' },
        { $Type: 'UI.DataField', Value: assignedUsers, Label: 'Assigned Users' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified At' }
    ],
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'General', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Allows', Label: 'Allow', Target: 'allows/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Denies', Label: 'Deny', Target: 'denies/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Sensitive', Label: 'Sensitive Tools', Target: 'sensitive/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Untrusted', Label: 'Untrusted Sources', Target: 'untrusted/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'AssignedUsers', Label: 'Assigned Users', Target: 'assignedUsersList/@UI.LineItem#ForPolicy' },
        { $Type: 'UI.ReferenceFacet', ID: 'AssignedKeys', Label: 'Assigned API Keys', Target: 'assignedKeys/@UI.LineItem#ForPolicy' }
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
        }
    ] }
    // The four assignment actions are NOT listed in UI.Identification: a page-header button says
    // nothing about which of the two tables it changes, and its action-parameter dialog asks for an
    // email or a key id as free text. They sit in the toolbar of the table they act on instead,
    // registered in manifest.json and handled by ext/controller/AssignmentActions.js.
) {
    name @(Common.Label: 'Name');
    description @(Common.Label: 'Description');
    isDefault @(Common.Label: 'Default', Common.FieldControl: #ReadOnly, Common.QuickInfo: 'The default policy applies to every user without an assignment. It cannot be deleted or unset.');
    mode @(Common.Label: 'Mode', Common.QuickInfo: 'monitor: record only. strip: remove tools the policy does not permit. reject: refuse the request.',
        Common.ValueListWithFixedValues, Common.ValueList: { CollectionPath: 'ToolPolicyModes', Parameters: [ { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: mode, ValueListProperty: 'code' } ] });
    assignedUsers @(Common.Label: 'Assigned Users', Common.FieldControl: #ReadOnly);
};

annotate AdminService.ToolPolicyAllows with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: 'Pattern' },
    { $Type: 'UI.DataField', Value: note, Label: 'Note' }
]) { pattern @(
        Common.Label: 'Pattern',
        Common.QuickInfo: 'function:<name>, hosted:<type>, mcp:<server> or mcp:<server>/<tool>; a trailing * matches a prefix. An mcp:<server>/<tool> entry limits only that server: its other tools are denied, every other tool is unaffected.',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: 'Recorded tools',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: 'Note'); };

annotate AdminService.ToolPolicyDenies with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: 'Pattern' },
    { $Type: 'UI.DataField', Value: note, Label: 'Note' }
]) { pattern @(
        Common.Label: 'Pattern',
        Common.QuickInfo: 'function:<name>, hosted:<type>, mcp:<server> or mcp:<server>/<tool>; a trailing * matches a prefix.',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: 'Recorded tools',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: 'Note'); };

annotate AdminService.ToolPolicySensitive with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: 'Pattern' },
    { $Type: 'UI.DataField', Value: note, Label: 'Note' }
]) { pattern @(
        Common.Label: 'Pattern',
        Common.QuickInfo: 'Tools that act (shell, file write, sending mail). They are withheld while the conversation contains output from an untrusted source. Same pattern syntax as Allow and Deny.',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: 'Recorded tools',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: 'Note'); };

annotate AdminService.ToolPolicyUntrusted with @(UI.LineItem: [
    { $Type: 'UI.DataField', Value: pattern, Label: 'Pattern' },
    { $Type: 'UI.DataField', Value: note, Label: 'Note' }
]) { pattern @(
        Common.Label: 'Pattern',
        Common.QuickInfo: 'Tools whose output may carry third-party content (web search, browsing). Their output in a conversation withholds the sensitive tools. Same pattern syntax as Allow and Deny.',
        Common.ValueList: {
            $Type: 'Common.ValueListType',
            CollectionPath: 'ToolIdentities',
            Label: 'Recorded tools',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: pattern, ValueListProperty: 'identity' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'users' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
            ]
        }
    ); note @(Common.Label: 'Note'); };

annotate AdminService.Users with @(UI.LineItem#ForPolicy: [
    { $Type: 'UI.DataField', Value: email, Label: 'Email' },
    { $Type: 'UI.DataField', Value: displayName, Label: 'Name' },
    { $Type: 'UI.DataField', Value: status, Label: 'Status' }
]);
annotate AdminService.ApiKeys with @(UI.LineItem#ForPolicy: [
    { $Type: 'UI.DataField', Value: name, Label: 'Key' },
    { $Type: 'UI.DataField', Value: email, Label: 'Owner' },
    { $Type: 'UI.DataField', Value: isActive, Label: 'Active' }
]);

annotate AdminService.ToolInventory with @(
    UI.HeaderInfo: { TypeName: 'Tool', TypeNamePlural: 'Tool Inventory' },
    UI.SelectionFields: [ day, identity, facet, agents ],
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: identity, Label: 'Tool' },
        { $Type: 'UI.DataField', Value: facet, Label: 'Facet' },
        { $Type: 'UI.DataField', Value: agents, Label: 'Requested By' },
        { $Type: 'UI.DataField', Value: users, Label: 'Users' },
        { $Type: 'UI.DataField', Value: requests, Label: 'Requests' },
        { $Type: 'UI.DataField', Value: allowed, Label: 'Allowed' },
        { $Type: 'UI.DataField', Value: monitored, Label: 'Monitored' },
        { $Type: 'UI.DataField', Value: stripped, Label: 'Stripped' },
        { $Type: 'UI.DataField', Value: rejected, Label: 'Rejected' },
        { $Type: 'UI.DataField', Value: unlisted, Label: 'Unlisted' },
        { $Type: 'UI.DataField', Value: detected, Label: 'Detected' },
        { $Type: 'UI.DataField', Value: trustChained, Label: 'Trust Chain' },
        { $Type: 'UI.DataField', Value: lastSeen, Label: 'Last Seen' }
    ]
) {
  day @(Common.Label: 'Period', Common.QuickInfo: 'The days whose recorded tool use is counted. Defaults to the last 30 days including today.');
  identity @(Common.Label: 'Tool', Common.QuickInfo: 'Filters by tool identity; a partial name matches (contains).',
    Common.ValueList: {
      $Type: 'Common.ValueListType',
      CollectionPath: 'ToolIdentities',
      Label: 'Recorded tools',
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
  detected @(Common.Label: 'Detected', Common.QuickInfo: 'Times the policy denied this tool and it was used anyway, inside the client''s own tool runtime: recorded, not prevented.');
  agents @(Common.Label: 'Requested By',
    Common.QuickInfo: 'The client programs that asked for this tool in the selected period. A filter matches any one of them.',
    Common.ValueList: {
      $Type: 'Common.ValueListType',
      CollectionPath: 'ToolAgents',
      Label: 'Recorded client programs',
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: agents, ValueListProperty: 'agent' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'tools' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'requests' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'lastSeen' }
      ]
    });
  facet @(
    Common.Label: 'Facet',
    Common.QuickInfo: 'Declared: the tool was offered in the request. Invoked: the model called it.',
    Common.ValueListWithFixedValues,
    Common.ValueList: { CollectionPath: 'ToolFacets', Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: facet, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'text' }
    ] }
  );
};

annotate AdminService.ToolFacets with { code @(Common.Label: 'Facet'); text @(Common.Label: 'Description'); };

annotate AdminService.ToolPolicies actions {
    assignUser(email @(Common.Label: 'User email'));
    unassignUser(email @(Common.Label: 'User email'));
    assignApiKey(keyId @(Common.Label: 'API key', Common.ValueList: { CollectionPath: 'ApiKeys', Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: keyId, ValueListProperty: 'ID' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'email' }
    ] }));
    unassignApiKey(keyId @(Common.Label: 'API key'));
}

annotate AdminService.ToolIdentities with {
    identity @(Common.Label: 'Tool');
    users    @(Common.Label: 'Users');
    requests @(Common.Label: 'Requests');
    lastSeen @(Common.Label: 'Last Seen');
};

annotate AdminService.ToolAgents with {
  agent    @(Common.Label: 'Requested By');
  tools    @(Common.Label: 'Tools');
  requests @(Common.Label: 'Requests');
  lastSeen @(Common.Label: 'Last Seen');
};
