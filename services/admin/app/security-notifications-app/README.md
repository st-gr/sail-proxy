# Security Notifications Fiori Elements App

This is a Fiori Elements List Report + Object Page application for managing security notifications in the SAP LLM Gateway.

## Features

- **List Report**: View all security notifications with filtering and search capabilities
- **Object Page**: View detailed notification information and manage notification state
- **Quick Variants**: Filter by Unread, Pinned, Snoozed, or All notifications
- **User Actions**: 
  - Mark notifications as seen (automatically when viewing details)
  - Dismiss notifications
  - Snooze notifications for 24 hours
  - Pin/Unpin important notifications

## Backend Integration

The app connects to the `MySecurityNotifications` OData entity which provides:
- User-scoped security notifications (`ownerEmail = $user.id`)
- Pre-joined user state (seen, dismissed, snoozed, pinned)
- Actions for notification management via bound OData actions

## Architecture

- **Entity Set**: `/MySecurityNotifications` from AdminService
- **Templates**: sap.fe.templates.ListReport + sap.fe.templates.ObjectPage
- **Custom Actions**: TypeScript controller extensions for notification management
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
- Navigation: Analytics > Security events
- Route: `#security-events`
- Component: `admin.securitynotifications.Component`