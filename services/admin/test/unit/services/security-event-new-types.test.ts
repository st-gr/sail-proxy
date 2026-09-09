/**
 * The gateway emits model_not_entitled (inference refused) and deployment_created; the admin
 * must accept them and render sensible notification titles instead of "Security event for ...".
 */
export {};
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

import SecurityEventService from '../../../src/services/securityEventService';
import { notificationPopulationService } from '../../../src/services/notificationPopulationService';

describe('new security event types', () => {
  it('titles for API key events (SecurityEventService)', () => {
    const t = (SecurityEventService as any).generateTitleForApiKeyEvent;
    expect(t('model_not_entitled', 'Build key')).toBe('Model request refused for API key Build key: not in entitlement');
    expect(t('deployment_created', 'Ops key')).toBe('Deployment created via API key Ops key');
  });

  it('titles for AWS credential events (SecurityEventService)', () => {
    const t = (SecurityEventService as any).generateTitleForAwsEvent;
    expect(t('model_not_entitled', 'Prod cred')).toBe('Model request refused for AWS credential Prod cred: not in entitlement');
    expect(t('deployment_created', 'Prod cred')).toBe('Deployment created via AWS credential Prod cred');
  });

  it('titles agree with NotificationPopulationService (API key events)', () => {
    const t = (notificationPopulationService as any).generateTitleForApiKeyEvent;
    expect(t('model_not_entitled', 'Build key')).toBe('Model request refused for API key Build key: not in entitlement');
    expect(t('deployment_created', 'Ops key')).toBe('Deployment created via API key Ops key');
  });

  it('titles agree with NotificationPopulationService (AWS credential events)', () => {
    const t = (notificationPopulationService as any).generateTitleForAwsEvent;
    expect(t('model_not_entitled', 'Prod cred')).toBe('Model request refused for AWS credential Prod cred: not in entitlement');
    expect(t('deployment_created', 'Prod cred')).toBe('Deployment created via AWS credential Prod cred');
  });

  it('icons and actionability (SecurityEventService)', () => {
    const icon = (SecurityEventService as any).getIconForEventType;
    expect(icon('model_not_entitled')).toBe('sap-icon://locked');
    expect(icon('deployment_created')).toBe('sap-icon://cloud');
    expect((SecurityEventService as any).isEventActionable('model_not_entitled')).toBe(true);
    expect((SecurityEventService as any).isEventActionable('deployment_created')).toBe(false);
    expect((SecurityEventService as any).getActionText('model_not_entitled')).toBe('Review entitlement');
    expect((SecurityEventService as any).getActionText('deployment_created')).toBe(null);
  });

  it('icons and actionability agree with NotificationPopulationService', () => {
    const icon = (notificationPopulationService as any).getIconForEventType;
    expect(icon('model_not_entitled')).toBe('sap-icon://locked');
    expect(icon('deployment_created')).toBe('sap-icon://cloud');
    expect((notificationPopulationService as any).isEventActionable('model_not_entitled')).toBe(true);
    expect((notificationPopulationService as any).isEventActionable('deployment_created')).toBe(false);
    expect((notificationPopulationService as any).getActionText('model_not_entitled')).toBe('Review entitlement');
    expect((notificationPopulationService as any).getActionText('deployment_created')).toBe(null);
  });
});
