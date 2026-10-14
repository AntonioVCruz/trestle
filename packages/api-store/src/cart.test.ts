import Fastify from 'fastify';
import { err, money, ok, type Cart, type CartService, type Channel } from '@trestle/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { storeApi } from './index.js';

const channel = { id: 'chn_eu', defaultCurrency: 'EUR', currencies: ['EUR', 'USD'] } as unknown as Channel;
const otherChannel = { id: 'chn_us', defaultCurrency: 'USD', currencies: ['USD'] } as unknown as Channel;
const eur = (amount: number) => money(amount, 'EUR');

const cart: Cart = {
  id: 'cart_1',
  channelId: 'chn_eu',
  currency: 'EUR',
  lines: [
    {
      id: 'line_1',
      variantId: 'var_1',
      productId: 'prod_1',
      productHandle: 'tee',
      productTitle: 'T-shirt',
      variantTitle: 'S',
      sku: 'TEE-S',
      quantity: 2,
      unitPrice: eur(1500),
      originalUnitPrice: eur(2000),
      subtotal: eur(3000),
      total: eur(3000),
      available: true,
    },
    {
      id: 'line_2',
      variantId: 'var_2',
      productId: 'prod_2',
      productHandle: 'mug',
      productTitle: 'Mug',
      variantTitle: 'Default',
      sku: null,
      quantity: 1,
      unitPrice: eur(800),
      originalUnitPrice: null,
      subtotal: eur(800),
      total: eur(800),
      available: false,
    },
  ],
  subtotal: eur(3000),
  adjustments: [{ kind: 'promotion', label: '5 off', amount: eur(-500), target: { type: 'order' }, source: 'promo' }],
  adjustmentsTotal: eur(-500),
  total: eur(2500),
  checkoutState: 'cart',
  email: null,
  shippingAddress: null,
  billingAddress: null,
  shippingMethod: null,
  paymentMethod: null,
  orderId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const notStubbed = (name: string) => () => Promise.reject(new Error(`carts.${name} is not stubbed`));
const unusedCarts: CartService = {
  createCart: notStubbed('createCart'),
  getCart: notStubbed('getCart'),
  addLine: notStubbed('addLine'),
  updateLineQuantity: notStubbed('updateLineQuantity'),
  removeLine: notStubbed('removeLine'),
  setAddresses: notStubbed('setAddresses'),
  listShippingOptions: notStubbed('listShippingOptions'),
  selectShippingOption: notStubbed('selectShippingOption'),
  listPaymentMethods: notStubbed('listPaymentMethods'),
  selectPaymentMethod: notStubbed('selectPaymentMethod'),
  beginCompletion: notStubbed('beginCompletion'),
  abortCompletion: notStubbed('abortCompletion'),
  markPlaced: notStubbed('markPlaced'),
  staleCompletions: notStubbed('staleCompletions'),
};

let carts: CartService = unusedCarts;
const calls: { method: string; args: unknown[] }[] = [];
const recordingCarts = Object.fromEntries(
  Object.keys(unusedCarts).map((method) => [
    method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return (carts[method as keyof CartService] as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as CartService;

const app = Fastify();
await app.register(storeApi, {
  prefix: '/store/v1',
  channels: { getByPublishableKey: async (key) => ({ pk_eu: channel, pk_us: otherChannel })[key] },
  catalog: {} as never,
  pricing: {} as never,
  carts: recordingCarts,
  checkout: {} as never,
  orders: {} as never,
});
await app.ready();
afterAll(() => app.close());
beforeEach(() => {
  carts = unusedCarts;
  calls.length = 0;
});

const eu = { 'x-publishable-key': 'pk_eu' };
const us = { 'x-publishable-key': 'pk_us' };
const withCart = (overrides: Partial<CartService> = {}) => {
  carts = { ...unusedCarts, getCart: async (id) => (id === cart.id ? cart : undefined), ...overrides };
};

describe('Store API: carts', () => {
  it('creates a cart in the channel, defaulting to its currency', async () => {
    carts = { ...unusedCarts, createCart: async () => ok({ ...cart, lines: [] }) };
    const res = await app.inject({ method: 'POST', url: '/store/v1/carts', headers: eu });
    expect(res.statusCode).toBe(201);
    expect(calls[0]!.args[0]).toEqual({ channelId: 'chn_eu', currency: 'EUR' });

    await app.inject({ method: 'POST', url: '/store/v1/carts', headers: eu, payload: { currency: 'USD' } });
    expect(calls[1]!.args[0]).toEqual({ channelId: 'chn_eu', currency: 'USD' });
  });

  it('refuses a currency the channel does not sell in', async () => {
    const res = await app.inject({ method: 'POST', url: '/store/v1/carts', headers: us, payload: { currency: 'EUR' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_currency');
    expect(calls).toEqual([]);
  });

  it('returns the storefront view of a cart', async () => {
    withCart();
    const res = await app.inject({ url: '/store/v1/carts/cart_1', headers: eu });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'cart_1',
      currency: 'EUR',
      lines: [
        {
          id: 'line_1',
          variantId: 'var_1',
          productId: 'prod_1',
          productHandle: 'tee',
          productTitle: 'T-shirt',
          variantTitle: 'S',
          sku: 'TEE-S',
          quantity: 2,
          unitPrice: 1500,
          originalUnitPrice: 2000,
          subtotal: 3000,
          total: 3000,
          available: true,
        },
        expect.objectContaining({ id: 'line_2', sku: null, originalUnitPrice: null, available: false }),
      ],
      subtotal: 3000,
      adjustments: [{ kind: 'promotion', label: '5 off', amount: -500, lineId: null, included: false }],
      total: 2500,
      itemCount: 2,
      checkoutState: 'cart',
      email: null,
      shippingAddress: null,
      billingAddress: null,
      shippingMethod: null,
      paymentMethod: null,
      orderId: null,
    });
  });

  it('shows the order a placed cart became, so clients can poll for it', async () => {
    withCart({ getCart: async () => ({ ...cart, checkoutState: 'placed', orderId: 'ord_1' }) });
    const res = await app.inject({ url: '/store/v1/carts/cart_1', headers: eu });
    expect(res.json()).toMatchObject({ checkoutState: 'placed', orderId: 'ord_1' });
  });

  it('hides carts from other channels, and never changes them', async () => {
    withCart({ addLine: async () => ok(cart), removeLine: async () => ok(cart) });
    expect((await app.inject({ url: '/store/v1/carts/cart_1', headers: us })).statusCode).toBe(404);
    const add = await app.inject({
      method: 'POST',
      url: '/store/v1/carts/cart_1/lines',
      headers: us,
      payload: { variantId: 'var_1', quantity: 1 },
    });
    expect(add.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/store/v1/carts/cart_1/lines/line_1', headers: us });
    expect(del.statusCode).toBe(404);
    expect(calls.map((c) => c.method)).toEqual(['getCart', 'getCart', 'getCart']);
  });

  it('adds lines and maps domain errors to statuses', async () => {
    withCart({ addLine: async () => ok(cart) });
    const payload = { variantId: 'var_1', quantity: 2 };
    const res = await app.inject({ method: 'POST', url: '/store/v1/carts/cart_1/lines', headers: eu, payload });
    expect(res.statusCode).toBe(200);
    expect(calls.at(-1)!.args).toEqual(['cart_1', payload]);

    for (const [code, status] of [
      ['variant_not_available', 400],
      ['variant_not_priced', 400],
      ['cart_full', 400],
    ] as const) {
      withCart({ addLine: async () => err(code, code) });
      const failed = await app.inject({ method: 'POST', url: '/store/v1/carts/cart_1/lines', headers: eu, payload });
      expect(failed.statusCode).toBe(status);
      expect(failed.json().error.code).toBe(code);
    }
  });

  it('validates quantities before reaching the service', async () => {
    withCart();
    for (const quantity of [0, 1001, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/store/v1/carts/cart_1/lines/line_1',
        headers: eu,
        payload: { quantity },
      });
      expect(res.statusCode, String(quantity)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('updates and removes lines', async () => {
    withCart({ updateLineQuantity: async () => ok(cart), removeLine: async () => err('line_not_found', 'gone') });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/store/v1/carts/cart_1/lines/line_1',
      headers: eu,
      payload: { quantity: 4 },
    });
    expect(patch.statusCode).toBe(200);
    expect(calls.at(-1)!.args).toEqual(['cart_1', 'line_1', 4]);

    const del = await app.inject({ method: 'DELETE', url: '/store/v1/carts/cart_1/lines/line_9', headers: eu });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe('line_not_found');
  });

  it('returns 404 for unknown carts', async () => {
    withCart();
    expect((await app.inject({ url: '/store/v1/carts/cart_x', headers: eu })).statusCode).toBe(404);
  });
});

const address = { firstName: 'Ada', lastName: 'Lovelace', line1: '1 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' };
const storedAddress = { ...address, company: null, line2: null, region: null, phone: null };

describe('Store API: checkout steps', () => {
  it('sets addresses and returns the checkout data on the cart', async () => {
    const addressed: Cart = {
      ...cart,
      checkoutState: 'addressed',
      email: 'ada@example.com',
      shippingAddress: storedAddress,
      billingAddress: storedAddress,
    };
    withCart({ setAddresses: async () => ok(addressed) });
    const payload = { email: 'ada@example.com', shippingAddress: address };
    const res = await app.inject({ method: 'POST', url: '/store/v1/carts/cart_1/addresses', headers: eu, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ checkoutState: 'addressed', email: 'ada@example.com', shippingAddress: storedAddress });
    expect(calls.at(-1)!.args).toEqual(['cart_1', payload]);
  });

  it('validates addresses before reaching the service', async () => {
    withCart();
    calls.length = 0;
    for (const shippingAddress of [{ ...address, country: 'Germany' }, { ...address, city: '' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/store/v1/carts/cart_1/addresses',
        headers: eu,
        payload: { email: 'a@b.co', shippingAddress },
      });
      expect(res.statusCode, JSON.stringify(shippingAddress)).toBe(400);
    }
    expect(calls.filter((c) => c.method === 'setAddresses')).toEqual([]);
  });

  it('maps checkout errors to 409 when the cart is not at the right step', async () => {
    for (const code of ['cart_empty', 'cart_locked'] as const) {
      withCart({ setAddresses: async () => err(code, code) });
      const res = await app.inject({
        method: 'POST',
        url: '/store/v1/carts/cart_1/addresses',
        headers: eu,
        payload: { email: 'a@b.co', shippingAddress: address },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe(code);
    }
  });

  it('lists shipping options as amounts in the cart currency', async () => {
    withCart({ listShippingOptions: async () => ok([{ optionId: 'ship_1', name: 'Standard', amount: eur(495) }]) });
    const res = await app.inject({ url: '/store/v1/carts/cart_1/shipping-options', headers: eu });
    expect(res.json()).toEqual({ data: [{ optionId: 'ship_1', name: 'Standard', amount: 495 }] });

    withCart({ listShippingOptions: async () => err('address_required', 'address first') });
    const early = await app.inject({ url: '/store/v1/carts/cart_1/shipping-options', headers: eu });
    expect(early.statusCode).toBe(409);
  });

  it('selects a shipping method', async () => {
    const shipped: Cart = {
      ...cart,
      checkoutState: 'shipping_selected',
      shippingMethod: { optionId: 'ship_1', name: 'Standard', amount: eur(495) },
    };
    withCart({ selectShippingOption: async () => ok(shipped) });
    const res = await app.inject({
      method: 'POST',
      url: '/store/v1/carts/cart_1/shipping-method',
      headers: eu,
      payload: { optionId: 'ship_1' },
    });
    expect(res.json()).toMatchObject({ checkoutState: 'shipping_selected', shippingMethod: { optionId: 'ship_1', amount: 495 } });
    expect(calls.at(-1)!.args).toEqual(['cart_1', 'ship_1']);

    withCart({ selectShippingOption: async () => err('shipping_option_unavailable', 'no') });
    const bad = await app.inject({
      method: 'POST',
      url: '/store/v1/carts/cart_1/shipping-method',
      headers: eu,
      payload: { optionId: 'ship_x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('hides checkout of carts from other channels', async () => {
    withCart({ selectShippingOption: async () => ok(cart) });
    const res = await app.inject({
      method: 'POST',
      url: '/store/v1/carts/cart_1/shipping-method',
      headers: us,
      payload: { optionId: 'ship_1' },
    });
    expect(res.statusCode).toBe(404);
    expect(calls.map((c) => c.method)).toEqual(['getCart']);
  });
});


describe('Store API: payment step', () => {
  const payment = { providerId: 'test', name: 'Test payments', sessionId: 'pays_1', amount: eur(2500), clientData: { secret: 'cs_1' } };

  it('lists the channel’s payment methods', async () => {
    withCart({ listPaymentMethods: async () => ok([{ providerId: 'test', name: 'Test payments' }]) });
    const res = await app.inject({ url: '/store/v1/carts/cart_1/payment-methods', headers: eu });
    expect(res.json()).toEqual({ data: [{ providerId: 'test', name: 'Test payments' }] });
  });

  it('selects a method, passing provider data through and returning client data', async () => {
    withCart({ selectPaymentMethod: async () => ok({ ...cart, checkoutState: 'payment_selected', paymentMethod: payment }) });
    const payload = { providerId: 'test', data: { outcome: 'decline', nested: { a: 1 } } };
    const res = await app.inject({ method: 'POST', url: '/store/v1/carts/cart_1/payment-method', headers: eu, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      checkoutState: 'payment_selected',
      paymentMethod: { providerId: 'test', sessionId: 'pays_1', amount: 2500, clientData: { secret: 'cs_1' } },
    });
    expect(calls.at(-1)!.args).toEqual(['cart_1', payload]);
  });

  it('maps payment errors: step order and races are 409, provider failures 502', async () => {
    for (const [code, status] of [
      ['shipping_required', 409],
      ['cart_changed', 409],
      ['payment_method_unavailable', 400],
      ['payment_initiation_failed', 502],
    ] as const) {
      withCart({ selectPaymentMethod: async () => err(code, code) });
      const res = await app.inject({
        method: 'POST',
        url: '/store/v1/carts/cart_1/payment-method',
        headers: eu,
        payload: { providerId: 'test' },
      });
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error.code).toBe(code);
    }
  });
});
