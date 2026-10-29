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
        { $Type: 'UI.DataField', Value: usageType, Label: '{i18n>sapRates.usageType}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: dateFrom, Label: '{i18n>sapRates.validFrom}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: dateTo, Label: '{i18n>sapRates.validTo}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: pricePerCu, Label: '{i18n>sapRates.pricePerCu}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: currency, Label: '{i18n>common.currency}', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: servicePlan, Label: '{i18n>sapRates.servicePlan}', ![@UI.Importance]: #Medium },
        { $Type: 'UI.DataField', Value: region, Label: '{i18n>common.region}', ![@UI.Importance]: #Low }
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
        TypeName: '{i18n>sapRates.capacityUnitPrice}',
        TypeNamePlural: '{i18n>sapRates.capacityUnitPrices}',
        Title: { Value: usageType },
        Description: { Value: currency }
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>sapRates.priceValidity}', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', Label: '{i18n>common.recordInformation}', Target: '@UI.FieldGroup#Metadata' }
    ],
    UI.FieldGroup#General: {
        Data: [
            // Order tuned for the object page's column-major, 2-row field layout so that
            // Valid From and Valid To land next to each other on the top row (they are the
            // temporal key of the record): dateFrom and dateTo sit at the two adjacent
            // top-row column positions, with usageType directly under dateFrom.
            { $Type: 'UI.DataField', Value: dateFrom, Label: '{i18n>sapRates.validFrom}' },
            { $Type: 'UI.DataField', Value: usageType, Label: '{i18n>sapRates.usageType}' },
            { $Type: 'UI.DataField', Value: dateTo, Label: '{i18n>sapRates.validTo}' },
            { $Type: 'UI.DataField', Value: pricePerCu, Label: '{i18n>sapRates.pricePerCu}' },
            { $Type: 'UI.DataField', Value: currency, Label: '{i18n>common.currency}' },
            { $Type: 'UI.DataField', Value: servicePlan, Label: '{i18n>sapRates.servicePlan}' },
            { $Type: 'UI.DataField', Value: region, Label: '{i18n>common.region}' },
            { $Type: 'UI.DataField', Value: sku, Label: '{i18n>sapRates.sku}' }
        ]
    },
    UI.FieldGroup#Metadata: {
        Data: [
            { $Type: 'UI.DataField', Value: createdAt, Label: '{i18n>common.createdAt}' },
            { $Type: 'UI.DataField', Value: createdBy, Label: '{i18n>common.createdBy}' },
            { $Type: 'UI.DataField', Value: modifiedAt, Label: '{i18n>common.modifiedAt}' },
            { $Type: 'UI.DataField', Value: modifiedBy, Label: '{i18n>common.modifiedBy}' }
        ]
    }
);

annotate AdminService.SapCapacityUnitPrice with {
    usageType @(
        Common.Label: '{i18n>sapRates.usageType}',
        Common.FieldControl: #Mandatory,
        Common.ValueListWithFixedValues: true,
        Common.ValueList: {
            CollectionPath: 'SapUsageTypeCodes',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: usageType, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
            ]
        },
        Common.QuickInfo: '{i18n>sapRates.usageTypeInfo}'
    );
    dateFrom @(
        Common.Label: '{i18n>sapRates.validFrom}',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: '{i18n>sapRates.validFromInfo}'
    );
    dateTo @(
        Common.Label: '{i18n>sapRates.validTo}',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: '{i18n>sapRates.validToInfo}'
    );
    pricePerCu @(
        Common.Label: '{i18n>sapRates.pricePerCu}',
        Common.FieldControl: #Mandatory,
        Common.QuickInfo: '{i18n>sapRates.pricePerCuInfo}'
    );
    currency @(
        Common.Label: '{i18n>common.currency}',
        Common.QuickInfo: '{i18n>sapRates.currencyInfo}'
    );
    servicePlan @(
        Common.Label: '{i18n>sapRates.servicePlan}',
        Common.ValueListWithFixedValues: true,
        Common.ValueList: {
            CollectionPath: 'SapServicePlanCodes',
            Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: servicePlan, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
            ]
        },
        Common.QuickInfo: '{i18n>sapRates.servicePlanInfo}'
    );
    region @(
        Common.Label: '{i18n>common.region}',
        Common.QuickInfo: '{i18n>sapRates.regionInfo}'
    );
    sku @(
        Common.Label: '{i18n>sapRates.sku}',
        Common.QuickInfo: '{i18n>sapRates.skuInfo}'
    );
    createdAt @(Common.Label: '{i18n>common.createdAt}', Common.FieldControl: #ReadOnly);
    createdBy @(Common.Label: '{i18n>common.createdBy}', Common.FieldControl: #ReadOnly);
    modifiedAt @(Common.Label: '{i18n>common.modifiedAt}', Common.FieldControl: #ReadOnly);
    modifiedBy @(Common.Label: '{i18n>common.modifiedBy}', Common.FieldControl: #ReadOnly);
};
