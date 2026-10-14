import { PAYMENT_PROVIDER_CONTRACT_VERSION, type PaymentOperationRequest, type PaymentProvider } from './provider.js';

/** How long the test provider's authorizations last, like a typical card authorization. */
const AUTHORIZATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A provider for development and automated tests. It moves no money. The storefront picks the
 * outcome by sending `{ "outcome": ... }` when it chooses the method:
 *   - `decline`          the authorization is declined
 *   - `requires_action`  the shopper must act before the authorization
 *   - `capture_decline`  the authorization succeeds; capturing it is declined
 * Anything else succeeds. Deployments register it only when `ENABLE_TEST_PAYMENT_PROVIDER` is
 * set (ADR 0019); never on a live channel.
 */
export function testPaymentProvider(): PaymentProvider {
  const authorize = async ({ data, sessionId }: PaymentOperationRequest) => {
    if (data.outcome === 'decline') return { status: 'failed' as const, reason: 'Declined by the test provider' };
    if (data.outcome === 'requires_action') {
      return { status: 'requires_action' as const, clientData: { action: 'confirm', sessionId } };
    }
    const expiresAt = new Date(Date.now() + AUTHORIZATION_LIFETIME_MS).toISOString();
    return { status: 'succeeded' as const, reference: `test_${sessionId}`, expiresAt };
  };
  const succeed = async ({ sessionId }: PaymentOperationRequest) => ({ status: 'succeeded' as const, reference: `test_${sessionId}` });

  return {
    id: 'test',
    name: 'Test payments',
    contractVersion: PAYMENT_PROVIDER_CONTRACT_VERSION,
    supportsDeferredCapture: true,
    testMode: true,
    async initiate({ sessionId, data }) {
      return { reference: `test_${sessionId}`, clientData: { outcome: typeof data.outcome === 'string' ? data.outcome : 'authorize' } };
    },
    authorize,
    async capture(request) {
      if (request.data.outcome === 'capture_decline') return { status: 'failed', reason: 'Capture declined by the test provider' };
      return succeed(request);
    },
    cancel: succeed,
    refund: succeed,
  };
}
