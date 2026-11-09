/**
 * The gateway emits quota_exceeded (RPM/spend/token limit refused) and quota_unenforced (Valkey
 * unreachable, the gateway failed open); the admin must accept both and render sensible
 * notification titles instead of "Security event for ...", and quota_unenforced must surface as
 * actionable so an operator notices the gateway is degraded.
 */
export {};
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

import SecurityEventService from '../../../src/services/securityEventService';
import { notificationPopulationService } from '../../../src/services/notificationPopulationService';

describe('quota_exceeded and quota_unenforced event types', () => {
  it('titles for API key events (SecurityEventService)', () => {
    const t = (SecurityEventService as any).generateTitleForApiKeyEvent;
    expect(t('quota_exceeded', 'Build key')).toBe('Quota exceeded for API key Build key');
    expect(t('quota_unenforced', 'Build key')).toBe('Quota enforcement degraded on the gateway');
  });

  it('titles for AWS credential events (SecurityEventService)', () => {
    const t = (SecurityEventService as any).generateTitleForAwsEvent;
    expect(t('quota_exceeded', 'Prod cred')).toBe('Quota exceeded for AWS credential Prod cred');
    expect(t('quota_unenforced', 'Prod cred')).toBe('Quota enforcement degraded on the gateway');
  });

  it('titles agree with NotificationPopulationService (API key events)', () => {
    const t = (notificationPopulationService as any).generateTitleForApiKeyEvent;
    expect(t('quota_exceeded', 'Build key')).toBe('Quota exceeded for API key Build key');
    expect(t('quota_unenforced', 'Build key')).toBe('Quota enforcement degraded on the gateway');
  });

  it('titles agree with NotificationPopulationService (AWS credential events)', () => {
    const t = (notificationPopulationService as any).generateTitleForAwsEvent;
    expect(t('quota_exceeded', 'Prod cred')).toBe('Quota exceeded for AWS credential Prod cred');
    expect(t('quota_unenforced', 'Prod cred')).toBe('Quota enforcement degraded on the gateway');
  });

  it('icons and actionability (SecurityEventService)', () => {
    const icon = (SecurityEventService as any).getIconForEventType;
    expect(icon('quota_exceeded')).toBe('sap-icon://measuring-point');
    expect(icon('quota_unenforced')).toBe('sap-icon://disconnected');
    expect((SecurityEventService as any).isEventActionable('quota_exceeded')).toBe(false);
    expect((SecurityEventService as any).isEventActionable('quota_unenforced')).toBe(true);
    expect((SecurityEventService as any).getActionText('quota_unenforced')).toBe('Check Valkey');
    expect((SecurityEventService as any).getActionText('quota_exceeded')).toBe(null);
  });

  it('icons and actionability agree with NotificationPopulationService', () => {
    const icon = (notificationPopulationService as any).getIconForEventType;
    expect(icon('quota_exceeded')).toBe('sap-icon://measuring-point');
    expect(icon('quota_unenforced')).toBe('sap-icon://disconnected');
    expect((notificationPopulationService as any).isEventActionable('quota_exceeded')).toBe(false);
    expect((notificationPopulationService as any).isEventActionable('quota_unenforced')).toBe(true);
    expect((notificationPopulationService as any).getActionText('quota_unenforced')).toBe('Check Valkey');
    expect((notificationPopulationService as any).getActionText('quota_exceeded')).toBe(null);
  });
});
