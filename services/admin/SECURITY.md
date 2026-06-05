# Security Vulnerabilities - Accepted Risks

This document tracks security vulnerabilities in dependencies that have been analyzed and accepted as low-risk for this project.

## Accepted Vulnerabilities

### 1. js-yaml - Prototype Pollution

**Status:** Accepted (Build-time only, Low Risk)

**Affected Locations:**
- services/admin/pnpm-lock.yaml
- services/admin/app/security-notifications-app/pnpm-lock.yaml
- services/admin/app/aws-credentials-app/pnpm-lock.yaml
- services/admin/app/api-keys-app/pnpm-lock.yaml

**Vulnerability:** js-yaml has prototype pollution issues in the `merge` (`<<`) operator.

**Root Cause:**
js-yaml is a **transitive dependency** (not directly used in code) brought in by:
- `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` (via ESLint's `@eslint/eslintrc`)
  - Used for parsing YAML configuration files during linting
- `@sap/ux-ui5-tooling`, `ui5-tooling-modules`, `ui5-tooling-transpile`
  - SAP's UI5 build tools for compiling Fiori applications
  - Used for parsing UI5 configuration files (ui5.yaml)
- `cds-plugin-ui5`
  - SAP CAP plugin for serving UI5 applications

**Why We Accept This Risk:**

1. **Build-time Only:** js-yaml is only used during development and build processes, NOT in production runtime
2. **Controlled Environment:** The build environment is controlled and trusted - no untrusted YAML files are processed
3. **Essential Tooling:** These dependencies are required for building the 6 production UI5/Fiori applications that provide the admin interface
4. **No Direct Control:** We cannot fix this without SAP/UI5 tooling and ESLint upstream updates
5. **Low Exploitation Risk:** An attacker would need to inject malicious YAML into:
   - ESLint configuration files (.eslintrc.yml)
   - UI5 configuration files (ui5.yaml)
   - Both are version-controlled and reviewed

**Mitigation:**
- All configuration files are version-controlled and peer-reviewed
- Build environments use trusted base images
- No dynamic YAML parsing of untrusted input

**Versions Affected:**
- js-yaml@3.14.2
- js-yaml@4.1.0
- js-yaml@4.1.1

**Action Plan:**
- Monitor for updates to `@sap/ux-ui5-tooling`, `ui5-tooling-*`, and `@typescript-eslint/*` packages
- Re-evaluate when upstream packages release versions that use patched js-yaml or remove the dependency
- Consider updating dependencies quarterly or when notified of upstream fixes

---

### 2. glob - ReDoS Vulnerability

**Status:** Accepted (Dev-only, Low Risk)

**Affected Location:**
- pnpm-lock.yaml (exact path varies)

**Vulnerability:** glob@10.4.5 has a Regular Expression Denial of Service (ReDoS) vulnerability.

**Root Cause:**
glob is a **transitive dependency** brought in by:
- `copyfiles@2.4.1` (unmaintained since 2019)
  - Used in build scripts to copy bundled files
  - Requires glob as CommonJS module
- `@ui5/mcp-server` (dev dependency)
  - Part of UI5 development tooling

**Why We Accept This Risk:**

1. **Dev-only Vulnerability:** glob is only used by build tools and dev dependencies, NOT in production Docker images
2. **Limited Attack Surface:** Exploiting this vulnerability requires:
   - Control over build-time command-line arguments passed to copyfiles
   - Ability to craft malicious glob patterns
   - Both require compromised build environment or malicious contributor
3. **No Easy Fix:** glob@11+ (which fixes the vulnerability) is ES modules only, but copyfiles@2.4.1 requires CommonJS
4. **High Migration Risk:** Replacing copyfiles would require:
   - Rewriting all bundle scripts in `npm-dist/sail-proxy/package.json`
   - Testing across multiple platforms
   - Potential for introducing new bugs
   - This carries higher risk than accepting the dev-only vulnerability

**Mitigation:**
- Build environments are controlled and monitored
- Build scripts are version-controlled and reviewed
- CI/CD pipelines use trusted images with security scanning
- glob patterns in build scripts are static and audited

**Versions Affected:**
- glob@10.4.5 (and earlier)

**Action Plan:**
- Monitor copyfiles for maintenance resumption or fork
- Evaluate alternative copy utilities that support ESM
- Consider migration when:
  - A maintained alternative with similar API emerges
  - Risk/benefit analysis favors rewriting build scripts
  - Sufficient testing resources are available

---

## Review Schedule

This document should be reviewed:
- Quarterly during dependency update cycles
- When Dependabot reports new related vulnerabilities
- Before major releases
- When upstream packages release security fixes

**Last Reviewed:** 2025-11-24
**Next Review:** 2025-02-24

---

## References

- [js-yaml Advisory](https://github.com/advisories/GHSA-8j8c-7jfh-h6hx)
- [glob ReDoS Advisory](https://github.com/advisories/GHSA-c4w7-xm78-47vh)
- [OWASP Dependency-Check Best Practices](https://owasp.org/www-community/Component_Analysis)
