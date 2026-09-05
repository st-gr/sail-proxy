using AdminService from '../../src/srv/admin-service';

// ========================================
// SAP Capacity-Unit Price - Fiori Elements V4 Annotations
// ========================================
//
// SapCapacityUnitPrice (Capacity Unit -> currency price) is hand-maintained from SAP's
// S-User-gated price list (https://www.sap.com/products/technology-platform/price-list/
// list.btpea.US.html). The per-model GenAI conversion rates are NOT maintained here - they
// are sourced from ModelCosts, the /v2 discovery data (SAP Note 3437766; see
// sapCapacityService._lookupRate). Field labels follow the same @Common.Label / UI.LineItem
// convention as the sibling apps (api-keys-app, aws-credentials-app).

annotate AdminService.SapCapacityUnitPrice with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: usageType, Label: 'Usage Type', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: dateFrom, Label: 'Valid From', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: dateTo, Label: 'Valid To', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: pricePerCu, Label: 'Price per CU', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: currency, Label: 'Currency', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: servicePlan, Label: 'Service Plan', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: region, Label: 'Region', ![@UI.Importance]: #Low }
    ],
    UI.SelectionFields: [ usageType, currency ],
    // Default list ordering: group by usage type, then newest effective date first so the
    // current (open, end-of-time) price sits at the top of each usage-type group.
    UI.PresentationVariant: {
        SortOrder: [
            { Property: usageType },
            { Property: dateFrom, Descending: true }
        ],
        Visualizations: ['@UI.LineItem']
    }
);

annotate AdminService.SapCapacityUnitPrice with @(
    UI.HeaderInfo: {
        TypeName: 'SAP Capacity Unit Price',
        TypeNamePlural: 'SAP Capacity Unit Prices',
        Title: { Value: usageType },
        Description: { Value: currency }
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', Label: 'Price & Validity', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', Label: 'Record Information', Target: '@UI.FieldGroup#Metadata' }
    ],
    UI.FieldGroup#General: {
        Data: [
            // Order tuned for the object page's column-major, 2-row field layout so that
            // Valid From and Valid To land next to each other on the top row (they are the
            // temporal key of the record): dateFrom and dateTo sit at the two adjacent
            // top-row column positions, with usageType directly under dateFrom.
            { $Type: 'UI.DataField', Value: dateFrom, Label: 'Valid From' },
            { $Type: 'UI.DataField', Value: usageType, Label: 'Usage Type' },
            { $Type: 'UI.DataField', Value: dateTo, Label: 'Valid To' },
            { $Type: 'UI.DataField', Value: pricePerCu, Label: 'Price per CU' },
            { $Type: 'UI.DataField', Value: currency, Label: 'Currency' },
            { $Type: 'UI.DataField', Value: servicePlan, Label: 'Service Plan' },
            { $Type: 'UI.DataField', Value: region, Label: 'Region' },
            { $Type: 'UI.DataField', Value: sku, Label: 'SKU' }
        ]
    },
    UI.FieldGroup#Metadata: {
        Data: [
            { $Type: 'UI.DataField', Value: createdAt, Label: 'Created At' },
            { $Type: 'UI.DataField', Value: createdBy, Label: 'Created By' },
            { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified At' },
            { $Type: 'UI.DataField', Value: modifiedBy, Label: 'Modified By' }
        ]
    }
);

annotate AdminService.SapCapacityUnitPrice with {
    usageType @(
        Common.Label: 'Usage Type',
        Common.FieldControl: #Mandatory,
        Common.ValueListWithFixedValues: true,
        Common.ValueList: {
            CollectionPath: 'SapUsageTypeCodes',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: usageType, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
            ]
        },
        Common.QuickInfo: 'SAP subaccount classification that selects the price: productive or non-productive. SAP classifies each subaccount (a sandbox can be classified productive). Prices are matched by this value within the validity window.'
    );
    dateFrom @(
        Common.Label: 'Valid From',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: 'Start of the validity window (inclusive). Cost uses the price whose [Valid From, Valid To] window contains the event time.'
    );
    dateTo @(
        Common.Label: 'Valid To',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: 'End of the validity window (inclusive). Use a far-future date for the currently-active price. Windows for the same usage type must not overlap.'
    );
    pricePerCu @(
        Common.Label: 'Price per CU',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: 'Price, in the given currency, per Capacity Unit - from the SAP BTP price list (Extended plan). Cost = Capacity Units x this price.'
    );
    currency @(
        Common.Label: 'Currency',
        Common.QuickInfo: 'ISO currency code for Price per CU (e.g. USD). The price lookup matches on Usage Type only, so keep a single currency per usage type and period.'
    );
    servicePlan @(
        Common.Label: 'Service Plan',
        Common.ValueListWithFixedValues: true,
        Common.ValueList: {
            CollectionPath: 'SapServicePlanCodes',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: servicePlan, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
            ]
        },
        Common.QuickInfo: 'SAP service plan the price applies to (extended = the generative AI hub). Descriptive.'
    );
    region @(
        Common.Label: 'Region',
        Common.QuickInfo: 'SAP region the price applies to. Descriptive; not part of the price-matching key.'
    );
    sku @(
        Common.Label: 'SKU',
        Common.QuickInfo: 'SAP material / SKU for the price line. Descriptive.'
    );
    createdAt @(Common.Label: 'Created At', Common.FieldControl: #ReadOnly);
    createdBy @(Common.Label: 'Created By', Common.FieldControl: #ReadOnly);
    modifiedAt @(Common.Label: 'Modified At', Common.FieldControl: #ReadOnly);
    modifiedBy @(Common.Label: 'Modified By', Common.FieldControl: #ReadOnly);
};
