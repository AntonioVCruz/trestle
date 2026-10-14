import Fastify from 'fastify';
import { err, money, ok, type CartService, type Category, type Channel, type ListProductsQuery, type PriceContext, type Product, type ProductFilter } from '@trestle/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeApi } from './index.js';

const channel: Channel = {
  id: 'chn_test',
  code: 'eu',
  name: 'EU store',
  defaultCurrency: 'EUR',
  currencies: ['EUR', 'USD'],
  defaultLocale: 'en',
  locales: ['en', 'de'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const product: Product = {
  id: 'prod_1',
  handle: 'tee',
  title: 'T-shirt',
  description: 'Soft cotton',
  status: 'published',
  options: [{ name: 'Size', values: ['S'] }],
  variants: [
    { id: 'var_1', productId: 'prod_1', sku: 'TEE-S', title: 'S', options: [{ name: 'Size', value: 'S' }], position: 0 },
  ],
  categoryIds: ['cat_1'],
  channelIds: ['chn_test', 'chn_other'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const category: Category = {
  id: 'cat_1',
  parentId: null,
  handle: 'apparel',
  name: 'Apparel',
  position: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const listQueries: ListProductsQuery[] = [];
const handleFilters: (ProductFilter | undefined)[] = [];
const priceRequests: { variantIds: readonly string[]; context: PriceContext }[] = [];

const app = Fastify();
const headers = { 'x-publishable-key': 'pk_valid' };

beforeAll(async () => {
  await app.register(storeApi, {
    prefix: '/store/v1',
    channels: { getByPublishableKey: async (key) => (key === 'pk_valid' ? channel : undefined) },
    catalog: {
      listProducts: async (query) => {
        listQueries.push(query);
        if (query.after === 'not-a-cursor') return err('invalid_cursor', 'Pass back the nextCursor of a previous page as after');
        return ok({ items: [product], nextCursor: null });
      },
      getProductByHandle: async (handle, filter) => {
        handleFilters.push(filter);
        return handle === product.handle ? product : undefined;
      },
      listCategories: async () => [category],
      getCategoryByHandle: async (handle) => (handle === category.handle ? category : undefined),
    },
    // Cart routes have their own tests in cart.test.ts.
    carts: {} as CartService,
    checkout: {} as never,
    orders: {} as never,
    pricing: {
      resolvePrices: async (variantIds, context) => {
        priceRequests.push({ variantIds, context });
        return context.currency === 'EUR'
          ? new Map([['var_1', { priceId: 'price_1', amount: money(1500, 'EUR'), priceListId: 'plist_1', original: money(2000, 'EUR') }]])
          : new Map();
      },
    },
  });
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => {
  listQueries.length = 0;
  handleFilters.length = 0;
  priceRequests.length = 0;
});

describe('Store API', () => {
  it('rejects requests without a valid publishable key', async () => {
    for (const url of ['/store/v1/channel', '/store/v1/products', '/store/v1/categories']) {
      for (const h of [{}, { 'x-publishable-key': 'pk_nope' }]) {
        const res = await app.inject({ url, headers: h });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: 'invalid_publishable_key' } });
      }
    }
  });

  it('answers 400, not 500, to an empty body sent as JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/v1/carts',
      headers: { ...headers, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('returns the storefront view of the selected channel', async () => {
    const res = await app.inject({ url: '/store/v1/channel', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code: 'eu',
      name: 'EU store',
      defaultCurrency: 'EUR',
      currencies: ['EUR', 'USD'],
      defaultLocale: 'en',
      locales: ['en', 'de'],
    });
  });

  it('lists only published products of the selected channel, without admin fields', async () => {
    const res = await app.inject({ url: '/store/v1/products?limit=5&after=prod_9', headers });
    expect(res.statusCode).toBe(200);
    expect(listQueries).toEqual([{ status: 'published', channelId: 'chn_test', limit: 5, after: 'prod_9' }]);
    expect(res.json()).toEqual({
      data: [
        {
          id: 'prod_1',
          handle: 'tee',
          title: 'T-shirt',
          description: 'Soft cotton',
          options: [{ name: 'Size', values: ['S'] }],
          variants: [
            {
              id: 'var_1',
              sku: 'TEE-S',
              title: 'S',
              options: [{ name: 'Size', value: 'S' }],
              price: { amount: 1500, currency: 'EUR', originalAmount: 2000 },
            },
          ],
          categoryIds: ['cat_1'],
        },
      ],
      nextCursor: null,
    });
  });

  it('resolves prices for the whole page in one call, in the channel’s default currency', async () => {
    await app.inject({ url: '/store/v1/products', headers });
    expect(priceRequests).toHaveLength(1);
    expect(priceRequests[0]!.variantIds).toEqual(['var_1']);
    expect(priceRequests[0]!.context).toMatchObject({ currency: 'EUR', channelId: 'chn_test', quantity: 1 });
  });

  it('prices in another of the channel’s currencies, and null when unpriced there', async () => {
    const res = await app.inject({ url: '/store/v1/products/tee?currency=USD', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0].price).toBeNull();
    expect(priceRequests[0]!.context.currency).toBe('USD');
  });

  it('rejects currencies the channel does not sell in', async () => {
    for (const url of ['/store/v1/products?currency=GBP', '/store/v1/products/tee?currency=GBP']) {
      const res = await app.inject({ url, headers });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('unsupported_currency');
    }
    expect(priceRequests).toEqual([]);
  });

  it('answers 400 to a cursor the catalog did not hand out', async () => {
    const res = await app.inject({ url: '/store/v1/products?after=not-a-cursor', headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
  });

  it('filters by category handle, and an unknown category matches nothing', async () => {
    await app.inject({ url: '/store/v1/products?category=apparel', headers });
    expect(listQueries).toEqual([{ status: 'published', channelId: 'chn_test', categoryId: 'cat_1', limit: 20 }]);

    const unknown = await app.inject({ url: '/store/v1/products?category=nope', headers });
    expect(unknown.json()).toEqual({ data: [], nextCursor: null });
    expect(listQueries).toHaveLength(1);
  });

  it('rejects out-of-range page sizes', async () => {
    for (const limit of [0, 101]) {
      const res = await app.inject({ url: `/store/v1/products?limit=${limit}`, headers });
      expect(res.statusCode).toBe(400);
    }
  });

  it('fetches a product by handle within the channel', async () => {
    const res = await app.inject({ url: '/store/v1/products/tee', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe('tee');
    expect(handleFilters).toEqual([{ status: 'published', channelId: 'chn_test' }]);

    const missing = await app.inject({ url: '/store/v1/products/nope', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('product_not_found');
  });

  it('lists categories', async () => {
    const res = await app.inject({ url: '/store/v1/categories', headers });
    expect(res.json()).toEqual({ data: [{ id: 'cat_1', parentId: null, handle: 'apparel', name: 'Apparel', position: 0 }] });
  });

  it('serves its own OpenAPI document without authentication', async () => {
    const res = await app.inject({ url: '/store/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.info.title).toBe('Trestle Store API');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/store/v1/carts',
      '/store/v1/carts/{id}',
      '/store/v1/carts/{id}/addresses',
      '/store/v1/carts/{id}/complete',
      '/store/v1/carts/{id}/lines',
      '/store/v1/carts/{id}/lines/{lineId}',
      '/store/v1/carts/{id}/payment-method',
      '/store/v1/carts/{id}/payment-methods',
      '/store/v1/carts/{id}/shipping-method',
      '/store/v1/carts/{id}/shipping-options',
      '/store/v1/categories',
      '/store/v1/channel',
      '/store/v1/orders/{id}',
      '/store/v1/products',
      '/store/v1/products/{handle}',
    ]);
    expect(spec.components.schemas).toHaveProperty('StoreChannel');
    expect(spec.components.schemas).toHaveProperty('StoreProduct');
    expect(spec.components.schemas).toHaveProperty('StorePrice');
  });
});
