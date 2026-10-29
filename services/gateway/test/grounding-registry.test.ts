import { describe, it, expect } from '@jest/globals';
import {
  SERVICE_KEYS,
  ENDPOINT_AUTH_RULES,
  getEndpointAuthRule,
  isServiceKeyAuthorizedForEndpoint,
  validateServiceKeyPermissions
} from '@libs/service-auth';

describe('service-key registry: grounding', () => {
  it('ADMIN_TO_GATEWAY carries the two grounding permissions', () => {
    expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).toEqual(
      expect.arrayContaining(['grounding:user', 'grounding:admin']));
  });

  it('the key is authorized for the route group root and everything below it', () => {
    expect(isServiceKeyAuthorizedForEndpoint('ADMIN_TO_GATEWAY', '/api/admin/grounding')).toBe(true);
    expect(isServiceKeyAuthorizedForEndpoint('ADMIN_TO_GATEWAY', '/api/admin/grounding/status')).toBe(true);
    expect(isServiceKeyAuthorizedForEndpoint('ADMIN_TO_GATEWAY', '/api/admin/grounding/stores/vs_1/files/file_1')).toBe(true);
  });

  it('the bare path and the wildcard each have a rule, asking for grounding:user', () => {
    expect(ENDPOINT_AUTH_RULES['/api/admin/grounding'].mode).toBe('STANDALONE_OR_SERVICE_KEY');
    expect(getEndpointAuthRule('/api/admin/grounding')?.permissions).toEqual(['grounding:user']);
    expect(getEndpointAuthRule('/api/admin/grounding/status')?.permissions).toEqual(['grounding:user']);
    expect(validateServiceKeyPermissions('ADMIN_TO_GATEWAY', '/api/admin/grounding/files')).toBe(true);
  });

  it('leaves the deployment rules as they were', () => {
    expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).toEqual(
      expect.arrayContaining(['models:read', 'config:write', 'config:read', 'deployments:read', 'deployments:write']));
    expect(getEndpointAuthRule('/api/admin/deployments/d1')?.permissions).toEqual(['deployments:read', 'deployments:write']);
  });
});
