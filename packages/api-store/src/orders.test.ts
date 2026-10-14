import Fastify from 'fastify';
import { err, money, ok, type Channel, type CheckoutService, type CompleteCartError, type Order, type Result } from '@trestle/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { storeApi } from './index.js';

const eur = (amount: number) => money(amount, 'EUR');
const address = {
  firstName: 'Ada',
  lastName: 'L',
  company: null,
  line1: '1 Main St',
  line2: null,
  city: 'Berlin',
  postalCode: '10115',
  region: null,
  country: 'DE',
  phone: null,
};
const order: Order = {
  id: 'ord_1',
  number: 1001,
  cartId: 'cart_1',
  channelId: 'chn_eu',
  status: 'placed',
  currency: 'EUR',
  email: 'ada@example.com',
  shippingAddress: address,
  billingAddress: address,
  shippingMethod: { optionId: 'ship_1', name: 'Standard', amount: eur(495) },
  lines: [
    {
      id: 'oline_1',
      variantId: 'var_1',
      productId: 'prod_1',
      productHandle: 'lamp',
      productTitle: 'Lamp',
      variantTitle: 'Default',
      sku: null,
      quantity: 2,
      unitPrice: eur(4000),
      originalUnitPrice: null,
      subtotal: eur(8000),
      total: eur(8000),
    },
  ],
  subtotal: eur(8000),
  adjustments: [{ kind: 'shipping', label: 'Standard', amount: eur(495), target: { type: 'order' }, source: 'core.shipping' }],
  adjustmentsTotal: eur(495),
  total: eur(8495),
  payment: { providerId: 'test', sessionId: 'pays_1' },
  placedAt: new Date('2026-01-01T00:00:00Z'),
};

let completion: Result<{ orderId: string; replayed: boolean }, CompleteCartError> = ok({ orderId: 'ord_1', replayed: false });
const completeCalls: [string, string][] = [];

const channels: Record<string, Channel> = {
  pk_eu: { id: 'chn_eu', defaultCurrency: 'EUR', currencies: ['EUR'] } as unknown as Channel,
  pk_us: { id: 'chn_us', defaultCurrency: 'USD', currencies: ['USD'] } as unknown as Channel,
};

const app = Fastify();
await app.register(storeApi, {
  prefix: '/store/v1',
  channels: { getByPublishableKey: async (key) => channels[key] },
  catalog: {} as never,
  pricing: {} as never,
  carts: { getCart: async (id: string) => (id === 'cart_1' ? { channelId: 'chn_eu' } : undefined) } as never,
  checkout: {
    completeCart: async (cartId, key) => {
      completeCalls.push([cartId, key]);
      return completion;
    },
  } satisfies Pick<CheckoutService, 'completeCart'>,
  orders: { getOrder: async (id) => (id === order.id ? order : undefined) },
});
await app.ready();
afterAll(() => app.close());
beforeEach(() => {
  completion = ok({ orderId: 'ord_1', replayed: false });
  completeCalls.length = 0;
});

const eu = { 'x-publishable-key': 'pk_eu' };
const complete = (headers: Record<string, string>, id = 'cart_1') =>
  app.inject({ method: 'POST', url: `/store/v1/carts/${id}/complete`, headers });

describe('Store API: placing an order', () => {
  it('returns 201 with the order on success, passing the idempotency key through', async () => {
    const res = await complete({ ...eu, 'idempotency-key': 'attempt-1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'ord_1',
      number: 1001,
      total: 8495,
      shippingMethod: { name: 'Standard', amount: 495 },
      lines: [{ productTitle: 'Lamp', quantity: 2, total: 8000 }],
      adjustments: [{ kind: 'shipping', amount: 495, lineId: null }],
      placedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(completeCalls).toEqual([['cart_1', 'attempt-1']]);
  });

  it('returns 200 when replaying an already placed cart', async () => {
    completion = ok({ orderId: 'ord_1', replayed: true });
    expect((await complete({ ...eu, 'idempotency-key': 'again' })).statusCode).toBe(200);
  });

  it('requires an idempotency key', async () => {
    expect((await complete(eu)).statusCode).toBe(400);
    expect(completeCalls).toEqual([]);
  });

  it('hides carts of other channels', async () => {
    const res = await complete({ 'x-publishable-key': 'pk_us', 'idempotency-key': 'k' });
    expect(res.statusCode).toBe(404);
    expect(completeCalls).toEqual([]);
  });

  it('maps failures: 402 declined, 409 not ready or in progress, 502 provider down', async () => {
    for (const [code, status] of [
      ['payment_declined', 402],
      ['completion_in_progress', 409],
      ['cart_changed', 409],
      ['payment_required', 409],
      ['payment_provider_failed', 502],
    ] as const) {
      completion = err(code, code);
      const res = await complete({ ...eu, 'idempotency-key': 'k' });
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error.code).toBe(code);
    }
  });

  it('passes the provider’s client data when the shopper must act', async () => {
    completion = err('payment_requires_action', 'act', { clientData: { action: 'confirm' } });
    const res = await complete({ ...eu, 'idempotency-key': 'k' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'payment_requires_action', message: 'act', details: { clientData: { action: 'confirm' } } },
    });
  });
});

describe('Store API: orders', () => {
  it('returns an order in its own channel only', async () => {
    expect((await app.inject({ url: '/store/v1/orders/ord_1', headers: eu })).json()).toMatchObject({ id: 'ord_1', number: 1001 });
    expect((await app.inject({ url: '/store/v1/orders/ord_1', headers: { 'x-publishable-key': 'pk_us' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/store/v1/orders/ord_x', headers: eu })).statusCode).toBe(404);
  });
});
