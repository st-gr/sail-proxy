---
title: SAIL-PROXY Developer Guide - Chapter 5
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-4-gateway-testing.md) | [Content Table](README.md) | [Next Chapter >>](chapter-6-ollama.md)

---

## Admin Cockpit (CAP)

The Admin service is built using SAP Cloud Application Programming Model (CAP) and provides comprehensive management capabilities through both web UI and OData APIs.

### Prerequisites

**Valkey/Redis Required** (adapted from project docs):
```bash
# Start Valkey container (required dependency)
docker run -d --name valkey --restart unless-stopped \
  -p 127.0.0.1:6379:6379 valkey/valkey:8

# Verify connectivity
redis-cli ping  # Should return PONG
```

### Development Setup

#### Starting Admin Service

**From project root**:
```bash
pnpm run dev:admin
```

**From service directory**:
```bash
cd services/admin
pnpm run dev
# Access at http://localhost:4004
```

#### Kill Stuck Processes (from project docs):
```bash
sudo kill -9 $(sudo lsof -t -iTCP:4004 -sTCP:LISTEN)
```

#### Database Reset Options (adapted from `/CAP_PROJECT_SETUP_INSTRUCTIONS.md`):

**Unix/Linux (including WSL2)**:
```bash
cd services/admin
rm -rf .cdsrc-private.json db/ && pnpm run dev
```

**PowerShell (Windows)**:
```bash
cd services/admin
Remove-Item -Recurse -Force .cdsrc-private.json, db/; pnpm run dev
```

### CAP Project Structure

**Service Organization**:
```
services/admin/
├── app/                    # Fiori Elements apps
│   ├── shell/             # Main navigation shell
│   ├── apikeys/           # API key management
│   ├── awscredentials/    # AWS credential management
│   ├── configurations/    # Gateway configuration
│   └── analytics/         # Usage analytics
├── db/                    # Database models and data
├── srv/                   # Service definitions and handlers
├── package.json
└── server.js              # CAP server entry point
```

### Data Model (CDS)

**Core Entities** (`db/schema.cds`):
```cds
entity APIKeys {
  key ID          : UUID;
  name            : String(100);
  description     : String(500);
  token           : String(100) @cds.on.insert: $now;
  status          : String(20) default 'active';
  rateLimits      : String(200);
  ipRestrictions  : String(500);
  createdBy       : User;
  createdAt       : Timestamp;
  expiresAt       : Timestamp;
}

entity AWSCredentials {
  key ID              : UUID;
  name                : String(100);
  accessKeyId         : String(100);
  secretAccessKey     : String(500) @cds.on.insert: $encrypt;
  defaultRegion       : String(50);
  ipRestrictions      : String(500);
  createdBy           : User;
}

entity UsageEvents {
  key ID              : UUID;
  correlationId       : String(100);
  userId              : String(100);
  apiKeyId            : UUID;
  model               : String(100);
  endpoint            : String(200);
  promptTokens        : Integer;
  completionTokens    : Integer;
  totalTokens         : Integer;
  responseTime        : Integer;
  timestamp           : Timestamp;
}
```

### Service Implementation

**Admin Service** (`srv/admin-service.cds`):
```cds
using { APIKeys, AWSCredentials, UsageEvents } from '../db/schema';

service AdminService {
  entity APIKeys as projection on APIKeys;
  entity AWSCredentials as projection on AWSCredentials;
  entity UsageEvents as projection on UsageEvents;
  
  // Custom actions
  action generateAPIKey(name: String, description: String) returns String;
  action revokeAPIKey(keyId: UUID) returns Boolean;
  action rotateAPIKey(keyId: UUID) returns String;
  
  // Analytics functions
  function getUsageAnalytics(timeRange: String) returns array of {
    date: Date;
    requests: Integer;
    tokens: Integer;
  };
}
```

### Custom Handlers

**Service Handler** (`srv/admin-service.js`):
```javascript
const cds = require('@sap/cds');
const crypto = require('crypto');

class AdminService extends cds.ApplicationService {
  async init() {
    // API Key management
    this.on('generateAPIKey', this.generateAPIKey);
    this.on('revokeAPIKey', this.revokeAPIKey);
    
    // Usage analytics
    this.on('getUsageAnalytics', this.getUsageAnalytics);
    
    // Security events
    this.before('CREATE', 'APIKeys', this.validateAPIKeyCreation);
    this.after('UPDATE', 'APIKeys', this.logAPIKeyChange);
    
    return super.init();
  }
  
  async generateAPIKey(req) {
    const { name, description } = req.data;
    
    // Generate secure API key
    const token = 'sp-proj-' + crypto.randomBytes(32).toString('hex');
    
    // Create database record
    const apiKey = await INSERT.into('APIKeys').entries({
      ID: cds.utils.uuid(),
      name,
      description,
      token,
      status: 'active',
      createdBy: req.user.id,
      createdAt: new Date()
    });
    
    return token;
  }
}

module.exports = AdminService;
```

### Testing Admin Service

**Test Structure** (from `/CLAUDE.md`):
```
services/admin/test/
├── setupTests.ts              # Global test setup
├── unit/                      # Unit tests
├── integration/               # Integration tests
│   └── http/                  # HTTP endpoint tests
├── security/                  # Security tests
└── bruno/                     # API testing collections
```

**Running Tests**:
```bash
# All admin tests
pnpm test:admin

# Specific test categories
pnpm test:admin:unit           # Unit tests only
pnpm test:admin:integration    # Integration tests only
pnpm test:admin:http           # HTTP endpoint tests
pnpm test:admin:security       # Security tests only

# From admin service directory
cd services/admin
pnpm test                      # All admin tests
pnpm test:unit                 # Unit tests only
pnpm test:integration          # Integration tests only
```

### Fiori Elements Apps

**Shell Application** (`app/shell/`):
```javascript
// Navigation configuration
sap.ui.define([
  "sap/fe/core/AppComponent"
], function (AppComponent) {
  return AppComponent.extend("shell.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
```

**API Keys Management** (`app/apikeys/`):
```json
{
  "sap.app": {
    "id": "apikeys",
    "type": "application"
  },
  "sap.ui5": {
    "dependencies": {
      "libs": {
        "sap.fe.templates": {}
      }
    }
  },
  "sap.fe": {
    "fclEnabled": true,
    "flexibilityServices": [
      {
        "connector": "LrepConnector",
        "settings": {
          "maxAge": 0
        }
      }
    ]
  }
}
```

### Security Implementation

**JWT Authentication** (for API access):
```javascript
// JWT middleware for OData APIs
const jwt = require('jsonwebtoken');

const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};
```

### Compilation Issues (adapted from `/COMPILATION_FIXES.md`)

**Common Build Problems**:
```bash
# Clear CAP cache
rm -rf .cdsrc-private.json
rm -rf node_modules/.cache

# Regenerate types
npx cds compile srv/ --to edmx > /dev/null

# Fix TypeScript issues
npx cds add typer
npx cds typer
```

### Performance Monitoring

**OData Query Optimization**:
```javascript
// Custom query handlers for performance
this.on('READ', 'UsageEvents', async (req) => {
  // Add indexes and limit large queries
  if (!req.query.SELECT.limit) {
    req.query.SELECT.limit = { rows: { val: 1000 } };
  }
  
  // Use database-specific optimizations
  if (cds.env.requires.db.kind === 'postgres') {
    req.query.SELECT.orderBy = [{ ref: ['timestamp'], sort: 'desc' }];
  }
  
  return next();
});
```

---

*Next: Understand the [Ollama Service](chapter-6-ollama.md) implementation and API compatibility layer.*