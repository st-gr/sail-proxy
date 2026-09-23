# Tool Policies Fiori Elements App

This is a Fiori Elements List Report + Object Page application for managing tool governance
policies in the SAP LLM Gateway.

## Features

- **List Report**: View all tool policies, filterable by mode
- **Object Page**: Edit a policy's allow and deny pattern entries inline, and assign it to
  users and API keys
- **Tool Inventory**: A header action on the list opens a read-only inventory of tool usage,
  aggregated per tool and facet over a day range

## Backend Integration

The app connects to the `ToolPolicies` OData entity (draft-enabled), its `allows` and `denies`
compositions, and the `ToolInventory` skip entity, all served by AdminService.

- Bound actions `assignUser`, `unassignUser`, `assignApiKey`, `unassignApiKey` manage a
  policy's assignments
- `ToolInventory` reads `ToolUsageDaily` aggregates over the range of its `day` filter

## Architecture

- **Entity Sets**: `/ToolPolicies` (draft-enabled), `/ToolInventory` from AdminService
- **Templates**: sap.fe.templates.ListReport + sap.fe.templates.ObjectPage
- **Custom Actions**: `ListReportExt.controller.js` navigates to the Tool Inventory list
- **Shell Integration**: Integrated with the admin shell app for unified navigation

## Build and Development

```bash
# Install dependencies
pnpm install

# Build the app
pnpm run build

# Start development server (standalone)
pnpm start
```

## Navigation

The app is integrated with the shell and accessible via:
- Navigation: Administration > Tool Policies (admin only)
- Route: `#tool-policies`
- Component: `admin.toolpolicies.Component`
