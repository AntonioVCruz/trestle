import Fastify from 'fastify';
import {
  err,
  money,
  ok,
  type CatalogService,
  type Channel,
  type Price,
  type PriceList,
  type OrderService,
  type PaymentsService,
  type PricingService,
  type ShippingService,
  type Variant,
} from '@trestle/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

const notStubbed = (name: string) => () => Promise.reject(new Error(`pricing.${name} is not stubbed`));

const unusedPricing: PricingService = {
  listVariantPrices: notStubbed('listVariantPrices'),
  setVariantPrices: notStubbed('setVariantPrices'),
  listPriceLists: notStubbed('listPriceLists'),
  getPriceList: notStubbed('getPriceList'),
  createPriceList: notStubbed('createPriceList'),
  updatePriceList: notStubbed('updatePriceList'),
  listPriceListPrices: notStubbed('listPriceListPrices'),
  setPriceListPrices: notStubbed('setPriceListPrices'),
  resolvePrices: notStubbed('resolvePrices'),
};

const at = new Date('2026-01-01T00:00:00Z');
const variant = { id: 'var_1' } as Variant;
const channel = { id: 'chn_eu', code: 'eu', currencies: ['EUR'] } as unknown as Channel;
const basePrice: Price = {
  id: 'price_1',
  variantId: 'var_1',
  priceListId: null,
  amount: money(1999, 'EUR'),
  channelId: null,
  minQuantity: 1,
};
const list: PriceList = {
  id: 'plist_1',
  name: 'Sale',
  type: 'sale',
  status: 'draft',
  priority: 0,
  startsAt: null,
  endsAt: new Date('2026-02-01T00:00:00Z'),
  createdAt: at,
  updatedAt: at,
};

let pricing: PricingService = unusedPricing;
const calls: { method: string; args: unknown[] }[] = [];
const recordingPricing = Object.fromEntries(
  Object.keys(unusedPricing).map((method) => [
    method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return (pricing[method as keyof PricingService] as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as PricingService;

const app = Fastify();
await app.register(adminApi, {
  payments: {} as PaymentsService,
  shipping: {} as ShippingService,
  prefix: '/admin/v1',
  token: 't',
  pricing: recordingPricing,
  catalog: { getVariants: async (ids) => (ids.includes(variant.id) ? [variant] : []) } as CatalogService,
  orders: {} as OrderService,
  channels: {
    list: async () => [],
    getById: async (id) => (id === channel.id ? channel : undefined),
    getByPublishableKey: async () => undefined,
    create: async () => err('invalid_input', 'unused'),
    createPublishableKey: async () => err('channel_not_found', 'unused'),
  },
});
await app.ready();
afterAll(() => app.close());
beforeEach(() => {
  pricing = unusedPricing;
  calls.length = 0;
});

const headers = { authorization: 'Bearer t' };

describe('Admin API: pricing', () => {
  it('lists a variant’s prices as integer minor units', async () => {
    pricing = { ...unusedPricing, listVariantPrices: async () => [basePrice] };
    const res = await app.inject({ url: '/admin/v1/variants/var_1/prices', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ id: 'price_1', variantId: 'var_1', priceListId: null, currency: 'EUR', amount: 1999, channelId: null, minQuantity: 1 }],
    });

    const missing = await app.inject({ url: '/admin/v1/variants/var_x/prices', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('variant_not_found');
  });

  it('sets base prices after checking channels and their currencies', async () => {
    pricing = { ...unusedPricing, setVariantPrices: async () => ok([basePrice]) };
    const put = (prices: unknown[]) =>
      app.inject({ method: 'PUT', url: '/admin/v1/variants/var_1/prices', headers, payload: { prices } });

    const unknownChannel = await put([{ currency: 'EUR', amount: 100, channelId: 'chn_x' }]);
    expect(unknownChannel.json().error.code).toBe('channel_not_found');
    const foreign = await put([{ currency: 'USD', amount: 100, channelId: 'chn_eu' }]);
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('currency_not_in_channel');
    expect(calls).toEqual([]);

    const res = await put([{ currency: 'EUR', amount: 1999 }, { currency: 'EUR', amount: 1899, channelId: 'chn_eu' }]);
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.args).toEqual([
      'var_1',
      [{ currency: 'EUR', amount: 1999 }, { currency: 'EUR', amount: 1899, channelId: 'chn_eu' }],
    ]);
  });

  it('rejects malformed prices before reaching the service', async () => {
    for (const price of [
      { currency: 'EUR', amount: 9.99 },
      { currency: 'EUR', amount: -1 },
      { currency: 'euro', amount: 1 },
      { currency: 'EUR', amount: 1, minQuantity: 0 },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/v1/variants/var_1/prices',
        headers,
        payload: { prices: [price] },
      });
      expect(res.statusCode, JSON.stringify(price)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('creates price lists, converting dates both ways', async () => {
    pricing = { ...unusedPricing, createPriceList: async () => ok(list) };
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/price-lists',
      headers,
      payload: { name: 'Sale', endsAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(calls[0]!.args[0]).toEqual({ name: 'Sale', startsAt: undefined, endsAt: new Date('2026-02-01T00:00:00Z') });
    expect(res.json()).toMatchObject({ id: 'plist_1', type: 'sale', startsAt: null, endsAt: '2026-02-01T00:00:00.000Z' });
  });

  it('updates price lists, passing null to clear a date', async () => {
    pricing = { ...unusedPricing, updatePriceList: async () => ok({ ...list, endsAt: null, status: 'active' }) };
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/price-lists/plist_1',
      headers,
      payload: { status: 'active', endsAt: null },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.args).toEqual(['plist_1', { status: 'active', endsAt: null }]);

    pricing = { ...unusedPricing, updatePriceList: async () => err('price_list_not_found', 'gone') };
    const missing = await app.inject({ method: 'PATCH', url: '/admin/v1/price-lists/x', headers, payload: { name: 'y' } });
    expect(missing.statusCode).toBe(404);
  });

  it('sets list prices only for known variants', async () => {
    pricing = { ...unusedPricing, setPriceListPrices: async () => ok([{ ...basePrice, priceListId: 'plist_1' }]) };
    const put = (prices: unknown[]) =>
      app.inject({ method: 'PUT', url: '/admin/v1/price-lists/plist_1/prices', headers, payload: { prices } });

    const unknown = await put([{ variantId: 'var_x', currency: 'EUR', amount: 1 }]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('variant_not_found');

    const res = await put([{ variantId: 'var_1', currency: 'EUR', amount: 1500 }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].priceListId).toBe('plist_1');

    pricing = { ...unusedPricing, setPriceListPrices: async () => err('price_list_not_found', 'gone') };
    expect((await put([])).statusCode).toBe(404);
  });

  it('returns 404 for unknown price lists', async () => {
    pricing = { ...unusedPricing, getPriceList: async () => undefined };
    expect((await app.inject({ url: '/admin/v1/price-lists/x', headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/admin/v1/price-lists/x/prices', headers })).statusCode).toBe(404);
  });
});
