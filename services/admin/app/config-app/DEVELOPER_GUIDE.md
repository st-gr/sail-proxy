# Configuration Management App - Developer Guide

## Overview

The Configuration Management App (`config-app`) is a Freestyle UI5 application that provides comprehensive management of LLM Gateway configurations through a Two-Column Flexible Column Layout. This guide provides detailed implementation information for future enhancement by LLMs.

## Table of Contents

1. [Backend OData Services](#backend-odata-services)
2. [Frontend Architecture](#frontend-architecture)
3. [Implementation Patterns](#implementation-patterns)
4. [Integration Points](#integration-points)
5. [Common Tasks](#common-tasks)
6. [Troubleshooting](#troubleshooting)

## Backend OData Services

### Service Endpoint
Base URL: `/odata/v4/admin/`

### Entity Sets

#### 1. ApiConfigurations (Full CRUD)
**Purpose**: Main entity for configuration management with draft support disabled

**Key Properties**:
```typescript
interface ApiConfiguration {
    ID: Guid;                           // Primary key
    name: string;                       // Configuration name (max 100 chars)
    version: string;                    // Version string (max 20 chars)  
    description?: string;               // Optional description (max 500 chars)
    configData: string;                 // JSON configuration content (required)
    checksum?: string;                  // Content integrity hash (max 64 chars)
    isActive: boolean;                  // Currently deployed flag (default: false)
    isValid: boolean;                   // Validation status (default: false)
    deployedAt?: DateTimeOffset;        // Deployment timestamp
    deployedBy?: string;                // Deployer user (max 100 chars)
    rollbackReason?: string;            // Rollback justification (max 500 chars)
    validationErrors?: string;          // JSON validation error messages
    validationWarnings?: string;        // JSON validation warnings
    lastValidated?: DateTimeOffset;     // Last validation timestamp
    createdAt?: DateTimeOffset;         // Record creation time
    createdBy?: string;                 // Creator user (max 255 chars)
    modifiedAt?: DateTimeOffset;        // Last modification time  
    modifiedBy?: string;                // Last modifier user (max 255 chars)
}
```

**CRUD Operations**:
- `GET /ApiConfigurations` - List all configurations
- `GET /ApiConfigurations(ID)` - Get specific configuration
- `POST /ApiConfigurations` - Create new configuration
- `PATCH /ApiConfigurations(ID)` - Update configuration
- `DELETE /ApiConfigurations(ID)` - Delete configuration

**Important Notes**:
- No draft support (no `IsActiveEntity` fields)
- Direct CRUD operations only
- Only one configuration can have `isActive: true` at a time
- `configData` must be valid JSON string

#### 2. ActiveConfiguration (Read-Only)
**Purpose**: View of currently active configuration

**Properties**: Same as ApiConfigurations but filtered to `isActive: true`

**Operations**:
- `GET /ActiveConfiguration` - Get current active config (should return 0 or 1 record)

**Usage Pattern**:
```typescript
// Get active configuration
const activeBinding = oModel.bindList("/ActiveConfiguration");
const contexts = await activeBinding.requestContexts();
const activeConfig = contexts.length > 0 ? contexts[0].getObject() : null;
```

#### 3. ConfigurationHistory (Read-Only)
**Purpose**: Simplified view of deployment history

**Key Properties**:
```typescript
interface ConfigurationHistory {
    ID: Guid;
    name: string;
    version: string;
    isActive: boolean;
    deployedAt?: DateTimeOffset;
    deployedBy?: string;
    rollbackReason?: string;
    createdAt?: DateTimeOffset;
    createdBy?: string;
    checksum?: string;
    isValid: boolean;
}
```

**Operations**:
- `GET /ConfigurationHistory` - Get deployment history (sorted by deployedAt desc)

### Configuration Actions

#### 1. createConfiguration
**Purpose**: Create and validate new configuration

**Signature**:
```typescript
POST /createConfiguration
Content-Type: application/json

{
    "name": "string",           // Required: Configuration name
    "configData": "string",     // Required: JSON configuration data
    "description": "string"     // Optional: Description
}
```

**Response**:
```typescript
interface CreateConfigurationResponse {
    success: boolean;
    configId?: Guid;            // ID of created configuration
    version?: string;           // Generated version
    checksum?: string;          // Content checksum
    errors?: string[];          // Validation errors
    warnings?: string[];        // Validation warnings
}
```

**Implementation Example**:
```typescript
const oModel = this.getView()?.getModel() as ODataModel;
const actionBinding = oModel.bindContext("/createConfiguration(...)");

actionBinding.setParameter("name", "New Config");
actionBinding.setParameter("configData", JSON.stringify(configObject));
actionBinding.setParameter("description", "Optional description");

const result = await actionBinding.execute();
const response = actionBinding.getBoundContext()?.getObject();
```

#### 2. activateConfiguration
**Purpose**: Deploy a configuration to make it active

**Signature**:
```typescript
POST /activateConfiguration
{
    "configId": "Guid"          // Required: Configuration to activate
}
```

**Response**:
```typescript
interface ActivateConfigurationResponse {
    success: boolean;
    version?: string;           // Activated version
    checksum?: string;          // Configuration checksum
    activatedAt?: DateTimeOffset; // Activation timestamp
    error?: string;             // Error message if failed
}
```

**Business Rules**:
- Only valid configurations (`isValid: true`) can be activated
- Activating a configuration sets all others to `isActive: false`
- Updates `deployedAt` and `deployedBy` fields

#### 3. rollbackConfiguration
**Purpose**: Rollback to previous configuration

**Signature**:
```typescript
POST /rollbackConfiguration
{
    "reason": "string"          // Required: Rollback justification
}
```

**Response**:
```typescript
interface RollbackConfigurationResponse {
    success: boolean;
    rolledBackFrom?: string;    // Previous version
    rolledBackTo?: string;      // Rollback target version
    reason?: string;            // Rollback reason
    rolledBackAt?: DateTimeOffset; // Rollback timestamp
    error?: string;             // Error message if failed
}
```

**Business Logic**:
- Finds the previous active configuration from history
- Activates the previous configuration
- Records rollback reason and timestamp

#### 4. validateConfiguration
**Purpose**: Validate JSON configuration without saving

**Signature**:
```typescript
POST /validateConfiguration
{
    "configData": "string"      // Required: JSON to validate
}
```

**Response**:
```typescript
interface ValidateConfigurationResponse {
    valid: boolean;
    errors?: string[];          // Validation errors
    warnings?: string[];        // Validation warnings
}
```

**Usage Pattern**:
```typescript
// Validate before saving
const configData = this.byId("jsonEditor").getValue();
const actionBinding = oModel.bindContext("/validateConfiguration(...)");
actionBinding.setParameter("configData", configData);

const result = await actionBinding.execute();
const validation = actionBinding.getBoundContext()?.getObject();
if (!validation.valid) {
    // Handle validation errors
}
```

#### 5. getActiveConfiguration (Function)
**Purpose**: Get current active configuration with metadata

**Signature**:
```typescript
GET /getActiveConfiguration()
```

**Response**:
```typescript
interface GetActiveConfigurationResponse {
    success: boolean;
    data?: {
        id: Guid;
        version: string;
        configData: string;
        checksum: string;
        deployedAt: DateTimeOffset;
        deployedBy: string;
    };
    error?: string;
}
```

#### 6. getConfigurationHistory
**Purpose**: Get paginated configuration history

**Signature**:
```typescript
POST /getConfigurationHistory
{
    "limit": number             // Optional: Max records to return
}
```

**Response**:
```typescript
interface GetConfigurationHistoryResponse {
    success: boolean;
    history?: Array<{
        id: Guid;
        name: string;
        version: string;
        isActive: boolean;
        deployedAt: DateTimeOffset;
        deployedBy: string;
        rollbackReason?: string;
        createdAt: DateTimeOffset;
        createdBy: string;
        checksum: string;
    }>;
    total: number;              // Total available records
    error?: string;
}
```

#### 7. getConfigurationStatus
**Purpose**: Get system configuration status

**Signature**:
```typescript
POST /getConfigurationStatus
```

**Response**:
```typescript
interface GetConfigurationStatusResponse {
    success: boolean;
    status?: {
        timestamp: string;
        eventPublishing: boolean;
        activeConfig: {
            hasActiveConfig: boolean;
            version?: string;
            deployedAt?: DateTimeOffset;
            checksum?: string;
        };
    };
    error?: string;
}
```

### Security Model

**Authorization Requirements**:
- All configuration actions require **admin** role
- Regular API access returns `403 Forbidden` for non-admin users
- Service uses JWT-based authentication in production
- Mock authentication in development with predefined admin users

**Test Users (Development)**:
```typescript
// admin@test.com, admin@example.com - Full access
// user@test.com, user@example.com - Limited access (403 on config actions)
```

## Frontend Architecture

### Application Structure

```
config-app/
├── webapp/
│   ├── Component.ts                 // Main component with models setup
│   ├── manifest.json               // App configuration & routing
│   ├── controller/
│   │   ├── App.controller.ts       // Root controller (minimal)
│   │   └── Main.controller.ts      // FCL logic & OData operations
│   ├── view/
│   │   ├── App.view.xml           // Root view (basic App container)
│   │   └── Main.view.xml          // FCL layout with master/detail
│   ├── model/
│   │   └── models.ts              // Device model factory
│   ├── css/
│   │   └── style.css              // Custom styling
│   └── i18n/
│       └── i18n.properties        // Internationalization
├── package.json                    // Dependencies & scripts
├── tsconfig.json                  // TypeScript configuration
├── ui5.yaml                       // UI5 tooling configuration
└── README.md                      // Basic documentation
```

### Component Architecture

#### Component.ts
```typescript
export default class Component extends UIComponent {
    public init(): void {
        super.init();
        
        // Device model for responsive behavior
        this.setModel(createDeviceModel(), "device");
        
        // View model for app state management
        const viewModel = new JSONModel({
            busy: false,                    // Loading state
            selectedConfigId: null,         // Currently selected config
            editorConfig: { /* ... */ },    // JSON editor settings
            validation: { /* ... */ },      // Validation state
            filters: { /* ... */ }          // Search/filter state
        });
        this.setModel(viewModel, "viewModel");
        
        this.getRouter().initialize();
    }
}
```

#### Routing Configuration (manifest.json)
```json
{
    "routing": {
        "config": {
            "routerClass": "sap.m.routing.Router",
            "viewType": "XML",
            "async": true,
            "viewPath": "admin.config.view",
            "controlAggregation": "pages",
            "controlId": "app"
        },
        "routes": [
            {
                "name": "main",
                "pattern": "",
                "target": ["main"]
            },
            {
                "name": "detail", 
                "pattern": "config/{configId}",
                "target": ["main"]
            }
        ],
        "targets": {
            "main": {
                "viewType": "XML",
                "viewName": "Main",
                "viewId": "main",
                "viewLevel": 1
            }
        }
    }
}
```

### Flexible Column Layout Implementation

#### Layout States
```typescript
import { FlexibleColumnLayout } from "sap/f/library";

// Two-column layout (default)
fcl.setLayout(FlexibleColumnLayout.TwoColumnsMidExpanded);

// Single column (mobile or no selection)
fcl.setLayout(FlexibleColumnLayout.OneColumn);
```

#### Master Column Structure
- **Table**: Configuration list with sorting, filtering, searching
- **Toolbar**: Search field, "Active Only" toggle, refresh button
- **Header**: "New Configuration" button
- **Actions**: Inline activate/duplicate/delete buttons per row

#### Detail Column Structure
- **Metadata Panel**: Configuration info form (name, version, description, status)
- **Validation Panel**: Error/warning messages display
- **JSON Editor**: `sap.ui.codeeditor.CodeEditor` for configuration data
- **Toolbar**: Validate and Save buttons

### State Management Patterns

#### View Model Structure
```typescript
interface ViewModelData {
    busy: boolean;                      // Global loading state
    selectedConfigId: string | null;    // Selected configuration ID
    editorConfig: {
        type: "json";
        showLineNumbers: boolean;
        showGutter: boolean; 
        fontSize: string;
        theme: string;
    };
    validation: {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    };
    filters: {
        showActiveOnly: boolean;
        searchQuery: string;
    };
    newConfig: {                        // Create dialog state
        name: string;
        version: string;
        description: string;
        configData: string;
    };
}
```

#### State Update Patterns
```typescript
// Update loading state
const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
viewModel.setProperty("/busy", true);

// Update selected config
viewModel.setProperty("/selectedConfigId", configId);

// Update validation results
viewModel.setProperty("/validation", {
    isValid: result.valid,
    errors: result.errors || [],
    warnings: result.warnings || []
});
```

## Implementation Patterns

### OData Operations

#### List Binding with Sorting
```typescript
// Table binding with default sort
<Table items="{path: '/ApiConfigurations', sorter: {path: 'modifiedAt', descending: true}}">
```

#### Context Binding for Selection
```typescript
public onConfigSelect(event: any): void {
    const selectedItem = event.getSource().getSelectedItem();
    const bindingContext = selectedItem.getBindingContext();
    const configData = bindingContext?.getObject();
    
    if (configData) {
        this._selectedConfig = configData;
        // Update FCL and editor
        this._updateDetailView(configData);
    }
}
```

#### Action Binding Pattern
```typescript
private async _executeAction(actionName: string, parameters: Record<string, any>): Promise<any> {
    const oModel = this.getView()?.getModel() as ODataModel;
    const actionBinding = oModel.bindContext(`/${actionName}(...)`);
    
    // Set parameters
    Object.entries(parameters).forEach(([key, value]) => {
        actionBinding.setParameter(key, value);
    });
    
    try {
        await actionBinding.execute();
        return actionBinding.getBoundContext()?.getObject();
    } catch (error) {
        throw new Error(`${actionName} failed: ${error.message}`);
    }
}
```

### JSON Editor Integration

#### Editor Setup
```typescript
// Get editor reference
const editor = this.byId("jsonEditor") as CodeEditor;

// Set formatted JSON
const formatted = JSON.stringify(JSON.parse(configData), null, 2);
editor.setValue(formatted);

// Get current value
const currentData = editor.getValue();
```

#### Validation Integration
```typescript
private async _validateJsonSyntax(jsonString: string): Promise<boolean> {
    try {
        JSON.parse(jsonString);
        return true;
    } catch (e) {
        MessageBox.error("Invalid JSON syntax");
        return false;
    }
}

private async _validateConfiguration(configData: string): Promise<ValidationResult> {
    const result = await this._executeAction("validateConfiguration", { configData });
    return {
        valid: result.valid,
        errors: result.errors || [],
        warnings: result.warnings || []
    };
}
```

### Error Handling Patterns

#### User-Friendly Error Messages
```typescript
private _handleActionError(error: Error, context: string): void {
    console.error(`${context} error:`, error);
    
    let message = `Error in ${context}`;
    if (error.message.includes("403")) {
        message = "Access denied. Admin privileges required.";
    } else if (error.message.includes("validation")) {
        message = "Configuration validation failed.";
    } else {
        message = `${context} failed: ${error.message}`;
    }
    
    MessageBox.error(message);
}
```

#### Loading State Management
```typescript
private async _executeWithBusyState<T>(operation: () => Promise<T>, context: string): Promise<T> {
    const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
    
    try {
        viewModel.setProperty("/busy", true);
        return await operation();
    } catch (error) {
        this._handleActionError(error, context);
        throw error;
    } finally {
        viewModel.setProperty("/busy", false);
    }
}
```

### Filtering and Search

#### Search Implementation
```typescript
public onSearch(event: any): void {
    const query = event.getParameter("newValue");
    const table = this.byId("configTable") as Table;
    const binding = table.getBinding("items");
    
    if (binding && query) {
        const filters = [
            new Filter("name", FilterOperator.Contains, query),
            new Filter("description", FilterOperator.Contains, query),
            new Filter("version", FilterOperator.Contains, query)
        ];
        const combinedFilter = new Filter(filters, false); // OR logic
        binding.filter([combinedFilter]);
    } else if (binding) {
        binding.filter([]);
    }
}
```

#### Filter Toggle
```typescript
public onFilterChange(): void {
    const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
    const showActiveOnly = viewModel.getProperty("/filters/showActiveOnly");
    
    const table = this.byId("configTable") as Table;
    const binding = table.getBinding("items");
    
    if (binding) {
        const filters = showActiveOnly ? [new Filter("isActive", FilterOperator.EQ, true)] : [];
        binding.filter(filters);
    }
}
```

## Integration Points

### Shell Integration

#### App Registration (App.controller.ts)
```typescript
private appConfigurations = {
    // ... other apps
    "config": {
        componentName: "admin.config.Component",
        manifest: true,
        title: "Configuration Management",
        route: "#config"
    }
};
```

#### Component Loading
```typescript
} else if (appKey === "config") {
    componentConfig = {
        name: "admin.config",
        url: "/config/",
        manifest: true,
        async: true
    };
```

#### Navigation Mapping
```typescript
// Map settings navigation to config app
if (key === "settings") {
    key = "config";
}
```

### Build Integration

#### Package.json Build Script
```json
{
    "scripts": {
        "build": "... && cd ../config-app && pnpm run build && cd ../.."
    }
}
```

#### CDS Plugin Configuration
```json
{
    "cds-plugin-ui5": {
        "modules": {
            "config-app": {
                "path": "app/config-app",
                "configFile": "ui5.yaml", 
                "mountPath": "/config",
                "versionOverride": "1.136.0"
            }
        }
    },
    "sapux": [
        "app/config-app"
    ]
}
```

## Common Tasks

### Adding New Functionality

#### 1. Add New Configuration Action
```typescript
// In controller
public async onCustomAction(): Promise<void> {
    await this._executeWithBusyState(async () => {
        const result = await this._executeAction("customConfigAction", {
            configId: this._selectedConfig.ID,
            customParam: "value"
        });
        
        if (result.success) {
            MessageToast.show("Action completed successfully");
            this._refreshConfigList();
        } else {
            throw new Error(result.error || "Action failed");
        }
    }, "Custom Action");
}
```

#### 2. Add New UI Panel
```xml
<!-- In Main.view.xml detail column -->
<Panel headerText="New Panel" expandable="true" expanded="false">
    <content>
        <!-- Panel content -->
    </content>
</Panel>
```

#### 3. Add New Filter/Search Option
```typescript
// Add to view model
filters: {
    showActiveOnly: boolean;
    showValidOnly: boolean;     // New filter
    searchQuery: string;
}

// Implement filter logic
private _applyFilters(): void {
    const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
    const filters = viewModel.getProperty("/filters");
    const table = this.byId("configTable") as Table;
    const binding = table.getBinding("items");
    
    if (binding) {
        const filterArray: Filter[] = [];
        
        if (filters.showActiveOnly) {
            filterArray.push(new Filter("isActive", FilterOperator.EQ, true));
        }
        
        if (filters.showValidOnly) {
            filterArray.push(new Filter("isValid", FilterOperator.EQ, true));
        }
        
        if (filters.searchQuery) {
            const searchFilters = [
                new Filter("name", FilterOperator.Contains, filters.searchQuery),
                new Filter("description", FilterOperator.Contains, filters.searchQuery)
            ];
            filterArray.push(new Filter(searchFilters, false));
        }
        
        binding.filter(filterArray);
    }
}
```

### Performance Optimization

#### 1. Implement Lazy Loading
```typescript
// For large configuration lists
<Table growing="true" growingThreshold="50" growingScrollToLoad="true">
```

#### 2. Add Caching for Actions
```typescript
private _actionCache = new Map<string, any>();

private async _executeActionWithCache(actionName: string, params: any, cacheKey?: string): Promise<any> {
    if (cacheKey && this._actionCache.has(cacheKey)) {
        return this._actionCache.get(cacheKey);
    }
    
    const result = await this._executeAction(actionName, params);
    
    if (cacheKey) {
        this._actionCache.set(cacheKey, result);
        // Clear cache after 5 minutes
        setTimeout(() => this._actionCache.delete(cacheKey), 300000);
    }
    
    return result;
}
```

#### 3. Optimize JSON Editor Updates
```typescript
private _debounceJsonValidation = this._debounce(async (jsonData: string) => {
    const validation = await this._validateConfiguration(jsonData);
    this._updateValidationDisplay(validation);
}, 1000);

private _debounce(func: Function, wait: number): Function {
    let timeout: NodeJS.Timeout;
    return function executedFunction(...args: any[]) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
```

## Troubleshooting

### Common Issues

#### 1. 403 Forbidden on Actions
**Cause**: User lacks admin role
**Solution**: 
- Check authentication in browser dev tools
- Verify user has "admin" role in JWT token
- In development, use admin@test.com or admin@example.com

#### 2. JSON Editor Not Loading
**Cause**: CodeEditor library not loaded
**Solution**:
- Verify `sap.ui.codeeditor` in manifest.json dependencies
- Check UI5 version compatibility (requires 1.136.0+)
- Ensure proper build with UI5 tooling

#### 3. FCL Not Responding
**Cause**: Layout state management issues
**Solution**:
```typescript
// Reset FCL state
const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
fcl.setLayout(FlexibleColumnLayout.OneColumn);
setTimeout(() => {
    fcl.setLayout(FlexibleColumnLayout.TwoColumnsMidExpanded);
}, 100);
```

#### 4. OData Binding Errors
**Cause**: Model not properly propagated from shell
**Solution**:
- Verify shell passes OData model to component
- Check component sets model correctly in init()
- Use absolute binding paths: `/ApiConfigurations` not `ApiConfigurations`

#### 5. Build Failures
**Cause**: TypeScript compilation errors
**Solution**:
- Check imports are correct and modules exist
- Verify UI5 types are available (`@sapui5/types`)
- Ensure proper namespace usage in views

### Debug Tools

#### 1. OData Request Monitoring
```typescript
// Add to Component.init() for debugging
const oModel = this.getModel() as ODataModel;
oModel.attachRequestSent((event) => {
    console.log("OData Request:", event.getParameter("url"));
});
oModel.attachRequestCompleted((event) => {
    console.log("OData Response:", event.getParameter("response"));
});
```

#### 2. View Model State Inspection
```typescript
// Add to controller for debugging
private _logViewModelState(): void {
    const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
    console.log("View Model State:", viewModel.getData());
}
```

#### 3. FCL State Debugging
```typescript
// Monitor FCL layout changes
const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
fcl.attachStateChange((event) => {
    console.log("FCL State:", event.getParameter("layout"));
});
```

### Testing Strategies

#### 1. Unit Testing Controllers
```typescript
// Example Jest test
describe("Main Controller", () => {
    test("should validate JSON correctly", async () => {
        const controller = new MainController();
        const validJson = '{"valid": true}';
        const result = await controller._validateJsonSyntax(validJson);
        expect(result).toBe(true);
    });
});
```

#### 2. Integration Testing with Mock OData
```typescript
// Mock OData model for testing
const mockModel = new JSONModel();
mockModel.setData({
    ApiConfigurations: [
        { ID: "1", name: "Test Config", isActive: true },
        { ID: "2", name: "Other Config", isActive: false }
    ]
});
```

#### 3. E2E Testing with Puppeteer
```typescript
// Test configuration selection
await page.click('tr[data-config-id="test-config"]');
await page.waitForSelector('#jsonEditor');
const editorContent = await page.$eval('#jsonEditor', el => el.getValue());
expect(editorContent).toContain('"testProperty"');
```

This comprehensive guide provides all necessary information for enhancing the Configuration Management App, including backend service details, frontend architecture, implementation patterns, and troubleshooting guidance.