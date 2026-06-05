# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-11-debugging.md) | [Content Table](README.md) | [Next Chapter >>](chapter-13-plugin-system.md)

---

# Chapter 12: UI5 Application Development

## Overview

The SAP LLM Gateway admin service uses a dual architecture for serving UI5/Fiori Elements applications that developers must understand to avoid deployment issues. This chapter explains the critical differences between Docker and local development environments and provides comprehensive guidance for adding new UI5 applications.

## Table of Contents

- [Dual Architecture Overview](#dual-architecture-overview)
- [Adding New UI5 Applications](#adding-new-ui5-applications)
- [Build Process Deep Dive](#build-process-deep-dive)
- [Integration Checklist](#integration-checklist)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

## Dual Architecture Overview

### The Critical Difference

The SAP LLM Gateway uses **fundamentally different architectures** for serving UI5 applications in Docker vs local development environments:

| Environment | Serving Method | Configuration Required |
|------------|----------------|----------------------|
| **Docker Production** | Pre-built static files | Dockerfile build commands |
| **Local Development** | Dynamic plugin serving | `package.json` cds-plugin-ui5 config |

### Why Both Configurations Are Required

**Docker Environment:**
- Uses explicit build commands in `docker/admin.Dockerfile`
- Serves pre-compiled static assets for optimal performance
- No runtime dependencies on development plugins
- **Result**: Works with any UI5 app that has a proper build process

**Local Development Environment:**
- Uses `cds-plugin-ui5` DevDependency for dynamic serving
- Requires explicit configuration in `package.json`
- Enables hot-reload and development features
- **Result**: Only works with properly configured apps

### Common Symptom: "Works in Docker but not Locally"

If you see this error in local development:
```
ModuleError: failed to load 'admin/yourapp/Component.js' from /your-app/Component.js: script load error
```

But the app works fine in Docker deployment, you have a **dual architecture configuration issue**.

## Adding New UI5 Applications

### Prerequisites

Before adding a new UI5/Fiori Elements application, ensure you understand:
- The dual architecture requirements
- CAP service integration patterns
- UI5 build tooling basics

### Step-by-Step Integration Process

#### Step 1: Create the UI5 Application

1. **Generate the app structure** (usually via Fiori Elements templates)
2. **Place in correct directory**: `services/admin/app/your-new-app/`
3. **Verify build tooling**: Ensure `package.json`, `ui5.yaml`, and proper Component.js exist

#### Step 2: Configure for Local Development

Add your app to **THREE required locations** in `/services/admin/package.json`:

**A. Build Script (line ~11):**
```json
{
  "scripts": {
    "build": "... && cd ../your-new-app && pnpm run build && cd ../.."
  }
}
```

**B. CDS Plugin UI5 Modules Configuration:**
```json
{
  "cds": {
    "cds-plugin-ui5": {
      "modules": {
        "your-new-app": {
          "path": "app/your-new-app",
          "configFile": "ui5.yaml",
          "mountPath": "/your-new-app",
          "versionOverride": "1.136.0"
        }
      }
    }
  }
}
```

**C. sapux Array:**
```json
{
  "sapux": [
    "app/shell",
    "app/api-keys-app",
    "app/your-new-app"
  ]
}
```

#### Step 3: Configure for Docker Deployment

The Docker configuration is **automatically handled** by existing Dockerfile commands:

```dockerfile
# This builds ALL apps in the app/ directory automatically
RUN --mount=type=cache,target=/root/.ui5/framework,sharing=locked \
    cd app/your-new-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist
```

No additional Docker configuration is needed if your app follows standard UI5 build conventions.

#### Step 4: Integration with Shell (if applicable)

If your app needs to be accessible from the admin shell:

1. **Add navigation**: Update `app/shell/webapp/view/App.view.xml`
2. **Add routing**: Update `app/shell/webapp/controller/App.controller.ts`
3. **Add service annotations**: Update `app/services.cds`

See the [Fiori Elements Integration Guide](../services/admin/app/FIORI-ELEMENTS-INTEGRATION-GUIDE.md) for detailed shell integration steps.

## Build Process Deep Dive

### Docker Build Process

**Location**: `docker/admin.Dockerfile` lines 65-75

```dockerfile
# Explicit per-app builds
RUN echo "=== Building UI5 Applications ===" && \
    cd app/shell && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../api-keys-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../aws-credentials-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../your-new-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist
```

**Characteristics:**
- ✅ Builds all apps explicitly, regardless of package.json configuration
- ✅ Creates static `/dist` folders for production serving
- ✅ Uses framework caching for optimal build performance
- ✅ Independent of local development configuration

### Local Development Build Process

**Location**: `/services/admin/package.json` build script

```bash
pnpm run build
# Executes: cds build && tsc -p . && ... && cd app/your-new-app && pnpm run build && cd ../..
```

**Characteristics:**
- ⚠️ Only builds apps explicitly listed in the build script
- ⚠️ Requires cds-plugin-ui5 configuration for serving
- ✅ Enables hot-reload during development
- ✅ Integrates with CAP development workflow

### Verification Steps

**After adding a new app, verify both environments work:**

1. **Local Development Test:**
   ```bash
   cd services/admin
   pnpm run build  # Should show "Building your-new-app"
   pnpm run dev:ts:mock
   # Navigate to: http://localhost:4004/your-new-app/
   ```

2. **Docker Build Test:**
   ```bash
   # Ask user to run Docker build (WSL2 limitation)
   # Should build without errors and serve app at runtime
   ```

## Integration Checklist

Use this checklist when adding new UI5 applications:

### ✅ Pre-Integration Checklist

- [ ] App has proper UI5 build tooling (`ui5.yaml`, `package.json`)
- [ ] App compiles successfully with `pnpm run build`
- [ ] App follows standard Fiori Elements or UI5 patterns
- [ ] Understand dual architecture requirements

### ✅ Local Development Configuration

- [ ] Added to main build script in `/services/admin/package.json`
- [ ] Added to `cds-plugin-ui5.modules` configuration
- [ ] Added to `sapux` array
- [ ] **Verified proper ordering** (maintain historical/semantic sequence)

### ✅ Shell Integration (if needed)

- [ ] Navigation items added to shell
- [ ] Routing configuration updated
- [ ] Service annotations registered
- [ ] Breadcrumb handling implemented

### ✅ Testing & Verification

- [ ] App builds successfully in local development
- [ ] App loads without Component.js errors locally
- [ ] App accessible from shell (if integrated)
- [ ] Docker build includes the app (user verification needed)
- [ ] App works in Docker deployment

### ✅ Documentation & Maintenance

- [ ] Updated relevant developer documentation
- [ ] Added app to any deployment checklists
- [ ] Informed team of new app availability

## Troubleshooting

### Common Issue: "Works in Docker but not Locally"

**Symptoms:**
```
ModuleError: failed to load 'admin/yourapp/Component.js' from /your-app/Component.js: script load error
```

**Root Cause:** Missing local development configuration

**Solution:**
1. Add app to `package.json` build script
2. Add app to `cds-plugin-ui5.modules` configuration  
3. Add app to `sapux` array
4. Restart development server

**Example Fix:**
```json
// In /services/admin/package.json
{
  "scripts": {
    "build": "... && cd ../your-missing-app && pnpm run build && cd ../.."
  },
  "cds": {
    "cds-plugin-ui5": {
      "modules": {
        "your-missing-app": {
          "path": "app/your-missing-app",
          "configFile": "ui5.yaml", 
          "mountPath": "/your-missing-app",
          "versionOverride": "1.136.0"
        }
      }
    }
  },
  "sapux": [
    "app/shell",
    "app/your-missing-app"
  ]
}
```

### Common Issue: "Works Locally but not in Docker"

**Symptoms:** App loads in local development but fails in Docker deployment

**Root Cause:** Usually build process issues, not configuration

**Solution:**
1. Verify app has proper `ui5.yaml` configuration
2. Test `pnpm run build` works in app directory
3. Check Dockerfile includes proper build commands
4. Ensure no development-only dependencies

### Build Process Debugging

**Local Build Issues:**
```bash
cd services/admin
pnpm run build 2>&1 | grep -E "(error|Error|your-app)"
```

**Check cds-plugin-ui5 Configuration:**
```bash
cd services/admin  
node -e "console.log(JSON.stringify(require('./package.json')['cds']['cds-plugin-ui5'], null, 2))"
```

**Verify App Build Output:**
```bash
ls -la app/your-app/dist/  # Should contain Component.js and other built assets
```

## Best Practices

### Development Workflow

1. **Always test both environments** during development
2. **Follow the integration checklist** for every new app
3. **Maintain proper ordering** in configuration arrays
4. **Use consistent naming conventions** across all configuration points

### Configuration Management

1. **Keep configurations in sync** between Docker and local
2. **Document any app-specific requirements** 
3. **Test configuration changes** before committing
4. **Follow semantic ordering** in package.json arrays

### Error Prevention

1. **Use the integration checklist** religiously
2. **Understand the dual architecture** before starting
3. **Test in local development first**, then verify Docker works
4. **Don't assume Docker success means local development will work**

### Team Collaboration

1. **Communicate new app additions** to the team
2. **Update documentation** when adding apps
3. **Share integration lessons learned**
4. **Maintain consistent development practices**

## Related Documentation

- [Fiori Elements Integration Guide](../services/admin/app/FIORI-ELEMENTS-INTEGRATION-GUIDE.md) - Detailed shell integration
- [Chapter 5: Admin Cockpit](./chapter-5-admin-cockpit.md) - Admin service overview
- [Chapter 7: Docker Deployment](./chapter-7-docker-deployment.md) - Production deployment
- [CAP Project Setup Instructions](./CAP_PROJECT_SETUP_INSTRUCTIONS.md) - CAP development basics

---

**Remember**: The dual architecture exists for good reasons - Docker optimizes for production performance while local development optimizes for developer experience. Understanding and respecting both is key to successful UI5 app integration.

---

*This concludes the SAIL-PROXY Developer Guide. You now have comprehensive knowledge of the system architecture, implementation details, testing strategies, security measures, debugging techniques, and UI5 application development patterns needed to effectively work with and contribute to the SAIL-PROXY project.*