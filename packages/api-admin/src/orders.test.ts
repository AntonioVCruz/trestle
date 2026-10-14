import Fastify from 'fastify';
import {
  err,
  money,
  ok,
  type CatalogService,
  type Order,
  type OrderService,
  type CaptureInput,
  type PaymentSession,
  type PaymentsService,
  type PricingService,
  type ShippingService,
} from '@trestle/core';
import { afterAll, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

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
  lines: [],
  subtotal: eur(8000),
  adjustments: [{ kind: 'shipping', label: 'Standard', amount: eur(495), target: { type: 'order' }, source: 'core.shipping' }],
  adjustmentsTotal: eur(495),
  total: eur(8495),
  payment: { providerId: 'test', sessionId: 'pays_1' },
  placedAt: new Date('2026-01-01T00:00:00Z'),
};

const session: PaymentSession = {
  id: 'pays_1',
  cartId: 'cart_1',
  channelId: 'chn_eu',
  providerId: 'test',
  providerName: 'Test payments',
  amount: eur(8495),
  status: 'authorized',
  captureMode: 'manual',
  capturedAmount: eur(0),
  authorizationExpiresAt: new Date('2026-01-08T00:00:00Z'),
  reference: 'test_pays_1',
  data: {},
  clientData: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
const captureCalls: CaptureInput[] = [];
const payments = {
  getSession: async (id: string) => (id === session.id ? session : undefined),
  listTransactions: async () => [
    {
      id: 'ptx_1',
      sessionId: 'pays_1',
      kind: 'authorize' as const,
      status: 'succeeded' as const,
      amount: eur(8495),
      reference: 'test_pays_1',
      reason: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ],
  captureSession: async (input: CaptureInput) => {
    captureCalls.push(input);
    if (input.amount?.amount === 1) return err('payment_declined', 'The capture was declined');
    if (input.amount?.amount === 2) return err('payment_capture_in_progress', 'busy');
    return ok(session);
  },
} satisfies Pick<PaymentsService, 'getSession' | 'listTransactions' | 'captureSession'>;

const queries: unknown[] = [];
const app = Fastify();
await app.register(adminApi, {
  prefix: '/admin/v1',
  token: 't',
  catalog: {} as CatalogService,
  pricing: {} as PricingService,
  shipping: {} as ShippingService,
  payments: payments as unknown as PaymentsService,
  orders: {
    getOrder: async (id) => (id === order.id ? order : undefined),
    listOrders: async (query) => {
      queries.push(query);
      if (query.after === 'x') return err('invalid_cursor', 'Pass back the nextCursor of a previous page as after');
      return ok({ items: [order], nextCursor: null });
    },
  } satisfies Pick<OrderService, 'getOrder' | 'listOrders'>,
  channels: {
    list: async () => [],
    getById: async () => undefined,
    getByPublishableKey: async () => undefined,
    create: async () => err('invalid_input', 'unused'),
    createPublishableKey: async () => err('channel_not_found', 'unused'),
  },
});
await app.ready();
afterAll(() => app.close());

const headers = { authorization: 'Bearer t' };

describe('Admin API: orders', () => {
  it('lists orders with the payment and adjustment sources', async () => {
    const res = await app.inject({ url: '/admin/v1/orders?channelId=chn_eu', headers });
    expect(res.json()).toMatchObject({
      data: [{ id: 'ord_1', number: 1001, payment: { providerId: 'test' }, adjustments: [{ source: 'core.shipping' }] }],
      nextCursor: null,
    });
    expect(queries[0]).toEqual({ channelId: 'chn_eu', limit: 20 });
  });

  it('answers 400 to a cursor the service did not hand out', async () => {
    const res = await app.inject({ url: '/admin/v1/orders?after=x', headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
  });

  it('returns one order, or 404', async () => {
    expect((await app.inject({ url: '/admin/v1/orders/ord_1', headers })).json()).toMatchObject({ cartId: 'cart_1' });
    expect((await app.inject({ url: '/admin/v1/orders/ord_x', headers })).statusCode).toBe(404);
  });

  it('shows the order’s payment and ledger', async () => {
    const res = await app.inject({ url: '/admin/v1/orders/ord_1/payment', headers });
    expect(res.json()).toEqual({
      sessionId: 'pays_1',
      providerId: 'test',
      providerName: 'Test payments',
      status: 'authorized',
      captureMode: 'manual',
      currency: 'EUR',
      amount: 8495,
      capturedAmount: 0,
      authorizationExpiresAt: '2026-01-08T00:00:00.000Z',
      transactions: [
        {
          id: 'ptx_1',
          kind: 'authorize',
          status: 'succeeded',
          amount: 8495,
          reference: 'test_pays_1',
          reason: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect((await app.inject({ url: '/admin/v1/orders/ord_x/payment', headers })).statusCode).toBe(404);
  });

  it('captures the payment, scoping the idempotency key to the payment', async () => {
    const capture = (payload: unknown, key: string | null = 'cap-1', id = 'ord_1') =>
      app.inject({
        method: 'POST',
        url: `/admin/v1/orders/${id}/payment/capture`,
        headers: { ...headers, ...(key && { 'idempotency-key': key }) },
        ...(payload !== undefined && { payload: payload as object }),
      });

    const full = await capture(undefined);
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ sessionId: 'pays_1' });
    expect(captureCalls.at(-1)).toEqual({ sessionId: 'pays_1', idempotencyKey: 'pays_1:capture:cap-1' });

    expect((await capture({ amount: 500 })).statusCode).toBe(200);
    expect(captureCalls.at(-1)).toMatchObject({ amount: eur(500) });

    expect((await capture({ amount: 1 })).statusCode).toBe(402);
    expect((await capture({ amount: 2 })).statusCode).toBe(409);
    expect((await capture({ amount: 0 })).statusCode).toBe(400);
    expect((await capture({}, null)).statusCode).toBe(400);
    expect((await capture({}, 'k', 'ord_x')).statusCode).toBe(404);
  });
});
