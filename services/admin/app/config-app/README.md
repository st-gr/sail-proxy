# Configuration Management App

A Freestyle UI5 application for managing LLM Gateway configurations with a Two-Column Flexible Column Layout.

## Features

- **Two-Column Layout**: Configuration list on the left, JSON editor on the right
- **Real-time JSON Editing**: Built-in JSON editor with syntax highlighting
- **Configuration Management**: Create, edit, validate, activate, and delete configurations
- **Validation**: Real-time JSON validation and business rule validation
- **Search & Filter**: Search configurations by name, description, or version
- **Active Filter**: Toggle to show only active configurations

## Architecture

- **Freestyle UI5 App**: Custom TypeScript implementation
- **Flexible Column Layout**: Master-detail pattern for optimal UX
- **OData V4 Integration**: Direct integration with admin service endpoints
- **Component-based**: Modular, maintainable code structure

## OData Services Used

- `ApiConfigurations` - CRUD operations for configurations
- `ActiveConfiguration` - Read-only current active config
- `ConfigurationHistory` - Read-only deployment history

## Actions Supported

- `createConfiguration(name, configData, description)`
- `activateConfiguration(configId)`
- `rollbackConfiguration(reason)`
- `validateConfiguration(configData)`
- `getActiveConfiguration()`
- `getConfigurationHistory(limit)`
- `getConfigurationStatus()`

## Usage

The app is launched from the shell's "Settings" navigation item and provides a complete configuration management interface for the LLM Gateway system.

## Technical Details

- **UI5 Version**: 1.136.0
- **Libraries**: sap.m, sap.f, sap.ui.codeeditor
- **TypeScript**: Full TypeScript implementation
- **Build Tool**: UI5 Tooling with TypeScript transpilation