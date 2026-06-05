# Networking Manifests

## Standard Deployment

For standard deployments, only use:
- `apirule.yaml` - Main APIRule that exposes the nginx service publicly

## Example Configurations

The `apirule-examples.yaml` file contains **OPTIONAL** examples for advanced scenarios:

1. **Custom Domain Example** (`sail-proxy-custom-domain-example`)
   - Shows how to use a custom domain like `admin.api.yourcompany.com`
   - Requires custom Gateway with TLS certificate
   - For enterprises with their own domains

2. **Alternative Subdomain Example** (`sail-proxy-alternative-example`)
   - Shows how to expose the service on multiple subdomains
   - Useful for A/B testing or different environments

**⚠️ Important**: These examples are NOT needed for standard deployments. They will cause errors if applied without proper configuration.

## IP Allowlisting

If you configured IP allowlisting during setup:
- An AuthorizationPolicy will be generated in `manifests/istio-system/` directory
- The policy will be applied to the istio-system namespace (not sail-proxy)
- IP restrictions are enforced at the Istio ingress gateway level
- The old template-based `authorization-policy.yaml` is no longer used

**Note**: The AuthorizationPolicy uses `source.ip` for IP matching and must be deployed to the istio-system namespace to work with Kyma APIRules.