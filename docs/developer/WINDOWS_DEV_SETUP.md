# Windows Development Environment Setup

This document provides Windows-specific setup instructions and fixes for the SAP LLM Gateway project.

## Prerequisites

- **Node.js**: v20.16.0+ (via nvm-windows or direct installation)
- **PNPM**: v10.12.4+
- **Windows 11** (tested) or Windows 10
- **PowerShell** 5.1+ or PowerShell Core 7+
- **Git for Windows** (with Unix tools in PATH)

## Common Windows Issues and Fixes

### 1. Native Module Compilation Issues

**Problem**: `better-sqlite3` and other native modules fail to compile with errors like:
```
Could not locate the bindings file. Tried:
→ node-v115-win32-x64\better_sqlite3.node
```

**Solution**: Enable build scripts for native dependencies:
```powershell
pnpm approve-builds
# Select all packages when prompted (press 'a' then 'y')
```

This allows PNPM to run build scripts for:
- `@cap-js/cds-types`
- `bcrypt`
- `esbuild`
- `sqlite3`
- `better-sqlite3`

### 2. Unix Command Compatibility

**Problem**: Package.json scripts use Unix commands that don't exist on Windows:
```json
"db:reset": "rm -f db/admin.db* && npm run db:migrate"
```

**Fixed in**: `services/admin/package.json`
```json
"db:reset": "rimraf db/admin.db* && npm run db:migrate"
```

### 3. Shebang Line Issues

**Problem**: Unix shebang lines in TypeScript files cause issues:
```typescript
#!/usr/bin/env node
```

**Solution**: Remove shebang lines from TypeScript files:
- `services/admin/src/index.ts` - Removed `#!/usr/bin/env node`

### 4. NodeJS Path Resolution

**Problem**: Different Node.js versions between WSL2 and Windows can cause module resolution issues.

**Solution**: Ensure consistent Node.js versions:
```powershell
# Check versions
node --version    # Should be v20.16.0+
pnpm --version    # Should be v10.12.4+
nvm --version     # Should be 1.2.2+ (if using nvm-windows)
```

### 5. Database Migration Issues

**Problem**: Database tables don't exist after fresh setup.

**Solution**: Always run database migration after setup:
```powershell
pnpm run db:migrate
```

## Complete Windows Setup Process

### Initial Setup

1. **Clone the repository**:
   ```powershell
   git clone <repository-url>
   cd sap-llm-gateway
   ```

2. **Install dependencies**:
   ```powershell
   pnpm install
   ```

3. **Approve native module builds**:
   ```powershell
   pnpm approve-builds
   # Press 'a' to select all, then 'y' to confirm
   ```

### Admin Service Setup

1. **Navigate to admin service**:
   ```powershell
   cd services\admin
   ```

2. **Clean and prepare directories**:
   ```powershell
   if (Test-Path -Path './dist') { Remove-Item -Recurse -Force './dist' }
   if (Test-Path -Path './gen') { Remove-Item -Recurse -Force './gen' }
   New-Item -Path './dist/srv' -ItemType Directory -Force | Out-Null
   ```

3. **Setup database**:
   ```powershell
   pnpm run db:reset
   ```

4. **Build the project**:
   ```powershell
   pnpm run build
   ```

5. **Start development server**:
   ```powershell
   pnpm run dev:ts:mock
   ```

### Complete One-Liner Setup

For convenience, use this PowerShell command from the admin service directory:

```powershell
Clear-Host; if (Test-Path -Path './dist') { Remove-Item -Recurse -Force './dist' }; if (Test-Path -Path './gen') { Remove-Item -Recurse -Force './gen' }; New-Item -Path './dist/srv' -ItemType Directory -Force | Out-Null; pnpm run db:reset; pnpm run build; pnpm run dev:ts:mock
```

## Development Workflow

### Starting the Server

```powershell
cd services\admin
pnpm run dev:ts:mock
```

The server will be available at: `http://localhost:4004`

**Available Endpoints**:
- Admin Service: `http://localhost:4004/odata/v4/admin`
- Validation Service: `http://localhost:4004/odata/v4/validation`

### Rebuilding After Changes

```powershell
# Stop the server (Ctrl+C)
pnpm run build
pnpm run dev:ts:mock
```

### Database Operations

```powershell
# Reset database (drops all data)
pnpm run db:reset

# Safe migration (preserves data)
pnpm run db:migrate

# View database tables
sqlite3 db/admin.db ".tables"
```

## Troubleshooting

### Server Won't Start

1. **Check Node.js version**:
   ```powershell
   node --version  # Should be v20.16.0+
   ```

2. **Rebuild native modules**:
   ```powershell
   pnpm rebuild
   ```

3. **Clear node_modules and reinstall**:
   ```powershell
   Remove-Item -Recurse -Force node_modules
   pnpm install
   pnpm approve-builds
   ```

### Database Errors

1. **"no such table" errors**: Run database migration:
   ```powershell
   pnpm run db:migrate
   ```

2. **Permission errors**: Ensure SQLite database file is writable:
   ```powershell
   Get-Acl db\admin.db
   ```

### Build Failures

1. **TypeScript compilation errors**: Check tsconfig.json paths
2. **Missing dependencies**: Run `pnpm install`
3. **Native module issues**: Run `pnpm approve-builds`

## Windows-Specific Configurations

### PowerShell Execution Policy

If you encounter script execution errors:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### File Path Handling

The project uses cross-platform path handling, but if you encounter path issues:
- Use forward slashes `/` in configuration files
- Use `path.resolve()` in Node.js code
- Avoid hardcoded Windows paths

### Environment Variables

For development on Windows, create a `.env` file in the admin service directory:
```env
NODE_ENV=development
PORT=4004
```

## Performance Optimizations

### PNPM Configuration

Add to `.npmrc` in project root for better Windows performance:
```
node-linker=isolated
hoist-pattern[]=*
package-import-method=hardlink
```

### File Watching

If file watching is slow, exclude unnecessary directories:
```json
{
  "cds": {
    "watch": {
      "ignore": [
        "test/**",
        "coverage/**", 
        "node_modules/**",
        "gen/**",
        "dist/**",
        ".git/**"
      ]
    }
  }
}
```

## Known Limitations

1. **Symbolic Links**: Some npm packages may create symlinks that don't work well on Windows
2. **Case Sensitivity**: Windows filesystem is case-insensitive, which can cause issues with imports
3. **Path Length**: Windows has a 260-character path limit (usually not an issue with modern Windows 10/11)

## Additional Resources

- [Node.js on Windows](https://nodejs.org/en/docs/guides/working-with-different-filesystems/)
- [PNPM on Windows](https://pnpm.io/installation#on-windows)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
- [WSL2 Setup](https://docs.microsoft.com/en-us/windows/wsl/install) (alternative to native Windows development)

---

**Last Updated**: July 19, 2025  
**Tested On**: Windows 11, Node.js v20.16.0, PNPM v10.12.4
