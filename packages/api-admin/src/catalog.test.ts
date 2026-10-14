import Fastify from 'fastify';
import {
  err,
  ok,
  type CatalogService,
  type Category,
  type Channel,
  type OrderService,
  type PaymentsService,
  type PricingService,
  type Product,
  type ShippingService,
} from '@trestle/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

const notStubbed = (name: string) => () => Promise.reject(new Error(`catalog.${name} is not stubbed`));

/** A catalog service whose every method fails; tests override what they exercise. */
const unusedCatalog: CatalogService = {
  createProduct: notStubbed('createProduct'),
  getProduct: notStubbed('getProduct'),
  getProducts: notStubbed('getProducts'),
  getProductByHandle: notStubbed('getProductByHandle'),
  listProducts: notStubbed('listProducts'),
  updateProduct: notStubbed('updateProduct'),
  addVariant: notStubbed('addVariant'),
  getVariants: notStubbed('getVariants'),
  setProductChannels: notStubbed('setProductChannels'),
  setProductCategories: notStubbed('setProductCategories'),
  createCategory: notStubbed('createCategory'),
  listCategories: notStubbed('listCategories'),
  getCategoryByHandle: notStubbed('getCategoryByHandle'),
};

const at = new Date('2026-01-01T00:00:00Z');

const product: Product = {
  id: 'prod_1',
  handle: 'tee',
  title: 'T-shirt',
  description: null,
  status: 'draft',
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: [{ id: 'var_1', productId: 'prod_1', sku: null, title: 'S', options: [{ name: 'Size', value: 'S' }], position: 0 }],
  categoryIds: [],
  channelIds: [],
  createdAt: at,
  updatedAt: at,
};

const category: Category = { id: 'cat_1', parentId: null, handle: 'apparel', name: 'Apparel', position: 0, createdAt: at };

const channel = { id: 'chn_eu' } as Channel;

const calls: { method: string; args: unknown[] }[] = [];
let catalog: CatalogService = unusedCatalog;

/** Delegates to whatever `catalog` currently is and records every call. */
const recordingCatalog = Object.fromEntries(
  Object.keys(unusedCatalog).map((method) => [
    method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return (catalog[method as keyof CatalogService] as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as CatalogService;

const app = Fastify();
await app.register(adminApi, {
  payments: {} as PaymentsService,
  shipping: {} as ShippingService,
  prefix: '/admin/v1',
  token: 't',
  catalog: recordingCatalog,
  pricing: {} as PricingService,
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
  catalog = unusedCatalog;
  calls.length = 0;
});

const headers = { authorization: 'Bearer t' };

describe('Admin API: catalog', () => {
  it('requires the bearer token', async () => {
    const res = await app.inject({ url: '/admin/v1/products' });
    expect(res.statusCode).toBe(401);
  });

  it('lists products with a default page size and serializes them', async () => {
    catalog = { ...unusedCatalog, listProducts: async () => ok({ items: [product], nextCursor: 'prod_1' }) };
    const res = await app.inject({ url: '/admin/v1/products?status=draft', headers });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.args[0]).toEqual({ status: 'draft', limit: 20 });
    expect(res.json()).toEqual({
      data: [
        {
          ...product,
          variants: [{ ...product.variants[0], sku: null }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: 'prod_1',
    });
  });

  it('answers 400 to a cursor the catalog did not hand out', async () => {
    catalog = { ...unusedCatalog, listProducts: async () => err('invalid_cursor', 'Pass back the nextCursor of a previous page as after') };
    const res = await app.inject({ url: '/admin/v1/products?after=x', headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
  });

  it('validates list queries', async () => {
    for (const query of ['limit=0', 'limit=101', 'status=deleted']) {
      const res = await app.inject({ url: `/admin/v1/products?${query}`, headers });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('creates products and maps domain errors to statuses', async () => {
    const payload = { handle: 'tee', title: 'T-shirt' };
    catalog = { ...unusedCatalog, createProduct: async () => ok(product) };
    expect((await app.inject({ method: 'POST', url: '/admin/v1/products', headers, payload })).statusCode).toBe(201);

    for (const [code, status] of [
      ['product_handle_taken', 409],
      ['sku_taken', 409],
      ['invalid_input', 400],
    ] as const) {
      catalog = { ...unusedCatalog, createProduct: async () => err(code, code) };
      const res = await app.inject({ method: 'POST', url: '/admin/v1/products', headers, payload });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: { code, message: code } });
    }
  });

  it('rejects malformed product bodies before reaching the service', async () => {
    for (const payload of [
      { handle: 'Not A Handle', title: 'x' },
      { handle: 'tee', title: '' },
      { handle: 'tee', title: 'x', options: [{ name: 'Size', values: [] }] },
      { handle: 'tee', title: 'x', variants: [{ options: [{ name: 'Size' }] }] },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/admin/v1/products', headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('returns 404 for unknown products', async () => {
    catalog = { ...unusedCatalog, getProduct: async () => undefined };
    const res = await app.inject({ url: '/admin/v1/products/prod_x', headers });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('product_not_found');
  });

  it('updates products, refusing empty patches and invalid transitions', async () => {
    const empty = await app.inject({ method: 'PATCH', url: '/admin/v1/products/prod_1', headers, payload: {} });
    expect(empty.statusCode).toBe(400);

    catalog = { ...unusedCatalog, updateProduct: async () => err('invalid_status_transition', 'no') };
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/products/prod_1',
      headers,
      payload: { status: 'published' },
    });
    expect(res.statusCode).toBe(409);
    expect(calls[0]!.args).toEqual(['prod_1', { status: 'published' }]);
  });

  it('adds variants', async () => {
    catalog = { ...unusedCatalog, addVariant: async () => ok(product.variants[0]!) };
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/products/prod_1/variants',
      headers,
      payload: { options: [{ name: 'Size', value: 'S' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'var_1', sku: null });

    catalog = { ...unusedCatalog, addVariant: async () => err('product_not_found', 'gone') };
    const missing = await app.inject({ method: 'POST', url: '/admin/v1/products/prod_x/variants', headers, payload: {} });
    expect(missing.statusCode).toBe(404);
  });

  it('checks channel ids through the channel service before listing a product', async () => {
    catalog = { ...unusedCatalog, setProductChannels: async () => ok({ ...product, channelIds: [channel.id] }) };
    const unknown = await app.inject({
      method: 'PUT',
      url: '/admin/v1/products/prod_1/channels',
      headers,
      payload: { channelIds: [channel.id, 'chn_nope'] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('channel_not_found');
    expect(calls).toEqual([]);

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/v1/products/prod_1/channels',
      headers,
      payload: { channelIds: [channel.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channelIds).toEqual([channel.id]);
  });

  it('assigns categories, rejecting unknown ones with 400', async () => {
    catalog = { ...unusedCatalog, setProductCategories: async () => err('category_not_found', 'nope') };
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/v1/products/prod_1/categories',
      headers,
      payload: { categoryIds: ['cat_x'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates and lists categories', async () => {
    catalog = { ...unusedCatalog, createCategory: async () => ok(category), listCategories: async () => [category] };
    const created = await app.inject({
      method: 'POST',
      url: '/admin/v1/categories',
      headers,
      payload: { handle: 'apparel', name: 'Apparel' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ ...category, createdAt: '2026-01-01T00:00:00.000Z' });

    const list = await app.inject({ url: '/admin/v1/categories', headers });
    expect(list.json().data).toHaveLength(1);

    catalog = { ...unusedCatalog, createCategory: async () => err('category_handle_taken', 'taken') };
    const taken = await app.inject({
      method: 'POST',
      url: '/admin/v1/categories',
      headers,
      payload: { handle: 'apparel', name: 'Apparel' },
    });
    expect(taken.statusCode).toBe(409);
  });
});
