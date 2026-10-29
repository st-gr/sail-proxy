// services/admin/app/connections-app/annotations.cds
using AdminService from '../../src/srv/admin-service';

// ========================================
// Connections - Fiori Elements V4 Annotations (spec 2026-10-23 §7)
// The rules (validation per type, immutable name and type, publish needs a price) are the server's;
// these annotations only lay the fields out and hide the ones another provider type uses.
// ========================================
annotate AdminService.ProviderConnections with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: title, Label: '{i18n>connections.title}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: providerType, Label: '{i18n>connections.providerType}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: isActive, Label: '{i18n>common.active}', ![@UI.Importance]: #High },
        // The credential hint is a custom column (manifest CredentialColumn): it shows a dash when none is set.
        { $Type: 'UI.DataField', Value: lastTestResult, Label: '{i18n>connections.lastTestResult}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: publishedModels, Label: '{i18n>connections.publishedModels}', ![@UI.Importance]: #High }
    ],
    UI.SelectionFields: [ name, providerType ],
    UI.PresentationVariant: { SortOrder: [ { Property: name, Descending: false } ], Visualizations: ['@UI.LineItem'] },
    UI.HeaderInfo: {
        TypeName: '{i18n>connections.connection}', TypeNamePlural: '{i18n>connections.connections}',
        // The title, else the name (a connection needs no title)
        Title: { Value: { $edmJson: { $If: [ { $Ne: [ { $Path: 'title' }, { $Null: null } ] }, { $Path: 'title' }, { $Path: 'name' } ] } } },
        Description: { Value: providerTypeText }
    },
    // Test connection, Set credential and Add model are custom actions (manifest): the test shows a
    // translated text per reason code, which needs the action's result; clear credential is generic.
    // sap-ai-core: Set service key, Activate (with its own confirmation text) and Deactivate are custom too.
    UI.Identification: [
        // Hidden on the active SAP AI Core connection, whose credential the server keeps (409 connection_active)
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.clearCredential', Label: '{i18n>connections.clearCredential}',
            ![@UI.Hidden]: { $edmJson: { $And: [ { $Eq: [ { $Path: 'providerType' }, 'sap-ai-core' ] }, { $Path: 'isActive' } ] } } }
    ],
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'general', Label: '{i18n>connections.general}', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'endpoint', Label: '{i18n>connections.endpointAndAuth}', Target: '@UI.FieldGroup#Endpoint' },
        { $Type: 'UI.ReferenceFacet', ID: 'credential', Label: '{i18n>connections.credential}', Target: '@UI.FieldGroup#Credential' },
        { $Type: 'UI.ReferenceFacet', ID: 'status', Label: '{i18n>common.status}', Target: '@UI.FieldGroup#Status' },
        // SAP AI Core connections have no models of their own (the tenant's come through the Model Library)
        { $Type: 'UI.ReferenceFacet', ID: 'models', Label: '{i18n>connections.models}', Target: 'models/@UI.LineItem#ForConnection',
            ![@UI.Hidden]: { $edmJson: { $Eq: [ { $Path: 'providerType' }, 'sap-ai-core' ] } } },
        { $Type: 'UI.ReferenceFacet', ID: 'record', Label: '{i18n>common.recordInformation}', Target: '@UI.FieldGroup#Record' }
    ],
    UI.FieldGroup#General: { Data: [
        { $Type: 'UI.DataField', Value: name, Label: '{i18n>common.name}' },
        { $Type: 'UI.DataField', Value: title, Label: '{i18n>connections.title}' },
        { $Type: 'UI.DataField', Value: providerType, Label: '{i18n>connections.providerType}' },
        // sap-ai-core: set by the Activate and Deactivate actions only, so not offered while editing
        { $Type: 'UI.DataField', Value: isActive, Label: '{i18n>common.active}',
            ![@UI.Hidden]: { $edmJson: { $And: [ { $Eq: [ { $Path: 'providerType' }, 'sap-ai-core' ] }, { $Not: { $Path: 'IsActiveEntity' } } ] } } }
    ] },
    // Each field shows for its provider type only (UI.Hidden below).
    UI.FieldGroup#Endpoint: { Data: [
        { $Type: 'UI.DataField', Value: endpoint, Label: '{i18n>connections.endpoint}' },
        { $Type: 'UI.DataField', Value: apiMode, Label: '{i18n>connections.apiMode}' },
        { $Type: 'UI.DataField', Value: apiVersion, Label: '{i18n>connections.apiVersion}' },
        { $Type: 'UI.DataField', Value: region, Label: '{i18n>common.region}' },
        { $Type: 'UI.DataField', Value: runtimeEndpoint, Label: '{i18n>connections.runtimeEndpoint}' },
        { $Type: 'UI.DataField', Value: baseUrl, Label: '{i18n>connections.baseUrl}' },
        { $Type: 'UI.DataField', Value: organization, Label: '{i18n>connections.organization}' },
        { $Type: 'UI.DataField', Value: project, Label: '{i18n>connections.project}' },
        { $Type: 'UI.DataField', Value: anthropicVersion, Label: '{i18n>connections.anthropicVersion}' },
        { $Type: 'UI.DataField', Value: authMode, Label: '{i18n>connections.authMode}' },
        { $Type: 'UI.DataField', Value: tenantId, Label: '{i18n>connections.tenantId}' },
        { $Type: 'UI.DataField', Value: clientId, Label: '{i18n>connections.clientId}' },
        { $Type: 'UI.DataField', Value: accessKeyId, Label: '{i18n>common.accessKeyId}' },
        { $Type: 'UI.DataField', Value: resourceGroup, Label: '{i18n>connections.resourceGroup}' },
        { $Type: 'UI.DataField', Value: productive, Label: '{i18n>connections.productive}' },
        { $Type: 'UI.DataField', Value: priceRegion, Label: '{i18n>connections.priceRegion}' }
    ] },
    UI.FieldGroup#Credential: { Data: [
        { $Type: 'UI.DataField', Value: credentialHint, Label: '{i18n>connections.credentialHint}' },
        { $Type: 'UI.DataField', Value: credentialUpdatedAt, Label: '{i18n>connections.credentialUpdatedAt}' }
    ] },
    UI.FieldGroup#Status: { Data: [
        { $Type: 'UI.DataField', Value: lastTestAt, Label: '{i18n>connections.lastTestAt}' },
        { $Type: 'UI.DataField', Value: lastTestResult, Label: '{i18n>connections.lastTestResult}' }
    ] },
    UI.FieldGroup#Record: { Data: [
        { $Type: 'UI.DataField', Value: createdAt, Label: '{i18n>common.createdAt}' }, { $Type: 'UI.DataField', Value: createdBy, Label: '{i18n>common.createdBy}' },
        { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}' }, { $Type: 'UI.DataField', Value: modifiedBy, Label: '{i18n>common.modifiedBy}' }
    ] }
);

// models is an association outside the draft: the object page neither creates, edits nor deletes rows
// in it, also while the connection is edited (Add model, Set price and Remove are actions). UI-only on
// purpose: Capabilities.NavigationRestrictions is enforced by cds and would refuse the scripted
// POST ProviderConnections(...)/models, and Common.FieldControl #ReadOnly drops the fields from writes.
annotate AdminService.ConnectionModels with @(
    UI.CreateHidden: true,
    UI.UpdateHidden: true,
    UI.DeleteHidden: true
);

annotate AdminService.ProviderConnections with actions {
    clearCredential @(Common.IsActionCritical: true, Common.SideEffects: { TargetProperties: ['credentialHint', 'credentialUpdatedAt'] });
};

annotate AdminService.ProviderConnections with {
    name @(Common.Label: '{i18n>common.name}', Common.FieldControl: #Mandatory, Common.QuickInfo: '{i18n>connections.nameInfo}');
    title @(Common.Label: '{i18n>connections.title}');
    providerType @(Common.Label: '{i18n>connections.providerType}', Common.FieldControl: #Mandatory,
        Common.Text: providerTypeText, Common.TextArrangement: #TextOnly);
    providerTypeText @(Common.Label: '{i18n>connections.providerType}', UI.Hidden: true);
    isActive @(Common.Label: '{i18n>common.active}');
    // sap-ai-core: endpoint (the AI API URL), region and tenantId (the zone) come from the service key: shown on
    // the saved connection, not offered while editing (setCredential sets them). Its client id is never shown
    // (spec §4): the masked credential hint stands for it.
    // azure-openai; sap-ai-core
    endpoint @(Common.Label: '{i18n>connections.endpoint}',
        UI.Hidden: { $edmJson: { $And: [ { $Ne: [ { $Path: 'providerType' }, 'azure-openai' ] },
            { $Or: [ { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] }, { $Not: { $Path: 'IsActiveEntity' } } ] } ] } });
    apiMode @(Common.Label: '{i18n>connections.apiMode}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'azure-openai' ] } });
    apiVersion @(Common.Label: '{i18n>connections.apiVersion}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'apiMode' }, 'deployments' ] } });
    // azure-openai with Entra ID; sap-ai-core (tenantId only)
    tenantId @(Common.Label: '{i18n>connections.tenantId}',
        UI.Hidden: { $edmJson: { $And: [ { $Ne: [ { $Path: 'authMode' }, 'entra-client-secret' ] },
            { $Or: [ { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] }, { $Not: { $Path: 'IsActiveEntity' } } ] } ] } });
    clientId @(Common.Label: '{i18n>connections.clientId}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'authMode' }, 'entra-client-secret' ] } });
    // azure-openai and bedrock
    authMode @(Common.Label: '{i18n>connections.authMode}',
        UI.Hidden: { $edmJson: { $And: [ { $Ne: [ { $Path: 'providerType' }, 'azure-openai' ] }, { $Ne: [ { $Path: 'providerType' }, 'bedrock' ] } ] } });
    // bedrock; sap-ai-core
    region @(Common.Label: '{i18n>common.region}',
        UI.Hidden: { $edmJson: { $And: [ { $Ne: [ { $Path: 'providerType' }, 'bedrock' ] },
            { $Or: [ { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] }, { $Not: { $Path: 'IsActiveEntity' } } ] } ] } });
    // bedrock
    runtimeEndpoint @(Common.Label: '{i18n>connections.runtimeEndpoint}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'bedrock' ] } });
    accessKeyId @(Common.Label: '{i18n>common.accessKeyId}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'bedrock' ] } });
    // openai and anthropic
    baseUrl @(Common.Label: '{i18n>connections.baseUrl}',
        UI.Hidden: { $edmJson: { $And: [ { $Ne: [ { $Path: 'providerType' }, 'openai' ] }, { $Ne: [ { $Path: 'providerType' }, 'anthropic' ] } ] } });
    organization @(Common.Label: '{i18n>connections.organization}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'openai' ] } });
    project @(Common.Label: '{i18n>connections.project}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'openai' ] } });
    anthropicVersion @(Common.Label: '{i18n>connections.anthropicVersion}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'anthropic' ] } });
    // sap-ai-core. Productive is a checkbox, which shows "not chosen" (null) like "non-productive": the draft
    // starts at the installation's classification (admin-service-connections.ts, NEW) and the QuickInfo says what it decides.
    resourceGroup @(Common.Label: '{i18n>connections.resourceGroup}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] } });
    productive @(Common.Label: '{i18n>connections.productive}', Common.QuickInfo: '{i18n>connections.productiveInfo}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] } });
    priceRegion @(Common.Label: '{i18n>connections.priceRegion}', Common.QuickInfo: '{i18n>connections.priceRegionInfo}',
        UI.Hidden: { $edmJson: { $Ne: [ { $Path: 'providerType' }, 'sap-ai-core' ] } });
    // Server-owned
    credentialHint @(Common.Label: '{i18n>connections.credentialHint}', Common.FieldControl: #ReadOnly);
    credentialUpdatedAt @(Common.Label: '{i18n>connections.credentialUpdatedAt}', Common.FieldControl: #ReadOnly);
    lastTestAt @(Common.Label: '{i18n>connections.lastTestAt}', Common.FieldControl: #ReadOnly);
    lastTestResult @(Common.Label: '{i18n>connections.lastTestResult}', Common.FieldControl: #ReadOnly);
    publishedModels @(Common.Label: '{i18n>connections.publishedModels}', Common.FieldControl: #ReadOnly);
};

annotate AdminService.ConnectionModels with @(
    // The four model actions are toolbar buttons that act on the selected rows (multi selection, manifest; Set Price needs exactly one).
    // A responsive table drops low-importance columns first when the width runs out: the columns that
    // decide them stay; the family goes first.
    UI.LineItem#ForConnection: [
        { $Type: 'UI.DataField', Value: upstreamModel, Label: '{i18n>connections.upstreamModel}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: modelId, Label: '{i18n>connections.modelId}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: displayName, Label: '{i18n>connections.displayName}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: family, Label: '{i18n>connections.family}', ![@UI.Importance]: #Low },
        { $Type: 'UI.DataField', Value: isPublished, Label: '{i18n>connections.isPublished}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: isPriced, Label: '{i18n>connections.isPriced}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: inputCost, Label: '{i18n>connections.inputCost}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: outputCost, Label: '{i18n>connections.outputCost}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: priceCurrency, Label: '{i18n>common.currency}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.setListPrice', Label: '{i18n>connections.setListPrice}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.publish', Label: '{i18n>connections.publish}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.unpublish', Label: '{i18n>connections.unpublish}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataFieldForAction', Action: 'AdminService.remove', Label: '{i18n>connections.remove}', ![@UI.Importance]: #High }
    ],
    UI.PresentationVariant#ForConnection: { SortOrder: [ { Property: upstreamModel, Descending: false } ], Visualizations: ['@UI.LineItem#ForConnection'] }
);

annotate AdminService.ConnectionModels with actions {
    setListPrice @(Common.SideEffects: { TargetProperties: ['isPriced', 'inputCost', 'outputCost', 'cacheReadCost', 'cacheCreationCost', 'priceCurrency'] }) (
        inputCost @Common.Label: '{i18n>connections.inputCost}',
        outputCost @Common.Label: '{i18n>connections.outputCost}',
        cacheReadCost @Common.Label: '{i18n>connections.cacheReadCost}',
        cacheCreationCost @Common.Label: '{i18n>connections.cacheCreationCost}',
        currency @Common.Label: '{i18n>common.currency}'
    );
    // The header's count of published models is the parent's: reached through the binding parameter (in).
    publish @(Common.SideEffects: { TargetProperties: ['isPublished', 'in/connection/publishedModels'] });
    unpublish @(Common.SideEffects: { TargetProperties: ['isPublished', 'in/connection/publishedModels'] });
    // remove returns nothing, so FE keeps the deleted rows unless the parent's models list is re-read.
    remove @(Common.IsActionCritical: true, Common.SideEffects: { TargetEntities: [in.connection.models], TargetProperties: ['in/connection/publishedModels'] });
};

// Per 1K tokens, up to six decimals: no Measures.ISOCurrency, whose format would round to the currency's two.
annotate AdminService.ConnectionModels with {
    upstreamModel @(Common.Label: '{i18n>connections.upstreamModel}');
    modelId @(Common.Label: '{i18n>connections.modelId}');
    displayName @(Common.Label: '{i18n>connections.displayName}');
    family @(Common.Label: '{i18n>connections.family}');
    isPublished @(Common.Label: '{i18n>connections.isPublished}');
    isPriced @(Common.Label: '{i18n>connections.isPriced}');
    inputCost @(Common.Label: '{i18n>connections.inputCost}');
    outputCost @(Common.Label: '{i18n>connections.outputCost}');
    cacheReadCost @(Common.Label: '{i18n>connections.cacheReadCost}');
    cacheCreationCost @(Common.Label: '{i18n>connections.cacheCreationCost}');
    priceCurrency @(Common.Label: '{i18n>common.currency}');
    capabilities @(UI.Hidden: true);
    suggestedInputCost @(UI.Hidden: true); suggestedOutputCost @(UI.Hidden: true);
    suggestedCacheReadCost @(UI.Hidden: true); suggestedCacheCreationCost @(UI.Hidden: true);
};
