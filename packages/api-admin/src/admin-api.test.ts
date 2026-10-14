import Fastify from 'fastify';
import {
  err,
  ok,
  type CatalogService,
  type Channel,
  type ChannelService,
  type OrderService,
  type PaymentsService,
  type PricingService,
  type ShippingService,
} from '@trestle/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

const channels = new Map<string, Channel>();

const fakeChannels: ChannelService = {
  list: async () => [...channels.values()],
  getById: async (id) => channels.get(id),
  getByPublishableKey: async () => undefined,
  create: async (input) => {
    if ([...channels.values()].some((c) => c.code === input.code)) {
      return err('channel_code_taken', 'taken');
    }
    const channel: Channel = {
      id: `chn_${channels.size + 1}`,
      code: input.code,
      name: input.name,
      defaultCurrency: input.defaultCurrency,
      currencies: [input.defaultCurrency, ...(input.currencies ?? [])],
      defaultLocale: input.defaultLocale,
      locales: [input.defaultLocale, ...(input.locales ?? [])],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    channels.set(channel.id, channel);
    return ok(channel);
  },
  createPublishableKey: async (channelId) =>
    channels.has(channelId)
      ? ok({ key: 'pk_generated', channelId, createdAt: new Date('2026-01-01T00:00:00Z') })
      : err('channel_not_found', 'not found'),
};

/** Channel routes never touch the other services; their routes have their own tests. */
const unusedCatalog = {} as CatalogService;
const unusedPricing = {} as PricingService;
const unusedShipping = {} as ShippingService;
const unusedPayments = {} as PaymentsService;
const unusedOrders = {} as OrderService;

const auth = { authorization: 'Bearer s3cret' };

async function build(token: string | undefined) {
  const app = Fastify();
  await app.register(adminApi, {
    prefix: '/admin/v1',
    channels: fakeChannels,
    catalog: unusedCatalog,
    pricing: unusedPricing,
    shipping: unusedShipping,
    payments: unusedPayments,
    orders: unusedOrders,
    token,
  });
  await app.ready();
  return app;
}

const app = await build('s3cret');
afterAll(() => app.close());
beforeAll(() => channels.clear());

describe('Admin API', () => {
  it('rejects missing or wrong bearer tokens', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 's3cret' }]) {
      const res = await app.inject({ url: '/admin/v1/channels', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects everything when no token is configured', async () => {
    const closed = await build(undefined);
    const res = await closed.inject({ url: '/admin/v1/channels', headers: auth });
    expect(res.statusCode).toBe(401);
    await closed.close();
  });

  it('creates a channel, then refuses a duplicate code', async () => {
    const payload = { code: 'eu', name: 'EU store', defaultCurrency: 'EUR', defaultLocale: 'en' };
    const created = await app.inject({ method: 'POST', url: '/admin/v1/channels', headers: auth, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: 'eu', currencies: ['EUR'], createdAt: '2026-01-01T00:00:00.000Z' });

    const duplicate = await app.inject({ method: 'POST', url: '/admin/v1/channels', headers: auth, payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: 'channel_code_taken', message: 'taken' } });

    const list = await app.inject({ url: '/admin/v1/channels', headers: auth });
    expect(list.json().data).toHaveLength(1);
  });

  it('validates input with the shared error shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/channels',
      headers: auth,
      payload: { code: 'EU!', name: '', defaultCurrency: 'euro', defaultLocale: 'en' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('issues publishable keys only for existing channels', async () => {
    const missing = await app.inject({ method: 'POST', url: '/admin/v1/channels/chn_x/publishable-keys', headers: auth });
    expect(missing.statusCode).toBe(404);

    const [first] = [...channels.keys()];
    const issued = await app.inject({ method: 'POST', url: `/admin/v1/channels/${first}/publishable-keys`, headers: auth });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ key: 'pk_generated', channelId: first });
  });

  it('answers 400, not 500, to an empty body sent as JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/channels',
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('documents only admin routes in its OpenAPI document', async () => {
    const spec = (await app.inject({ url: '/admin/v1/openapi.json' })).json();
    expect(spec.info.title).toBe('Trestle Admin API');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/admin/v1/categories',
      '/admin/v1/channels',
      '/admin/v1/channels/{id}/publishable-keys',
      '/admin/v1/orders',
      '/admin/v1/orders/{id}',
      '/admin/v1/orders/{id}/payment',
      '/admin/v1/orders/{id}/payment/capture',
      '/admin/v1/payment-providers',
      '/admin/v1/payment-providers/{id}/channels',
      '/admin/v1/price-lists',
      '/admin/v1/price-lists/{id}',
      '/admin/v1/price-lists/{id}/prices',
      '/admin/v1/products',
      '/admin/v1/products/{id}',
      '/admin/v1/products/{id}/categories',
      '/admin/v1/products/{id}/channels',
      '/admin/v1/products/{id}/variants',
      '/admin/v1/shipping-options',
      '/admin/v1/shipping-options/{id}',
      '/admin/v1/variants/{id}/prices',
    ]);
  });
});
