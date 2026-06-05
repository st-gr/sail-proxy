# API Keys Fiori Elements App

This is a Fiori Elements app for managing API keys in the SAP LLM Gateway administration interface.

## Features

- **List Report**: View all API keys with filtering and sorting capabilities
- **Object Page**: Detailed view and editing of individual API keys
- **Draft Support**: Create and edit API keys with draft functionality
- **Integration**: Seamlessly integrated with the main shell application

## Development

### Prerequisites

- Node.js (version 20 or higher)
- SAP CAP CLI
- UI5 CLI

### Running the App

#### Standalone (for development)
```bash
cd app/api-keys-app
npm install
npm start
```

#### Integrated with Shell App
```bash
# From the services/admin directory
pnpm run watch-api-keys
```

#### Via Shell App
```bash
# From the services/admin directory  
pnpm run watch-shell
```
Then navigate to API Keys in the side navigation.

## Architecture

### Files Structure
```
app/api-keys-app/
├── annotations.cds              # UI annotations for the ApiKeys entity
├── package.json                 # App-specific dependencies and scripts
├── ui5.yaml                     # UI5 tooling configuration
└── webapp/
    ├── Component.js             # Main app component
    ├── index.html               # Standalone entry point
    ├── manifest.json            # App descriptor
    ├── annotations/
    │   └── annotation.xml       # XML-based UI annotations
    └── i18n/
        └── i18n.properties      # Internationalization texts
```

### Entity Configuration

The app uses the `AdminService.ApiKeys` entity with:
- **Draft enabled**: Allows create/edit operations with draft functionality
- **Security**: Row-level security based on user email for regular users
- **Masked data**: API keys are never fully exposed in the UI

### UI Annotations

Key UI annotations include:
- **LineItem**: Table columns for the list report
- **SelectionFields**: Available filters
- **HeaderInfo**: Object page header configuration
- **Facets**: Object page sections
- **FieldGroups**: Organized field collections

## Security Considerations

- API keys are masked in the UI (showing only first 8 and last 4 characters)
- Full API keys are never transmitted to the frontend
- Row-level security ensures users can only see their own keys (unless admin)
- Draft functionality allows safe editing without immediate persistence

## Integration Notes

The app is designed to work within the shell application context but can also run standalone for development purposes. The shell app loads it as a component and handles navigation.

## Troubleshooting

### Common Issues

1. **Component not loading**: Check that the component name in shell app matches the actual component
2. **Annotations not working**: Verify that services.cds includes the annotations
3. **Data not showing**: Ensure the backend service is running and accessible
4. **Permission errors**: Verify user roles and entity-level security annotations

### Development Tips

- Use `pnpm run watch-api-keys` for direct app development
- Use browser dev tools to inspect OData requests
- Check CAP logs for backend errors
- Verify metadata at `/odata/v4/admin/$metadata`