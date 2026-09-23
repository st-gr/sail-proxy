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

  // tool_not_entitled (tool governance spec 2026-09-16 §7): the gateway emits it on every strip
  // and reject, so BOTH notification builders must title, icon and action it the same way.
  it('titles, icons and actionability for tool_not_entitled agree across both services', () => {
    const svc = SecurityEventService as any;
    const pop = notificationPopulationService as any;
    expect(svc.generateTitleForApiKeyEvent('tool_not_entitled', 'Build key'))
      .toBe('Tool request refused for API key Build key: not permitted by tool policy');
    expect(pop.generateTitleForApiKeyEvent('tool_not_entitled', 'Build key'))
      .toBe(svc.generateTitleForApiKeyEvent('tool_not_entitled', 'Build key'));
    expect(svc.generateTitleForAwsEvent('tool_not_entitled', 'Prod cred'))
      .toBe('Tool request refused for AWS credential Prod cred: not permitted by tool policy');
    expect(pop.generateTitleForAwsEvent('tool_not_entitled', 'Prod cred'))
      .toBe(svc.generateTitleForAwsEvent('tool_not_entitled', 'Prod cred'));
    expect(svc.getIconForEventType('tool_not_entitled')).toBe('sap-icon://locked');
    expect(pop.getIconForEventType('tool_not_entitled')).toBe('sap-icon://locked');
    expect(svc.isEventActionable('tool_not_entitled')).toBe(true);
    expect(pop.isEventActionable('tool_not_entitled')).toBe(true);
    expect(svc.getActionText('tool_not_entitled')).toBe('Review tool policy');
    expect(pop.getActionText('tool_not_entitled')).toBe('Review tool policy');
  });

  // placeholder_invented (2026-09-21): the gateway emits it when a response carries a
  // pseudonymization placeholder the model was never sent. It is informational - the placeholder
  // was withheld, and there is nothing for the key's owner to do - so it is titled and given an
  // icon in BOTH builders, and deliberately neither actionable nor given an action text.
  it('titles and icons for placeholder_invented agree across both services, and it asks for no action', () => {
    const svc = SecurityEventService as any;
    const pop = notificationPopulationService as any;
    expect(svc.generateTitleForApiKeyEvent('placeholder_invented', 'Build key'))
      .toBe('The model invented a masked placeholder in a response for API key Build key');
    expect(pop.generateTitleForApiKeyEvent('placeholder_invented', 'Build key'))
      .toBe(svc.generateTitleForApiKeyEvent('placeholder_invented', 'Build key'));
    expect(svc.generateTitleForAwsEvent('placeholder_invented', 'Prod cred'))
      .toBe('The model invented a masked placeholder in a response for AWS credential Prod cred');
    expect(pop.generateTitleForAwsEvent('placeholder_invented', 'Prod cred'))
      .toBe(svc.generateTitleForAwsEvent('placeholder_invented', 'Prod cred'));
    expect(svc.getIconForEventType('placeholder_invented')).toBe('sap-icon://hide');
    expect(pop.getIconForEventType('placeholder_invented')).toBe('sap-icon://hide');
    expect(svc.isEventActionable('placeholder_invented')).toBe(false);
    expect(pop.isEventActionable('placeholder_invented')).toBe(false);
    expect(svc.getActionText('placeholder_invented')).toBe(null);
    expect(pop.getActionText('placeholder_invented')).toBe(null);
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
