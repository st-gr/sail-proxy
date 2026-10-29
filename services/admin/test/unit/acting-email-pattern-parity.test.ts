/**
 * The admin books a service-key row to `onBehalfOf` only when it passes the same e-mail shape
 * check the gateway applies to the acting-user header. The admin keeps its own copy of the
 * pattern; this test fails when the two drift. It imports the gateway's dependency-free module
 * only, like the 4b contract test imports fileSearch/usageEvent.ts.
 */
import { EMAIL_PATTERN } from '../../src/services/usageEventProcessor';
import { ACTING_EMAIL_PATTERN } from '../../../gateway/src/middlewares/actingEmailPattern';

describe('acting-user e-mail pattern parity with the gateway', () => {
  it('is the same regular expression on both sides', () => {
    expect(EMAIL_PATTERN.source).toBe(ACTING_EMAIL_PATTERN.source);
    expect(EMAIL_PATTERN.flags).toBe(ACTING_EMAIL_PATTERN.flags);
  });
});
