import { describe, expect, it } from 'vitest';
import { checkProvider, PAYMENT_PROVIDER_CONTRACT_VERSION, type PaymentProvider } from './provider.js';
import { testPaymentProvider } from './test-provider.js';

const request = (data: Record<string, unknown> = {}) => ({
  sessionId: 'pays_1',
  reference: 'test_pays_1',
  amount: { amount: 1000, currency: 'EUR' },
  data,
  idempotencyKey: 'pays_1:authorize',
});

describe('checkProvider', () => {
  const provider = testPaymentProvider();

  it('accepts a provider written against the same major version', () => {
    expect(() => checkProvider(provider)).not.toThrow();
    expect(() => checkProvider({ ...provider, contractVersion: '1.9.0' })).not.toThrow();
  });

  it('refuses other major versions and malformed ids', () => {
    expect(() => checkProvider({ ...provider, contractVersion: '2.0.0' })).toThrow(/targets contract 2\.0\.0/);
    for (const id of ['Stripe', '1pay', 'a', 'pay pal']) {
      expect(() => checkProvider({ ...provider, id } as PaymentProvider)).toThrow(/Invalid payment provider id/);
    }
  });
});

describe('test payment provider', () => {
  const provider = testPaymentProvider();

  it('declares the current contract, deferred capture and test mode', () => {
    expect(provider).toMatchObject({
      id: 'test',
      contractVersion: PAYMENT_PROVIDER_CONTRACT_VERSION,
      supportsDeferredCapture: true,
      testMode: true,
    });
  });

  it('initiates with a reference and echoes the chosen outcome to the storefront', async () => {
    const result = await provider.initiate({ ...request({ outcome: 'decline' }), email: null });
    expect(result).toEqual({ reference: 'test_pays_1', clientData: { outcome: 'decline' } });
    expect((await provider.initiate({ ...request(), email: null })).clientData).toEqual({ outcome: 'authorize' });
  });

  it('authorizes, declines or asks for action depending on the data', async () => {
    const authorized = await provider.authorize(request());
    expect(authorized).toEqual({ status: 'succeeded', reference: 'test_pays_1', expiresAt: expect.any(String) });
    const lifetime = Date.parse((authorized as { expiresAt: string }).expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(lifetime).toBeLessThanOrEqual(7 * 24 * 3600_000);
    expect(await provider.authorize(request({ outcome: 'decline' }))).toMatchObject({ status: 'failed' });
    expect(await provider.authorize(request({ outcome: 'requires_action' }))).toMatchObject({
      status: 'requires_action',
      clientData: { action: 'confirm' },
    });
  });

  it('captures, cancels and refunds successfully', async () => {
    for (const op of [provider.capture, provider.cancel, provider.refund]) {
      expect(await op(request())).toEqual({ status: 'succeeded', reference: 'test_pays_1' });
    }
  });

  it('authorizes but declines the capture when asked to', async () => {
    expect(await provider.authorize(request({ outcome: 'capture_decline' }))).toMatchObject({ status: 'succeeded' });
    expect(await provider.capture(request({ outcome: 'capture_decline' }))).toMatchObject({ status: 'failed' });
  });
});
